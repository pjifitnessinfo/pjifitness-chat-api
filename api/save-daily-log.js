// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * ✅ Date helpers
 * - Prefer clientDate (browser local YYYY-MM-DD)
 * - Fallback: server-local YYYY-MM-DD (NOT UTC)
 */
function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function localYMD() {
  const d = new Date();
  const off = d.getTimezoneOffset(); // minutes
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * Helper: call Shopify Admin GraphQL
 */
async function shopifyAdminFetch(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_TOKEN) {
    throw new Error("Missing Shopify env vars");
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    console.error("Network error when calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("Error parsing Shopify response JSON:", err);
    throw new Error("Invalid JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    const err = new Error("Shopify GraphQL error");
    err.shopifyResponse = json;
    throw err;
  }

  return json.data;
}

/**
 * Build an absolute URL to our own API on Vercel.
 */
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Call /api/nutrition to estimate calories/macros for a meal text.
 * Never throws: returns null on failure.
 */
async function callNutrition(req, { text, customerId }) {
  try {
    const baseUrl = getBaseUrl(req);

    const r = await fetch(`${baseUrl}/api/nutrition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, customerId }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) return null;

    return j;
  } catch (e) {
    console.error("[save-daily-log] callNutrition failed:", e);
    return null;
  }
}

/**
 * Enrich meals array:
 * - If meal already has calories/macros => keep
 * - Else if meal has nutrition.totals => copy to top-level fields
 * - Else if meal has a text/description/name => call /api/nutrition and fill fields
 *
 * IMPORTANT:
 * We "promote" nutrition totals to meal.calories/protein/carbs/fat so computeTotalsFromMeals works unchanged.
 */
async function enrichMealsWithNutrition(req, meals, customerId) {
  if (!Array.isArray(meals) || meals.length === 0) return meals;

  const out = [];
  for (const m of meals) {
    const meal = m && typeof m === "object" ? { ...m } : null;
    if (!meal) continue;

    // Already has macros at top-level or legacy _g fields
    const hasTopMacros =
      meal.calories != null ||
      meal.protein != null ||
      meal.carbs != null ||
      meal.fat != null ||
      meal.protein_g != null ||
      meal.carbs_g != null ||
      meal.fat_g != null;

    if (hasTopMacros) {
      out.push(meal);
      continue;
    }

    // Already has stored nutrition totals -> promote
    const nt = meal?.nutrition?.totals;
    if (nt && typeof nt === "object") {
      meal.calories = nt.calories ?? meal.calories ?? null;
      meal.protein = nt.protein ?? meal.protein ?? null;
      meal.carbs = nt.carbs ?? meal.carbs ?? null;
      meal.fat = nt.fat ?? meal.fat ?? null;
      out.push(meal);
      continue;
    }

    // Find meal text
    const text =
      (typeof meal.text === "string" && meal.text.trim()) ||
      (typeof meal.description === "string" && meal.description.trim()) ||
      (typeof meal.name === "string" && meal.name.trim()) ||
      "";

    if (!text) {
      out.push(meal);
      continue;
    }

    // Call nutrition
    const nut = await callNutrition(req, { text, customerId });

    if (nut?.totals && typeof nut.totals === "object") {
      // Store nutrition details (helps UI + debugging)
      meal.text = meal.text || text;
      meal.nutrition = {
        items: Array.isArray(nut.items) ? nut.items : [],
        totals: nut.totals || null,
        needs_clarification: Array.isArray(nut.needs_clarification) ? nut.needs_clarification : [],
      };

      // Promote totals to top-level for compatibility with computeTotalsFromMeals
      meal.calories = nut.totals.calories ?? null;
      meal.protein = nut.totals.protein ?? null;
      meal.carbs = nut.totals.carbs ?? null;
      meal.fat = nut.totals.fat ?? null;
    }

    out.push(meal);
  }

  return out;
}

/**
 * Compute calories + macros from a meals array.
 * Supports both:
 *  - old logs:  calories, protein, carbs, fat
 *  - photo logs: calories, protein_g, carbs_g, fat_g
 */
function computeTotalsFromMeals(meals) {
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  if (!Array.isArray(meals)) return totals;

  for (const meal of meals) {
    const cals = Number(meal?.calories || 0);

    const protein = Number(
      meal?.protein != null
        ? meal.protein
        : meal?.protein_g != null
        ? meal.protein_g
        : 0
    );

    const carbs = Number(
      meal?.carbs != null ? meal.carbs : meal?.carbs_g != null ? meal.carbs_g : 0
    );

    const fat = Number(
      meal?.fat != null ? meal.fat : meal?.fat_g != null ? meal.fat_g : 0
    );

    totals.calories += cals;
    totals.protein += protein;
    totals.carbs += carbs;
    totals.fat += fat;
  }

  return totals;
}

/**
 * Sanitize the log object so only the fields we expect get stored.
 * ✅ Forces date to dateKey (clientDate or server-local fallback)
 */
function sanitizeLog(raw, dateKey) {
  if (!raw || typeof raw !== "object") return null;

  const SAFE_FIELDS = [
    "date",
    "weight",
    "calories",
    "total_calories",
    "steps",
    "mood",
    "struggle",
    "coach_focus",
    "calorie_target",
    "protein",
    "carbs",
    "fat",

    "total_protein",
    "total_carbs",
    "total_fat",

    "coach_review",
    "notes",
    "risk_color",
    "needs_human_review",

    "meals",
    "breakfast",
    "lunch",
    "dinner",
    "snacks",
    "breakfast_calories",
    "lunch_calories",
    "dinner_calories",
    "snacks_calories",
  ];

  const clean = {};
  for (const key of SAFE_FIELDS) {
    if (raw[key] !== undefined) clean[key] = raw[key];
  }

  // ✅ Core fix: force final dateKey, never UTC
  clean.date = isYMD(dateKey) ? dateKey : localYMD();

  // Ensure meals is either undefined or an array (allow empty array for deletes)
  if (clean.meals !== undefined && !Array.isArray(clean.meals)) {
    clean.meals = [];
  }

  return clean;
}

/**
 * Parse body safely (Vercel sometimes gives string body)
 */
function parseBody(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string") return JSON.parse(req.body);
  } catch (e) {}
  return {};
}

/**
 * Default export – Vercel API Route
 */
export default async function handler(req, res) {
  // ===== CORS FOR PJIFITNESS =====
  const origin = req.headers.origin || "";

  const ALLOWED_ORIGINS = [
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com",
  ];

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Content-Type, Authorization, X-Requested-With, Accept"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  // ===== END CORS =====

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = parseBody(req);

  // Support both payload styles:
  // - { customerId, clientDate, log: {...} }
  // - { customerId, clientDate, logJson: "..." }
  const customerIdRaw = body?.customerId ?? body?.shopifyCustomerId ?? body?.customer_id;
  const clientDate = body?.clientDate;

  let logObj = body?.log;

  if (!logObj && body?.logJson) {
    try {
      logObj = typeof body.logJson === "string" ? JSON.parse(body.logJson) : body.logJson;
    } catch (e) {
      console.error("Invalid logJson:", e);
      return res.status(400).json({ error: "Invalid logJson" });
    }
  }

  if (!customerIdRaw || !logObj) {
    return res.status(400).json({ error: "Missing customerId or log/logJson" });
  }

  const customerId = String(customerIdRaw).replace(/[^0-9]/g, "");
  if (!customerId) {
    return res.status(400).json({ error: "Invalid customerId" });
  }

  // ✅ Core Fix: choose the date key once, use everywhere
  const dateKey = isYMD(clientDate) ? clientDate : localYMD();

  // Shopify Admin GraphQL expects a GID
  const customerGid = `gid://shopify/Customer/${customerId}`;

  const safeLog = sanitizeLog(logObj, dateKey);
  if (!safeLog) {
    return res.status(400).json({ error: "Invalid log payload" });
  }

  // 1) Read existing daily_logs metafield
  const GET_LOGS_QUERY = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        id
        metafield(namespace: "custom", key: "daily_logs") {
          id
          value
        }
      }
    }
  `;

  let existingLogs = [];
  try {
    const data = await shopifyAdminFetch(GET_LOGS_QUERY, { id: customerGid });

    const mf = data?.customer?.metafield;
    if (mf?.value) {
      try {
        const parsed = JSON.parse(mf.value);
        if (Array.isArray(parsed)) existingLogs = parsed;
      } catch (err) {
        console.error("Error parsing existing daily_logs JSON:", err);
      }
    }
  } catch (err) {
    console.error("Error fetching existing daily_logs:", err);
  }

  // 2) Upsert by date
  const dateStr = safeLog.date; // ✅ forced to dateKey
  const updatedLogs = Array.isArray(existingLogs) ? [...existingLogs] : [];

  const foundIndex = updatedLogs.findIndex((l) => l && l.date === dateStr);

  let finalLogForResponse = safeLog;

  if (foundIndex >= 0) {
    const existing = updatedLogs[foundIndex] || {};

    // ✅ DEFAULT behavior: merge fields
    const merged = {
      ...existing,
      ...safeLog,
      date: dateStr,
    };

    // ✅ CRITICAL FIX: If request included "meals" (even empty array), FULL REPLACE.
    // This is what makes deletes persist.
    if (safeLog.meals !== undefined) {
      merged.meals = Array.isArray(safeLog.meals) ? safeLog.meals : [];
    } else {
      // If not provided, keep existing meals
      merged.meals = Array.isArray(existing.meals) ? existing.meals : [];
    }

    // ✅ NEW: Enrich meals with nutrition before totals
    if (Array.isArray(merged.meals)) {
      merged.meals = await enrichMealsWithNutrition(req, merged.meals, customerId);

      const totals = computeTotalsFromMeals(merged.meals);
      merged.calories = totals.calories || merged.calories || null;
      merged.total_calories = totals.calories || merged.total_calories || merged.calories || null;
      merged.total_protein = totals.protein || merged.total_protein || null;
      merged.total_carbs = totals.carbs || merged.total_carbs || null;
      merged.total_fat = totals.fat || merged.total_fat || null;
    }

    updatedLogs[foundIndex] = merged;
    finalLogForResponse = merged;
  } else {
    const newLog = { ...safeLog, date: dateStr };

    // ✅ NEW: Enrich meals with nutrition before totals
    if (Array.isArray(newLog.meals)) {
      newLog.meals = await enrichMealsWithNutrition(req, newLog.meals, customerId);

      const totals = computeTotalsFromMeals(newLog.meals);
      newLog.calories = totals.calories || newLog.calories || null;
      newLog.total_calories = totals.calories || newLog.total_calories || newLog.calories || null;
      newLog.total_protein = totals.protein || newLog.total_protein || null;
      newLog.total_carbs = totals.carbs || newLog.total_carbs || null;
      newLog.total_fat = totals.fat || newLog.total_fat || null;
    }

    updatedLogs.push(newLog);
    finalLogForResponse = newLog;
  }

  // Optional: cap history
  const MAX_LOGS = 365;
  const trimmedLogs =
    updatedLogs.length > MAX_LOGS
      ? updatedLogs.slice(updatedLogs.length - MAX_LOGS)
      : updatedLogs;

  // 3) Write back to Shopify
  const SET_LOGS_MUTATION = `
    mutation SaveDailyLogs($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace }
        userErrors { field message }
      }
    }
  `;

  const metafieldsInput = [
    {
      ownerId: customerGid,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(trimmedLogs),
    },
  ];

  try {
    const result = await shopifyAdminFetch(SET_LOGS_MUTATION, {
      metafields: metafieldsInput,
    });

    const errors = result?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      console.error("Shopify metafieldsSet errors:", errors);
      return res.status(500).json({ error: "Failed to save daily_logs", details: errors });
    }
  } catch (err) {
    console.error("Error saving daily_logs metafield:", err);
    return res.status(500).json({
      error: "Error saving daily_logs",
      details: err.shopifyResponse || err.message || String(err),
    });
  }

  return res.status(200).json({ ok: true, log: finalLogForResponse, dateKey });
}
