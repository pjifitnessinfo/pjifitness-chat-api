// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

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
    console.error("Shopify GraphQL error:", json);
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/**
 * Safely coerce something to a number, or null if invalid
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!isFinite(n)) return null;
  return n;
}

/**
 * Merge a new daily log into an existing one for the same date.
 * - Meals are appended
 * - Scalars (weight, steps, mood, struggle, coach_focus, calories) are overwritten if present in new log
 * - total_calories is recomputed from all meals if possible
 */
function mergeDailyLogs(existing, incoming) {
  const merged = { ...(existing || {}) };

  // Always keep the same date if it already existed
  if (!merged.date && incoming.date) {
    merged.date = incoming.date;
  }

  // Overwrite scalar fields if present in incoming
  const scalarFields = [
    "weight",
    "calories",
    "steps",
    "mood",
    "struggle",
    "coach_focus",
  ];

  scalarFields.forEach((field) => {
    if (
      Object.prototype.hasOwnProperty.call(incoming, field) &&
      incoming[field] !== undefined &&
      incoming[field] !== null &&
      incoming[field] !== ""
    ) {
      merged[field] = incoming[field];
    }
  });

  // Merge meals: append new meals to existing meals
  const existingMeals = Array.isArray(existing?.meals) ? existing.meals : [];
  const incomingMeals = Array.isArray(incoming?.meals) ? incoming.meals : [];

  if (existingMeals.length || incomingMeals.length) {
    merged.meals = [...existingMeals, ...incomingMeals];
  }

  // Recompute total_calories from meals if we can
  if (Array.isArray(merged.meals) && merged.meals.length > 0) {
    const totalFromMeals = merged.meals.reduce((sum, meal) => {
      const mc = toNumberOrNull(meal?.calories);
      return mc !== null ? sum + mc : sum;
    }, 0);

    if (totalFromMeals > 0) {
      merged.total_calories = totalFromMeals;
    }
  } else if (
    Object.prototype.hasOwnProperty.call(incoming, "total_calories") &&
    incoming.total_calories !== undefined &&
    incoming.total_calories !== null &&
    incoming.total_calories !== ""
  ) {
    // Fall back to incoming total_calories if no meals
    merged.total_calories = incoming.total_calories;
  }

  return merged;
}

/**
 * Normalize incoming log (make sure date exists, etc.)
 */
function normalizeIncomingLog(rawLog) {
  const log = { ...(rawLog || {}) };

  // Ensure a date string YYYY-MM-DD exists
  if (!log.date) {
    const now = new Date();
    log.date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  return log;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Support multiple possible body shapes just in case:
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error("Invalid JSON body:", err);
    return res.status(400).json({ ok: false, error: "Invalid JSON body" });
  }

  const {
    customerId,
    customer_id,
    customerGid,
    customer_gid,
    log,
    daily_log,
    dailyLog,
  } = body || {};

  const ownerId =
    customerId || customer_id || customerGid || customer_gid;

  const incomingLog = log || daily_log || dailyLog;

  if (!ownerId) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing customerId / customerGid" });
  }
  if (!incomingLog) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing daily log payload" });
  }

  // Make sure this looks like a Shopify GID
  if (!String(ownerId).startsWith("gid://")) {
    console.warn("OwnerId is not a Shopify GID:", ownerId);
  }

  const normalizedIncoming = normalizeIncomingLog(incomingLog);
  const logDate = normalizedIncoming.date;

  // 1) Fetch existing daily_logs metafield for this customer
  const GET_DAILY_LOGS = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        id
        metafields(first: 1, namespace: "custom", keys: ["daily_logs"]) {
          edges {
            node {
              id
              key
              namespace
              type
              value
            }
          }
        }
      }
    }
  `;

  let existingLogs = [];
  let metafieldId = null;

  try {
    const data = await shopifyAdminFetch(GET_DAILY_LOGS, { id: ownerId });
    const edges = data?.customer?.metafields?.edges || [];
    if (edges.length > 0 && edges[0].node) {
      const mf = edges[0].node;
      metafieldId = mf.id || null;
      if (mf.value) {
        try {
          const parsed = JSON.parse(mf.value);
          if (Array.isArray(parsed)) {
            existingLogs = parsed;
          }
        } catch (err) {
          console.error("Error parsing existing daily_logs JSON:", err);
        }
      }
    }
  } catch (err) {
    console.error("Error fetching existing daily_logs metafield:", err);
    // We can still proceed with an empty array; just log it.
  }

  // 2) Merge this log into the array by date
  let updatedLogs = Array.isArray(existingLogs) ? [...existingLogs] : [];

  const idx = updatedLogs.findIndex(
    (entry) => entry && entry.date === logDate
  );

  if (idx === -1) {
    // No entry for this date yet → push new
    updatedLogs.push(normalizedIncoming);
  } else {
    // Merge with existing entry for same date
    const merged = mergeDailyLogs(updatedLogs[idx], normalizedIncoming);
    updatedLogs[idx] = merged;
  }

  // 3) Save back to Shopify via metafieldsSet
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

    const userErrors = result?.metafieldsSet?.userErrors || [];
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
