// /api/save-daily-log.js
// Minimal V1: only appends to customer.metafields.custom.daily_logs (JSON array)

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Basic CORS helper
 */
function setCors(res) {
  // You can tighten this later to your real domain
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
    console.error("save-daily-log: network error calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("save-daily-log: invalid JSON from Shopify:", err);
    throw new Error("Invalid JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error(
      "save-daily-log: Shopify GraphQL error:",
      JSON.stringify(json, null, 2)
    );
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

  console.warn("save-daily-log: ownerId could not be normalized:", raw);
  return s;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    console.error("save-daily-log: invalid JSON body:", err);
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

  // Accept multiple possible fields for customer ID
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
            "save-daily-log: daily_logs metafield value not array/object, resetting to []"
          );
        }
      } catch (err) {
        console.error(
          "save-daily-log: error parsing existing daily_logs JSON:",
          err
        );
      }
    }
  } catch (err) {
    console.error("save-daily-log: error fetching existing daily_logs:", err);
    // If this fails, treat as no existing logs
  }

  // ===============================
  // 2) Append this new log
  //    (each message = new entry)
  // ===============================
  const updatedLogs = Array.isArray(existingLogs) ? [...existingLogs] : [];
  updatedLogs.push(normalizedIncoming);

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
    const data = await shopifyAdminFetch(METAFIELDS_SET, {
      metafields: metafieldsPayload,
    });

    const userErrors = data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("save-daily-log: metafieldsSet userErrors:", userErrors);
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
    console.error("save-daily-log: error saving metafields:", err);
    return res.status(500).json({
      ok: false,
      error: "Error saving daily logs metafield",
      details: err.message || String(err),
    });
  }
}
