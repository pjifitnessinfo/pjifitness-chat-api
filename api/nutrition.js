// /api/nutrition.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "pjifitness.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

function setCors(req, res) {
  const allow = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
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

    // 1) Load foods from DB (Shopify metafields)
    const userFoods = await loadUserCustomFoods(customerId); // customer metafield
    const globalFoods = await loadGlobalFoods(); // shop metafield

    // 2) Parse
    const items = await llmParseMeal(text);

    // 3) Resolve nutrition
    const resolved = [];
    const needs_clarification = [];

    for (const item of items) {
      const r = await resolveItem(item, { userFoods, globalFoods });
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
   Parser (working now)
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
    return String(s || "")
      .replace(/\b(with|w\/|in|on|of)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const items = chunks.map((p) => {
    const m = p.match(
      /^\s*(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|g|gram|grams|kg|kilogram|kilograms|lb|lbs|pound|pounds|cup|cups|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons|slice|slices|piece|pieces|serving|servings|scoop|scoops)?\s*(.*)$/i
    );

    if (m) {
      const qty = Number(m[1]);
      const unitRaw = (m[2] || "").toLowerCase();
      const unit = UNIT_MAP[unitRaw] || (unitRaw || "");
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
async function resolveItem(item, { userFoods, globalFoods }) {
  const key = normalizeFoodKey(item.name);

  if (userFoods && userFoods[key]) return applyServing(userFoods[key], item, "user", 0.95);
  if (globalFoods && globalFoods[key]) return applyServing(globalFoods[key], item, "global", 0.9);

  // You said you have every food item, so USDA is optional:
  const usda = await usdaLookup(item);
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
   IMPORTANT: you must store JSON objects in these metafields:
   - Shop metafield:   custom.global_foods
   - Customer metafield: custom.user_foods
----------------------------*/
async function loadGlobalFoods() {
  const q = `
    query GetGlobalFoods {
      shop {
        metafield(namespace:"custom", key:"global_foods") {
          value
        }
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

  const q = `
    query GetCustomerFoods($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"custom", key:"user_foods") {
          value
        }
      }
    }
  `;

  const id = String(customerId).includes("gid://")
    ? String(customerId)
    : `gid://shopify/Customer/${customerId}`;

  const data = await shopifyGraphQL(q, { id });
  const raw = data?.customer?.metafield?.value || "{}";

  try {
    const obj = JSON.parse(raw) || {};
    return normalizeFoodObjectKeys(obj);
  } catch {
    return {};
  }
}

function normalizeFoodObjectKeys(obj) {
  // Accept either:
  // (A) already-keyed-by-normalized-name: { "banana": {...} }
  // (B) array of foods: [{name:"banana", ...}]
  // (C) object keyed by raw names: { "Banana (medium)": {...} }
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

// Optional: add later if you want fallback
async function usdaLookup(item) {
  return null;
}
