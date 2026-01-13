// /api/nutrition.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "pjifitness.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

function setCors(req, res) {
  const allow = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    // Optional (only needed if you ever call /api/nutrition directly from this domain in browser):
    // "https://pjifitness-chat-api.vercel.app",
  ]);

  const origin = req.headers.origin;
  if (origin && allow.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function shopifyGraphQL(query, variables) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    throw new Error("Missing Shopify env vars: SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_API_ACCESS_TOKEN");
  }

  const r = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Shopify GraphQL HTTP ${r.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    // Allow browser testing:
    // /api/nutrition?q=banana&customerId=123
    if (req.method === "GET") {
      const q = String(req.query.q || req.query.text || "").trim();
      if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

      req.body = {
        text: q,
        customerId: req.query.customerId || null,
        email: req.query.email || null,
      };
      req.method = "POST";
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { text, customerId } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    // Debug flag (safe)
    const debug = String(req.query?.debug || "") === "1";

    // 1) Load foods from DB (Shopify metafields)
    const userFoods = await loadUserCustomFoods(customerId); // customer metafield
    const globalFoods = await loadGlobalFoods(); // shop metafield

    // 2) Parse
    const items = await llmParseMeal(text);

    // 3) Resolve nutrition
    const resolved = [];
    const needs_clarification = [];

    for (const item of items) {
      const r = await resolveItem(item, { userFoods, globalFoods, debug });
      resolved.push(r);

      if (r.confidence < 0.65) {
        needs_clarification.push({
          name: item.name,
          question:
            r.question ||
            `I’m not 100% sure on "${item.name}". What’s the serving (ex: 1 slice = 40 cal)?`,
        });
      }
    }

    // 4) Totals
    const totals = resolved.reduce(
      (acc, r) => {
        acc.calories += r.calories || 0;
        acc.protein += r.protein || 0;
        acc.carbs += r.carbs || 0;
        acc.fat += r.fat || 0;
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );

    return res.json({
      ok: true,
      items: resolved,
      totals,
      needs_clarification,
      debug_counts: {
        userFoodsCount: userFoods ? Object.keys(userFoods).length : 0,
        globalFoodsCount: globalFoods ? Object.keys(globalFoods).length : 0,
      },
    });
  } catch (e) {
    setCors(req, res);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------------------------
   Parser (improved)
----------------------------*/
async function llmParseMeal(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const normalized = raw
    .replace(/\n/g, ", ")
    .replace(/\+/g, ", ")
    .replace(/\s*&\s*/g, ", ")
    .replace(/\s+and\s+/gi, ", ");

  const chunks = normalized
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const UNIT_MAP = {
    ounce: "oz",
    ounces: "oz",
    oz: "oz",
    gram: "g",
    grams: "g",
    g: "g",
    kilogram: "kg",
    kilograms: "kg",
    kg: "kg",
    pound: "lb",
    pounds: "lb",
    lb: "lb",
    lbs: "lb",
    cup: "cup",
    cups: "cup",
    tbsp: "tbsp",
    tbsps: "tbsp",
    tablespoon: "tbsp",
    tablespoons: "tbsp",
    tsp: "tsp",
    tsps: "tsp",
    teaspoon: "tsp",
    teaspoons: "tsp",
    slice: "slice",
    slices: "slice",
    piece: "piece",
    pieces: "piece",
    serving: "serving",
    servings: "serving",
    scoop: "scoop",
    scoops: "scoop",
  };

  function cleanName(s) {
    let out = String(s || "")
      .replace(/'s\b/gi, "") // remove possessive
      .replace(/\b(with|w\/|in|on|of)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // remove stray leading single-letter tokens like "s bread"
    out = out
      .split(" ")
      .filter((tok) => tok && tok.length > 1)
      .join(" ")
      .trim();

    return out;
  }

  const items = chunks.map((p) => {
    const m = p.match(
      /^\s*(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|g|gram|grams|kg|kilogram|kilograms|lb|lbs|pound|pounds|cup|cups|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons|slice|slices|piece|pieces|serving|servings|scoop|scoops)?\s*(.*)$/i
    );

    if (m) {
      const qty = Number(m[1]);
      const unitRaw = (m[2] || "").toLowerCase();
      const unit = UNIT_MAP[unitRaw] || unitRaw || "";
      const name = cleanName(m[3] || p) || cleanName(p);

      return {
        name: name || cleanName(p),
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        unit,
      };
    }

    return { name: cleanName(p), qty: 1, unit: "" };
  });

  return items.filter((x) => x && x.name && String(x.name).trim() !== "");
}

/* ---------------------------
   Resolution
----------------------------*/
async function resolveItem(item, { userFoods, globalFoods, debug }) {
  const key = normalizeFoodKey(item.name);

  if (userFoods && userFoods[key]) return applyServing(userFoods[key], item, "user", 0.95);
  if (globalFoods && globalFoods[key]) return applyServing(globalFoods[key], item, "global", 0.9);

  const usda = await usdaLookup(item, debug);
  if (usda) return usda;

  return {
    ...item,
    source: "unknown",
    confidence: 0.2,
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    question: `For "${item.name}", what brand/serving size are you using?`,
  };
}

function normalizeFoodKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyServing(memoryEntry, item, source, confidence) {
  const mult = computeMultiplier(item, memoryEntry);
  return {
    ...item,
    source,
    confidence,
    calories: round(memoryEntry.calories * mult),
    protein: round(memoryEntry.protein * mult),
    carbs: round(memoryEntry.carbs * mult),
    fat: round(memoryEntry.fat * mult),
    matched_to: memoryEntry.label || memoryEntry.name || item.name,
  };
}

function computeMultiplier(item, entry) {
  const iq = Number(item.qty || 1);
  if (normalizeFoodKey(item.unit) === normalizeFoodKey(entry.serving_unit)) {
    const base = Number(entry.serving_qty || 1);
    return base ? iq / base : iq;
  }
  return iq;
}

function round(n) {
  if (n == null) return null;
  return Math.round((Number(n) || 0) * 10) / 10;
}

/* ---------------------------
   Shopify-backed loaders
----------------------------*/
async function loadGlobalFoods() {
  const q = `
    query GetGlobalFoods {
      shop {
        metafield(namespace:"custom", key:"global_foods") { value }
      }
    }
  `;

  const data = await shopifyGraphQL(q, {});
  const raw = data?.shop?.metafield?.value || "{}";

  try {
    const obj = JSON.parse(raw) || {};
    return normalizeFoodObjectKeys(obj);
  } catch {
    return {};
  }
}

async function loadUserCustomFoods(customerId) {
  if (!customerId) return {};

  const id = String(customerId).includes("gid://")
    ? String(customerId)
    : `gid://shopify/Customer/${customerId}`;

  const data = await shopifyGraphQL(
    `
    query GetCustomerFoods($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"custom", key:"user_foods") { value }
      }
    }
    `,
    { id }
  );

  const raw = data?.customer?.metafield?.value || "{}";

  try {
    const obj = JSON.parse(raw) || {};
    return normalizeFoodObjectKeys(obj);
  } catch {
    return {};
  }
}

function normalizeFoodObjectKeys(obj) {
  if (!obj) return {};

  if (Array.isArray(obj)) {
    const out = {};
    for (const it of obj) {
      const key = normalizeFoodKey(it?.name || it?.label || "");
      if (!key) continue;
      out[key] = it;
    }
    return out;
  }

  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = normalizeFoodKey(v?.name || v?.label || k);
      if (!key) continue;
      out[key] = v;
    }
    return out;
  }

  return {};
}

/* ---------------------------
   USDA Lookup (REAL CALORIES)
----------------------------*/
async function usdaLookup(item, debug = false) {
  const apiKey = process.env.USDA_API_KEY;

  if (!apiKey) {
    if (debug) {
      return {
        ...item,
        source: "usda",
        confidence: 0.0,
        calories: null,
        protein: null,
        carbs: null,
        fat: null,
        question: null,
        _debug: { hasUsdaKey: false, reason: "USDA_API_KEY missing at runtime" },
      };
    }
    return null;
  }

  const name = String(item?.name || "").trim();
  if (!name) return null;

  function buildUsdaQuery(it) {
    const n = String(it?.name || "").trim();

    const m = n.match(/^(\d{2})\s*%\s*(.*)$/i);
    if (m) {
      const pct = m[1];
      const rest = m[2] || "";
      if (/ground\s+beef/i.test(rest)) return `${pct}% lean ground beef`;
    }

    const unit = normalizeFoodKey(it?.unit || "");
    const base = n.toLowerCase();

    if (base === "rice" && unit === "cup") return "rice, white, cooked";
    if (base === "bread" && unit === "slice") return "bread, white";

    return n;
  }

  const query = buildUsdaQuery(item);

  try {
    const searchUrl =
      "https://api.nal.usda.gov/fdc/v1/foods/search?" +
      new URLSearchParams({
        api_key: apiKey,
        query,
        pageSize: "15",
      }).toString();

    const s = await fetch(searchUrl);
    const searchStatus = s.status;
    const sj = await s.json().catch(() => null);

    if (!s.ok) {
      if (debug) {
        return {
          ...item,
          source: "usda",
          confidence: 0.0,
          calories: null,
          protein: null,
          carbs: null,
          fat: null,
          question: null,
          _debug: { hasUsdaKey: true, searchStatus, searchError: sj || "(no json)" },
        };
      }
      return null;
    }

    const foods = Array.isArray(sj?.foods) ? sj.foods : [];
    if (!foods.length) return null;

    function scoreFood(f) {
      const desc = String(f?.description || "").toLowerCase();
      const brand = String(f?.brandName || "").toLowerCase();
      const text = `${desc} ${brand}`.trim();

      let score = 0;

      const dt = String(f?.dataType || "").toLowerCase();
      if (dt.includes("foundation")) score += 60;
      if (dt.includes("sr legacy")) score += 40;
      if (dt.includes("survey")) score += 15;
      if (dt.includes("branded")) score -= 15;

      if (text.includes("raw")) score += 15;
      if (text.includes("fresh")) score += 10;

      const qWords = String(query || "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      for (const w of qWords) {
        if (w.length >= 3 && text.includes(w)) score += 8;
      }

      const bad = [
        "chips","dried","dehydrated","powder","flour","puree","babyfood","frozen",
        "smoothie","muffin","cake","cookie","candy","cereal","ready-to-eat","oh!s","bars",
      ];
      for (const w of bad) {
        if (text.includes(w)) score -= 60;
      }

      const baseName = normalizeFoodKey(item?.name || "");
      if (baseName === "rice") {
        if (text.includes("dirty") || text.includes("fried") || text.includes("pilaf") || text.includes("seasoned")) score -= 80;
        if (text.includes("white") && text.includes("cooked")) score += 35;
        if (text.includes("brown") && text.includes("cooked")) score += 15;
      }

      if (baseName === "bread") {
        if (text.includes("cereal") || text.includes("cracker") || text.includes("graham")) score -= 90;
        if (text.includes("bread")) score += 20;
        if (text.includes("white") || text.includes("wheat") || text.includes("whole")) score += 10;
      }

      if (baseName.includes("ground beef") || baseName.includes("beef")) {
        if (text.includes("ground") && text.includes("beef")) score += 25;
        if (text.includes("lean")) score += 10;
      }

      score -= Math.min(desc.length, 200) / 25;
      return score;
    }

    let best = foods[0];
    let bestScore = scoreFood(best);

    for (const f of foods.slice(1, 15)) {
      const sc = scoreFood(f);
      if (sc > bestScore) {
        best = f;
        bestScore = sc;
      }
    }

    if (!best?.fdcId) return null;

    const detailUrl =
      `https://api.nal.usda.gov/fdc/v1/food/${best.fdcId}?` +
      new URLSearchParams({ api_key: apiKey }).toString();

    const d = await fetch(detailUrl);
    const detailStatus = d.status;
    const dj = await d.json().catch(() => null);

    if (!d.ok) {
      if (debug) {
        return {
          ...item,
          source: "usda",
          confidence: 0.0,
          calories: null,
          protein: null,
          carbs: null,
          fat: null,
          question: null,
          _debug: { hasUsdaKey: true, detailStatus, detailError: dj || "(no json)" },
        };
      }
      return null;
    }

    const nutrients = Array.isArray(dj?.foodNutrients) ? dj.foodNutrients : [];

    function getNutrientAmount(id) {
      for (const n of nutrients) {
        if (n?.nutrient?.id === id && n?.amount != null && isFinite(n.amount)) return Number(n.amount);
      }
      return null;
    }

    const kcalPer100g = getNutrientAmount(1008);
    const proteinPer100g = getNutrientAmount(1003);
    const carbsPer100g = getNutrientAmount(1005);
    const fatPer100g = getNutrientAmount(1004);

    if (kcalPer100g == null) return null;

    const qty = Number(item?.qty || 1);
    const unitKey = normalizeFoodKey(item?.unit || "");
    const baseName = normalizeFoodKey(item?.name || "");

    function toGrams(q, unit) {
      if (!isFinite(q) || q <= 0) return null;
      if (unit === "g") return q;
      if (unit === "kg") return q * 1000;
      if (unit === "oz") return q * 28.349523125;
      if (unit === "lb") return q * 453.59237;
      return null;
    }

    function estimateGrams(q, unit, nameKey) {
      if (!isFinite(q) || q <= 0) return null;
      if (unit === "cup" && nameKey === "rice") return q * 158;   // 1 cup cooked rice ~ 158g
      if (unit === "slice" && nameKey === "bread") return q * 25; // 1 slice bread ~ 25g
      return null;
    }

    const grams = toGrams(qty, unitKey) ?? estimateGrams(qty, unitKey, baseName);
    const mult = grams != null ? grams / 100 : qty;

    const out = {
      ...item,
      source: "usda",
      confidence: grams != null ? 0.8 : 0.7,
      calories: round((kcalPer100g || 0) * mult),
      protein: round((proteinPer100g || 0) * mult),
      carbs: round((carbsPer100g || 0) * mult),
      fat: round((fatPer100g || 0) * mult),
      matched_to: dj?.description || best?.description || item.name,
      ...(debug ? { _debug: { hasUsdaKey: true, searchStatus, detailStatus, bestScore, queryUsed: query } } : {}),
    };

    if (
      grams == null &&
      unitKey &&
      (unitKey === "cup" || unitKey === "tbsp" || unitKey === "tsp" || unitKey === "slice")
    ) {
      out.confidence = 0.55;
      out.question = `For "${item.name}", can you give grams or ounces (ex: 200g, 5oz) so I can be accurate?`;
    }

    if (unitKey === "slice" && baseName === "bread") out.confidence = 0.65;
    if (unitKey === "cup" && baseName === "rice") out.confidence = 0.7;

    return out;
  } catch (err) {
    if (debug) {
      return {
        ...item,
        source: "usda",
        confidence: 0.0,
        calories: null,
        protein: null,
        carbs: null,
        fat: null,
        question: null,
        _debug: { hasUsdaKey: true, reason: "Exception", message: String(err?.message || err) },
      };
    }
    return null;
  }
}
