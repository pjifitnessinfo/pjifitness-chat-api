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
    console.error("Error parsing Shopify response JSON:", err);
    throw new Error("Invalid JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/**
 * Sanitize the log object so only the fields we expect get stored.
 * IMPORTANT: this includes meals + macros now.
 */
function sanitizeLog(raw) {
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
    "meals", // <-- NEW: keep meals
  ];

  const clean = {};
  for (const key of SAFE_FIELDS) {
    if (raw[key] !== undefined) {
      clean[key] = raw[key];
    }
  }

  // Ensure date exists + is ISO (YYYY-MM-DD)
  if (!clean.date) {
    clean.date = new Date().toISOString().slice(0, 10);
  }

  return clean;
}

/**
 * Default export – Vercel API Route
 */
export default async function handler(req, res) {
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

  const { customerId, log } = body || {};
  if (!customerId || !log) {
    return res.status(400).json({ error: "Missing customerId or log" });
  }

  const safeLog = sanitizeLog(log);
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
    const data = await shopifyAdminFetch(GET_LOGS_QUERY, { id: customerId });

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
    // Keep going; we'll just treat as empty logs
  }

  // 2) Append the new log (most recent at the end)
  const updatedLogs = [...existingLogs, safeLog];

  // Optional: cap history (e.g., last 365 logs)
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
      ownerId: customerId,
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
      return res.status(500).json({ error: "Failed to save daily_logs", details: errors });
    }
  } catch (err) {
    console.error("Error saving daily_logs metafield:", err);
    return res.status(500).json({ error: "Error saving daily_logs" });
  }

  return res.status(200).json({ ok: true, log: safeLog });
}
