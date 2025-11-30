// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Basic CORS helper
 */
function setCors(res) {
  // TODO: tighten this to your real domain (e.g. "https://pjifitness.com")
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    console.error("Error parsing Shopify JSON:", err);
    throw new Error("Invalid JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/**
 * Normalize any date-ish thing into YYYY-MM-DD
 */
function normalizeDateString(d) {
  if (!d) return null;

  try {
    if (typeof d === "string") {
      if (d.length >= 10) {
        const sliced = d.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(sliced)) return sliced;
      }
    }

    const dt = new Date(d);
    if (!isFinite(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch (e) {
    return null;
  }
}

/**
 * Normalize incoming log (make sure date exists & is YYYY-MM-DD)
 */
function normalizeIncomingLog(rawLog) {
  const log = { ...(rawLog || {}) };

  let normalizedDate = null;
  if (log.date) {
    normalizedDate = normalizeDateString(log.date);
  }

  if (!normalizedDate) {
    const now = new Date();
    normalizedDate = now.toISOString().slice(0, 10);
  }

  log.date = normalizedDate;

  // Ensure meals is always an array
  if (!Array.isArray(log.meals)) {
    log.meals = [];
  }

  return log;
}

/**
 * Ensure ownerId is a proper Shopify Customer GID
 */
function normalizeOwnerId(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();

  // Already a full GID
  if (s.startsWith("gid://shopify/Customer/")) {
    return s;
  }

  // If it's numeric (e.g. "9603496542392"), wrap it
  const digits = s.replace(/\D/g, "");
  if (digits.length > 0) {
    return `gid://shopify/Customer/${digits}`;
  }

  console.warn("OwnerId could not be normalized to a Customer GID:", raw);
  return s;
}

/**
 * Helper: sum calories from meals
 */
function sumMealCalories(meals) {
  if (!Array.isArray(meals)) return 0;
  let total = 0;
  for (const m of meals) {
    if (!m) continue;
    const c = Number(m.calories);
    if (!Number.isNaN(c) && c > 0) {
      total += c;
    }
  }
  return total;
}

/**
 * Merge a new log into an existing log for the same date
 * - Appends meals
 * - Recomputes total_calories from all meals
 * - Uses "latest" values for weight, steps, mood, struggle, coach_focus
 */
function mergeLogsByDate(existing, incoming) {
  const merged = { ...(existing || {}) };

  merged.date = incoming.date; // same date

  // Always ensure meals arrays
  const existingMeals = Array.isArray(existing?.meals) ? existing.meals : [];
  const incomingMeals = Array.isArray(incoming?.meals) ? incoming.meals : [];

  merged.meals = [...existingMeals, ...incomingMeals];

  // Latest numeric fields win if provided
  merged.weight =
    incoming.weight !== null && incoming.weight !== undefined
      ? incoming.weight
      : existing.weight ?? null;

  merged.steps =
    incoming.steps !== null && incoming.steps !== undefined
      ? incoming.steps
      : existing.steps ?? null;

  // Keep both calories + total_calories for compatibility,
  // but recompute total_calories from ALL meals if we have any.
  const mealTotal = sumMealCalories(merged.meals);

  if (mealTotal > 0) {
    merged.total_calories = mealTotal;
    merged.calories = mealTotal;
  } else {
    const inTotal =
      incoming.total_calories ?? incoming.calories ?? null;
    const exTotal =
      existing.total_calories ?? existing.calories ?? null;
    merged.total_calories = inTotal ?? exTotal ?? null;
    merged.calories = merged.total_calories;
  }

  // Mood / struggle: latest non-null wins
  merged.mood =
    (incoming.mood !== undefined && incoming.mood !== null && incoming.mood !== "")
      ? incoming.mood
      : existing.mood ?? null;

  merged.struggle =
    (incoming.struggle !== undefined && incoming.struggle !== null && incoming.struggle !== "")
      ? incoming.struggle
      : existing.struggle ?? null;

  // Coach focus: latest non-empty wins
  merged.coach_focus =
    (incoming.coach_focus && String(incoming.coach_focus).trim().length > 0)
      ? incoming.coach_focus
      : (existing.coach_focus && String(existing.coach_focus).trim().length > 0)
        ? existing.coach_focus
        : "Stay consistent today.";

  return merged;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    // Preflight request
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res
      .status(405)
      .json({ ok: false, error: "Method not allowed" });
  }

  // Parse body
  let body;
  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};
  } catch (err) {
    console.error("Invalid JSON body:", err);
    return res
      .status(400)
      .json({ ok: false, error: "Invalid JSON body" });
  }

  const {
    customerId,
    customer_id,
    customerGid,
    customer_gid,
    ownerId: bodyOwner,
    log,
    daily_log,
    dailyLog,
    email // not used for saving, but OK if present
  } = body || {};

  // We accept multiple possible fields for the customer ID
  const rawOwnerId =
    bodyOwner || customerId || customer_id || customerGid || customer_gid;

  const ownerId = normalizeOwnerId(rawOwnerId);
  const incomingLogRaw = log || daily_log || dailyLog;

  if (!ownerId) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing customerId / ownerId" });
  }
  if (!incomingLogRaw) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing daily log payload" });
  }

  const normalizedIncoming = normalizeIncomingLog(incomingLogRaw);
  const logDate = normalizedIncoming.date;

  // ===============================
  // 1) Fetch existing daily_logs
  // ===============================
  const GET_DAILY_LOGS = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        id
        dailyLogs: metafield(namespace: "custom", key: "daily_logs") {
          id
          key
          namespace
          type
          value
        }
      }
    }
  `;

  let existingLogs = [];
  try {
    const data = await shopifyAdminFetch(GET_DAILY_LOGS, { id: ownerId });

    const mf = data?.customer?.dailyLogs;
    if (mf && mf.value) {
      try {
        const parsed = JSON.parse(mf.value);
        if (Array.isArray(parsed)) {
          existingLogs = parsed;
        } else if (parsed && typeof parsed === "object") {
          // Old format: single object → wrap in array
          existingLogs = [parsed];
        } else {
          console.warn(
            "daily_logs metafield value was not array/object, resetting to []"
          );
        }
      } catch (err) {
        console.error("Error parsing existing daily_logs JSON:", err);
      }
    }
  } catch (err) {
    console.error("Error fetching existing daily_logs metafield:", err);
    // If this fails, we’ll just treat it as no existing logs
  }

  // Ensure existing logs is an array of objects
  if (!Array.isArray(existingLogs)) {
    existingLogs = [];
  }

  // ===============================
  // 2) Merge this new log by DATE
  //    - If a log for this date exists: merge + append meals
  //    - Else: push as a new entry
  // ===============================
  let updatedLogs = [...existingLogs];

  const targetDate = logDate;
  let indexForDate = -1;

  for (let i = 0; i < updatedLogs.length; i++) {
    const d = normalizeDateString(updatedLogs[i]?.date);
    if (d && d === targetDate) {
      indexForDate = i;
      break;
    }
  }

  if (indexForDate >= 0) {
    // Merge with existing log for that date
    const existingForDate = updatedLogs[indexForDate] || {};
    const merged = mergeLogsByDate(existingForDate, normalizedIncoming);
    updatedLogs[indexForDate] = merged;
  } else {
    // No log for this date yet: push as new entry
    const safeIncoming = {
      ...normalizedIncoming,
      meals: Array.isArray(normalizedIncoming.meals)
        ? normalizedIncoming.meals
        : [],
    };

    // If meals exist but total_calories isn’t set, compute it
    const mealTotal = sumMealCalories(safeIncoming.meals);
    if (mealTotal > 0) {
      safeIncoming.total_calories = mealTotal;
      safeIncoming.calories = mealTotal;
    }

    if (
      !safeIncoming.coach_focus ||
      String(safeIncoming.coach_focus).trim().length === 0
    ) {
      safeIncoming.coach_focus = "Stay consistent today.";
    }

    updatedLogs.push(safeIncoming);
  }

  // ===============================
  // 3) Save back to Shopify
  // ===============================
  const METAFIELDS_SET = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
          type
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafieldsPayload = [
    {
      ownerId,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(updatedLogs),
    },
  ];

  try {
    const result = await shopifyAdminFetch(METAFIELDS_SET, {
      metafields: metafieldsPayload,
    });

    const userErrors =
      result?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("metafieldsSet userErrors:", userErrors);
      return res.status(500).json({
        ok: false,
        error: "Failed to save daily logs",
        details: userErrors,
      });
    }

    return res.status(200).json({
      ok: true,
      savedDate: logDate,
      logsCount: updatedLogs.length,
    });
  } catch (err) {
    console.error("Error saving daily_logs metafield:", err);
    return res.status(500).json({
      ok: false,
      error: "Error saving daily logs metafield",
    });
  }
}
