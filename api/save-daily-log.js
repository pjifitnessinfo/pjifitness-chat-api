// /api/save-daily-log.js (FINAL FIXED VERSION)
// Appends normalized logs to customer.metafields.custom.daily_logs (JSON array)

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/* ----------------------------------------------------------
   CORS
---------------------------------------------------------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ----------------------------------------------------------
   Shopify Admin GraphQL
---------------------------------------------------------- */
async function shopifyAdminFetch(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.errors) {
    console.error("save-daily-log: Shopify GraphQL error:", json);
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/* ----------------------------------------------------------
   DATE NORMALIZATION → YYYY-MM-DD
---------------------------------------------------------- */
function normalizeDateString(d) {
  try {
    const dt = new Date(d);
    if (isFinite(dt.getTime())) return dt.toISOString().slice(0, 10);
    return null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------
   BACKEND LOG PARSER — THIS FIXES ALL STEP/CALORIE ISSUES
---------------------------------------------------------- */
function extractNumbersFromLog(raw) {
  if (!raw || typeof raw !== "object") return raw;

  const mergedText = [
    raw.text,
    raw.message,
    raw.input,
    JSON.stringify(raw),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // --- Detect "9k steps" ---
  const kStepsMatch = mergedText.match(/(\d+)\s*k\s*steps?/);
  let steps = kStepsMatch ? parseInt(kStepsMatch[1], 10) * 1000 : null;

  // --- All numeric values ---
  const matches = mergedText.match(/\d+(\.\d+)?/g) || [];
  const nums = matches.map((n) => parseFloat(n));

  let weight = null;
  let calories = null;

  nums.forEach((n) => {
    if (!weight && n >= 70 && n <= 400) weight = n;
    if (!calories && n >= 500 && n <= 6000) calories = n;
    if (!steps && n >= 1000) steps = n;
  });

  return {
    ...raw,
    weight: weight ?? raw.weight ?? null,
    calories: calories ?? raw.calories ?? null,
    steps: steps ?? raw.steps ?? null,
    total_calories: calories ?? raw.total_calories ?? null,
  };
}

/* ----------------------------------------------------------
   NORMALIZE INCOMING LOG STRUCTURE
---------------------------------------------------------- */
function normalizeIncomingLog(rawLog) {
  const log = { ...(rawLog || {}) };

  // Date
  log.date =
    normalizeDateString(log.date) ||
    new Date().toISOString().slice(0, 10);

  return extractNumbersFromLog(log); // << THIS IS THE FIX
}

/* ----------------------------------------------------------
   OWNER ID NORMALIZATION
---------------------------------------------------------- */
function normalizeOwnerId(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  if (s.startsWith("gid://shopify/Customer/")) return s;

  const digits = s.replace(/\D/g, "");
  if (digits) return `gid://shopify/Customer/${digits}`;

  return s;
}

/* ----------------------------------------------------------
   HANDLER
---------------------------------------------------------- */
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Parse body
  let body = req.body;
  if (typeof req.body === "string") {
    try {
      body = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON body" });
    }
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

  const rawOwner = bodyOwner || customerId || customer_id || customerGid || customer_gid;
  const ownerId = normalizeOwnerId(rawOwner);
  const incoming = log || daily_log || dailyLog;

  if (!ownerId) {
    return res.status(400).json({ ok: false, error: "Missing customerId / ownerId" });
  }
  if (!incoming) {
    return res.status(400).json({ ok: false, error: "Missing daily log payload" });
  }

  const normalized = normalizeIncomingLog(incoming);

  /* ----------------------------------------------------------
     FETCH EXISTING LOGS
  ---------------------------------------------------------- */
  const GET = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        dailyLogs: metafield(namespace: "custom", key: "daily_logs") {
          value
        }
      }
    }
  `;

  let existing = [];
  try {
    const data = await shopifyAdminFetch(GET, { id: ownerId });
    if (data?.customer?.dailyLogs?.value) {
      existing = JSON.parse(data.customer.dailyLogs.value) || [];
    }
  } catch (err) {
    console.error("save-daily-log: fetch error:", err);
  }

  const updatedLogs = [...existing, normalized];

  /* ----------------------------------------------------------
     SAVE BACK TO SHOPIFY
  ---------------------------------------------------------- */
  const SET = `
    mutation SetDailyLogs($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const metafields = [
    {
      ownerId,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(updatedLogs),
    },
  ];

  try {
    const result = await shopifyAdminFetch(SET, { metafields });
    const errs = result?.metafieldsSet?.userErrors || [];
    if (errs.length > 0) {
      console.error("save-daily-log: userErrors:", errs);
      return res.status(500).json({ ok: false, error: "User errors", details: errs });
    }
  } catch (err) {
    console.error("save-daily-log: save error:", err);
    return res.status(500).json({ ok: false, error: "Unable to save daily log" });
  }

  return res.status(200).json({
    ok: true,
    saved: normalized,
    total: updatedLogs.length,
  });
}
