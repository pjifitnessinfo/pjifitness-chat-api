// /api/nutrition.js

function setCors(req, res) {
  // Allow Shopify storefront(s) + local dev
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

  // CORS essentials
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req, res) {
  // ✅ CORS must be set for EVERY response (including errors)
  setCors(req, res);

  // ✅ Preflight request support
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    // ✅ Allow quick browser testing:
    //   /api/nutrition?q=banana
    //   /api/nutrition?text=banana
    if (req.method === "GET") {
      const q = String(req.query.q || req.query.text || "").trim();
      if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

      // Map GET -> your existing POST body format
      req.body = {
        text: q,
        customerId: req.query.customerId || null,
        email: req.query.email || null,
      };

      // Continue as if POST so we reuse the same code path
      req.method = "POST";
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { text, customerId, email } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    // 1) Load memories
    const userFoods = await loadUserCustomFoods(customerId); // { "647 italian bread": { ... } }
    const globalFoods = await loadGlobalFoods(); // your curated staples

    // 2) Parse meal text -> structured items
    const items = await llmParseMeal(text);

    // 3) Resolve each item -> nutrition
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
    });
  } catch (e) {
    // Ensure CORS headers are present even on errors
    setCors(req, res);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------------------------
   Helpers (implement below)
----------------------------*/

/**
 * ✅ WORKING PARSER (no OpenAI required yet)
 * Converts free text into [{name, qty, unit}]
 *
 * Examples:
 * "banana" -> [{name:"banana", qty:1, unit:""}]
 * "5 oz ground beef, 1 cup rice" -> 2 items
 * "647 italian bread with 1 cup shredded mozzarella" -> splits into parts
 */
async function llmParseMeal(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  // Normalize common separators to commas
  const normalized = raw
    .replace(/\n/g, ", ")
    .replace(/\+/g, ", ")
    .replace(/\s*&\s*/g, ", ")
    .replace(/\s+and\s+/gi, ", ");

  // Split into chunks
  const chunks = normalized
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If user types one sentence without commas, keep it as one chunk
  const parts = chunks.length ? chunks : [raw];

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
    can: "can",
    cans: "can",
    package: "package",
    packages: "package",
  };

  function cleanName(s) {
    return String(s || "")
      .replace(/\b(with|w\/|in|on|of)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const items = parts.map((p) => {
    // Match: "5 oz ground beef" OR "1 cup rice" OR "2 slices bread"
    const m = p.match(
      /^\s*(\d+(?:\.\d+)?)\s*(oz|ounce|ounces|g|gram|grams|kg|kilogram|kilograms|lb|lbs|pound|pounds|cup|cups|tbsp|tbsps|tablespoon|tablespoons|tsp|tsps|teaspoon|teaspoons|slice|slices|piece|pieces|serving|servings|scoop|scoops|can|cans|package|packages)?\s*(.*)$/i
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

    // Fallback: no qty/unit detected
    return { name: cleanName(p), qty: 1, unit: "" };
  });

  // Filter out empty names
  return items.filter((x) => x && x.name && String(x.name).trim() !== "");
}

async function resolveItem(item, { userFoods, globalFoods }) {
  const key = normalizeFoodKey(item.name);

  // (A) user memory
  if (userFoods && userFoods[key]) return applyServing(userFoods[key], item, "user", 0.95);

  // (B) global memory
  if (globalFoods && globalFoods[key]) return applyServing(globalFoods[key], item, "global", 0.9);

  // (C) USDA lookup fallback
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

// TODO: implement these with Shopify metafields + USDA API
async function loadUserCustomFoods(customerId) {
  return {};
}
async function loadGlobalFoods() {
  return {};
}
async function usdaLookup(item) {
  return null;
}
