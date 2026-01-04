// /api/nutrition.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });

    const { text, customerId, email } = req.body || {};
    if (!text) return res.status(400).json({ ok:false, error:"Missing text" });

    // 1) Load memories
    const userFoods = await loadUserCustomFoods(customerId);     // { "647 italian bread": { ... } }
    const globalFoods = await loadGlobalFoods();                 // your curated staples

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
          question: r.question || `I’m not 100% sure on "${item.name}". What’s the serving (ex: 1 slice = 40 cal)?`
        });
      }
    }

    // 4) Totals
    const totals = resolved.reduce((acc, r) => {
      acc.calories += (r.calories || 0);
      acc.protein += (r.protein || 0);
      acc.carbs += (r.carbs || 0);
      acc.fat += (r.fat || 0);
      return acc;
    }, { calories:0, protein:0, carbs:0, fat:0 });

    return res.json({
      ok: true,
      items: resolved,
      totals,
      needs_clarification
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}

/* ---------------------------
   Helpers (implement below)
----------------------------*/

async function llmParseMeal(text) {
  // Use your existing OpenAI setup (same as chat.js) to return JSON items
  // Must return: [{name, qty, unit}]
  return []; // TODO
}

async function resolveItem(item, { userFoods, globalFoods }) {
  const key = normalizeFoodKey(item.name);

  // (A) user memory
  if (userFoods && userFoods[key]) return applyServing(userFoods[key], item, "user", 0.95);

  // (B) global memory
  if (globalFoods && globalFoods[key]) return applyServing(globalFoods[key], item, "global", 0.90);

  // (C) USDA lookup fallback
  const usda = await usdaLookup(item);
  if (usda) return usda;

  return {
    ...item,
    source: "unknown",
    confidence: 0.2,
    calories: null, protein: null, carbs: null, fat: null,
    question: `For "${item.name}", what brand/serving size are you using?`
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
  // memoryEntry example:
  // { serving_unit:"slice", serving_qty:1, calories:40, protein:5, carbs:8, fat:1 }
  const mult = computeMultiplier(item, memoryEntry);
  return {
    ...item,
    source,
    confidence,
    calories: round(memoryEntry.calories * mult),
    protein: round(memoryEntry.protein * mult),
    carbs: round(memoryEntry.carbs * mult),
    fat: round(memoryEntry.fat * mult),
    matched_to: memoryEntry.label || memoryEntry.name || item.name
  };
}

function computeMultiplier(item, entry) {
  // simplest: if units match, scale by qty
  // else fallback to qty only
  const iq = Number(item.qty || 1);
  if (normalizeFoodKey(item.unit) === normalizeFoodKey(entry.serving_unit)) {
    const base = Number(entry.serving_qty || 1);
    return base ? (iq / base) : iq;
  }
  return iq;
}

function round(n) {
  if (n == null) return null;
  return Math.round((Number(n) || 0) * 10) / 10;
}

// TODO: implement these with Shopify metafields + USDA API
async function loadUserCustomFoods(customerId) { return {}; }
async function loadGlobalFoods() { return {}; }
async function usdaLookup(item) { return null; }
