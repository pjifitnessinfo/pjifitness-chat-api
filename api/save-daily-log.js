// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Basic CORS helper
 */
function setCors(res) {
  // If you want to lock this down, replace * with your Shopify domain
  // e.g. "https://pjifitness.com"
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
 * Safely coerce something to a number, or null if invalid
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!isFinite(n)) return null;
  return n;
}

/**
 * Normalize any date-ish thing into YYYY-MM-DD
 */
function normalizeDateString(d) {
  if (!d) return null;

  try {
    if (typeof d === "string") {
      // If it's already like "2025-11-30" or "2025-11-30T..."
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
 * Merge a new daily log into an existing one for the same date.
 * - Meals are appended
 * - Scalars (weight, steps, mood, struggle, coach_focus, calories) are overwritten if present in new log
 * - total_calories is recomputed from all meals if possible
 */
function mergeDailyLogs(existing, incoming) {
  const merged = { ...(existing || {}) };

  // Date should already be normalized before calling this
  if (!merged.date && incoming.date) {
    merged.date = incoming.date;
  }

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

  const existingMeals = Array.isArray(existing?.meals) ? existing.meals : [];
  const incomingMeals = Array.isArray(incoming?.meals) ? incoming.meals : [];

  if (existingMeals.length || incomingMeals.length) {
    merged.meals = [...existingMeals, ...incomingMeals];
  }

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
    merged.total_calories = incoming.total_calories;
  }

  return merged;
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

  if (s.startsWith("gid://shopify/Customer/")) {
    return s;
  }

  const digits = s.replace(/\D/g, "");
  if (digits.length > 0) {
    return `gid://shopify/Customer/${digits}`;
  }

  console.warn("OwnerId could not be normalized to a Customer GID:", raw);
  return s;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    // Preflight request
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

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
    ownerId: bodyOwner,
    log,
    daily_log,
    dailyLog,
  } = body || {};

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
  try {
    const data = await shopifyAdminFetch(GET_DAILY_LOGS, { id: ownerId });
    const edges = data?.customer?.metafields?.edges || [];
    if (edges.length > 0 && edges[0].node) {
      const mf = edges[0].node;
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
  }

  if (Array.isArray(existingLogs) && existingLogs.length > 0) {
    existingLogs = existingLogs.map((entry) => {
      if (!entry) return entry;
      const copy = { ...entry };
      if (copy.date) {
        const nd = normalizeDateString(copy.date);
        if (nd) copy.date = nd;
      }
      return copy;
    });
  }

  let updatedLogs = Array.isArray(existingLogs) ? [...existingLogs] : [];

  const idx = updatedLogs.findIndex(
    (entry) => entry && entry.date === logDate
  );

  if (idx === -1) {
    updatedLogs.push(normalizedIncoming);
  } else {
    const merged = mergeDailyLogs(updatedLogs[idx], normalizedIncoming);
    updatedLogs[idx] = merged;
  }

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
