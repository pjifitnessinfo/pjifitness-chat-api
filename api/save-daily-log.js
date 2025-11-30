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
 * Merge two logs that share the same date into ONE daily log.
 * Goal:
 *  - meals: append
 *  - total_calories: sum (if available), otherwise sum of meal calories
 *  - weight, steps, mood, struggle, coach_focus: take from newest (incoming)
 */
function mergeLogsByDate(existing, incoming) {
  const merged = { ...(existing || {}) };

  // Always trust incoming date (both should match anyway)
  merged.date = incoming.date;

  // ---- Meals ----
  const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];
  const incomingMeals = Array.isArray(incoming.meals) ? incoming.meals : [];
  merged.meals = [...existingMeals, ...incomingMeals];

  // ---- Total calories ----
  const existingTotal = Number(existing.total_calories || existing.calories || 0);
  const incomingTotal = Number(incoming.total_calories || incoming.calories || 0);

  let totalFromMeals = 0;
  merged.meals.forEach((m) => {
    if (m && m.calories != null && !Number.isNaN(Number(m.calories))) {
      totalFromMeals += Number(m.calories);
    }
  });

  // Prefer explicit totals if they exist, otherwise sum meals
  const combinedExplicit = existingTotal + incomingTotal;
  if (combinedExplicit > 0) {
    merged.total_calories = combinedExplicit;
  } else {
    merged.total_calories = totalFromMeals > 0 ? totalFromMeals : null;
  }

  // For compatibility, keep a simple "calories" field mirroring total_calories
  merged.calories = merged.total_calories;

  // ---- Weight / steps / mood / struggle / coach_focus ----
  // Use incoming as "latest" for these fields
  const keysToOverride = [
    "weight",
    "steps",
    "mood",
    "struggle",
    "coach_focus",
  ];

  keysToOverride.forEach((key) => {
    if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== "") {
      merged[key] = incoming[key];
    }
  });

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
    email, // not used for saving, but OK if present
  } = body || {};

  // We accept multiple possible fields for the customer ID
  const rawOwnerId =
    bodyOwner || customerId || customer_id || customerGid || customer_gid;

  const ownerId = normalizeOwnerId(rawOwnerId);
  const incomingLog = log || daily_log || dailyLog;

  if (!ownerId) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing customerId / ownerId" });
  }
  if (!incomingLog) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing daily log payload" });
  }

  const normalizedIncoming = normalizeIncomingLog(incomingLog);
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

  if (!Array.isArray(existingLogs)) {
    existingLogs = [];
  }

  // ===============================
  // 2) Merge with existing log for this date (if any)
  // ===============================
  let updatedLogs = [...existingLogs];

  const indexForDate = updatedLogs.findIndex((entry) => {
    if (!entry) return false;
    const ed = entry.date || entry.dateString || null;
    const norm = normalizeDateString(ed);
    return norm === logDate;
  });

  if (indexForDate >= 0) {
    // Merge into existing entry for this date
    const merged = mergeLogsByDate(updatedLogs[indexForDate], normalizedIncoming);
    updatedLogs[indexForDate] = merged;
  } else {
    // No existing entry for this date → push as new
    updatedLogs.push(normalizedIncoming);
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
