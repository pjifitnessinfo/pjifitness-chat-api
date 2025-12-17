// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * ✅ Option B Core Fix Helpers
 * - clientDate: prefer user's local date sent from the browser
 * - fallback: server-local YYYY-MM-DD (NOT UTC)
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
 * Compute calories + macros from a meals array.
 * Supports both:
 *  - old logs:  calories, protein, carbs, fat
 *  - photo logs: calories, protein_g, carbs_g, fat_g
 */
function computeTotalsFromMeals(meals) {
  const totals = {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
  };

  if (!Array.isArray(meals)) return totals;

  for (const meal of meals) {
    const cals = Number(meal.calories || 0);

    const protein = Number(
      meal.protein != null
        ? meal.protein
        : meal.protein_g != null
        ? meal.protein_g
        : 0
    );

    const carbs = Number(
      meal.carbs != null
        ? meal.carbs
        : meal.carbs_g != null
        ? meal.carbs_g
        : 0
    );

    const fat = Number(
      meal.fat != null
        ? meal.fat
        : meal.fat_g != null
        ? meal.fat_g
        : 0
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
 * ✅ UPDATED: forces date to dateKey (clientDate or server-local fallback)
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

    // ✅ Keep totals if your UI uses them (safe to include)
    "total_protein",
    "total_carbs",
    "total_fat",

    // ✅ Optional fields you already appear to use in UI (safe to include)
    "coach_review",
    "notes",

    // meals structures
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
    if (raw[key] !== undefined) {
      clean[key] = raw[key];
    }
  }

  // ✅ Core fix: force final dateKey, never UTC
  clean.date = isYMD(dateKey) ? dateKey : localYMD();

  return clean;
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

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error("Error parsing request body:", err);
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const { customerId, log, clientDate } = body || {};
  if (!customerId || !log) {
    return res.status(400).json({ error: "Missing customerId or log" });
  }

  // ✅ Core Fix: choose the date key once, use everywhere
  const dateKey = isYMD(clientDate) ? clientDate : localYMD();

  // Shopify Admin GraphQL expects a GID, not a plain number
  const customerGid = `gid://shopify/Customer/${customerId}`;

  const safeLog = sanitizeLog(log, dateKey);
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
  let metafieldId = null;

  try {
    const data = await shopifyAdminFetch(GET_LOGS_QUERY, { id: customerGid });

    const mf = data?.customer?.metafield;
    if (mf && mf.value) {
      metafieldId = mf.id;
      try {
        const parsed = JSON.parse(mf.value);
        if (Array.isArray(parsed)) {
          existingLogs = parsed;
        }
      } catch (err) {
        console.error("Error parsing existing daily_logs JSON:", err);
      }
    }
  } catch (err) {
    console.error("Error fetching existing daily_logs:", err);
  }

  // 2) Merge or append the log by date
  const dateStr = safeLog.date; // ✅ will be dateKey
  let updatedLogs = [...existingLogs];

  let foundIndex = -1;
  for (let i = 0; i < updatedLogs.length; i++) {
    if (updatedLogs[i]?.date === dateStr) {
      foundIndex = i;
      break;
    }
  }

  let finalLogForResponse = safeLog;

  if (foundIndex >= 0) {
    const existing = updatedLogs[foundIndex];

    const merged = {
      ...existing,
      ...safeLog,
      date: dateStr, // ✅ force again for safety
    };

    if (Array.isArray(existing.meals) || Array.isArray(safeLog.meals)) {
      merged.meals = [...(existing.meals || []), ...(safeLog.meals || [])];
    }

    if (Array.isArray(merged.meals)) {
      const totals = computeTotalsFromMeals(merged.meals);
      merged.calories = totals.calories;
      merged.total_calories = totals.calories;
      merged.total_protein = totals.protein;
      merged.total_carbs = totals.carbs;
      merged.total_fat = totals.fat;
    }

    updatedLogs[foundIndex] = merged;
    finalLogForResponse = merged;
  } else {
    const newLog = { ...safeLog, date: dateStr };

    if (Array.isArray(newLog.meals)) {
      const totals = computeTotalsFromMeals(newLog.meals);
      newLog.calories = totals.calories;
      newLog.total_calories = totals.calories;
      newLog.total_protein = totals.protein;
      newLog.total_carbs = totals.carbs;
      newLog.total_fat = totals.fat;
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

  const valueString = JSON.stringify(trimmedLogs);

  // 3) Write back to Shopify
  const SET_LOGS_MUTATION = `
    mutation SaveDailyLogs($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafieldsInput = [
    {
      ownerId: customerGid,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: valueString,
    },
  ];

  try {
    const result = await shopifyAdminFetch(SET_LOGS_MUTATION, {
      metafields: metafieldsInput,
    });

    const errors = result?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      console.error("Shopify metafieldsSet errors:", errors);
      return res
        .status(500)
        .json({ error: "Failed to save daily_logs", details: errors });
    }
  } catch (err) {
    console.error("Error saving daily_logs metafield:", err);
    return res.status(500).json({
      error: "Error saving daily_logs",
      details: err.shopifyResponse || err.message || String(err),
    });
  }

  // Return the merged / final log
  return res.status(200).json({ ok: true, log: finalLogForResponse });
}
