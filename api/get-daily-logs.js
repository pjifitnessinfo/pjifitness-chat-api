// /api/get-daily-logs.js
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ✅ Server-local YYYY-MM-DD (fallback only)
function localYMD() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function requireEnv() {
  if (!SHOPIFY_STORE_DOMAIN) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  if (!SHOPIFY_ADMIN_API_ACCESS_TOKEN) throw new Error("Missing SHOPIFY_ADMIN_API_ACCESS_TOKEN");
}

async function shopifyGraphQL(query, variables = {}) {
  requireEnv();

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    // Return raw body for debugging
    const err = new Error("Shopify GraphQL invalid JSON");
    err.status = res.status;
    err.raw = text;
    throw err;
  }

  if (!res.ok || (json && json.errors)) {
    const err = new Error("Shopify GraphQL error");
    err.status = res.status;
    err.shopify_errors = json?.errors || null;
    err.raw = json;
    throw err;
  }

  return json.data;
}

/**
 * ✅ Identity verification via REST (fast + clear errors)
 * Requires Admin API scope: read_customers
 */
async function verifyCustomerIdentityREST(numericCustomerId, email) {
  requireEnv();

  const emailNorm = String(email || "").trim().toLowerCase();
  if (!emailNorm) return { ok: false, reason: "missing_email" };

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/${numericCustomerId}.json`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch(e) {}

  if (!res.ok) {
    return {
      ok: false,
      reason: "shopify_rest_error",
      status: res.status,
      details: json || text || "(empty)",
    };
  }

  const shopEmail = json?.customer?.email ? String(json.customer.email).trim().toLowerCase() : "";
  if (!shopEmail) return { ok: false, reason: "customer_not_found_or_no_email" };
  if (shopEmail !== emailNorm) return { ok: false, reason: "customer_email_mismatch", shopEmail };

  return { ok: true, shopEmail };
}

export default async function handler(req, res) {
  // ===== CORS =====
  const origin = req.headers.origin || "";
  const ALLOWED = [
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com",
  ];

  res.setHeader("Vary", "Origin");
  if (ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Content-Type, Authorization, X-Requested-With, Accept"
  );

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  // ===== END CORS =====

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    body = {};
  }

  const email = body.email || body.customerEmail || body.userEmail || "";
  const rawId =
    body.customerId ||
    body.shopifyCustomerId ||
    body.customer_id ||
    body.customerGid;

  if (!rawId) return res.status(400).json({ ok: false, error: "Missing customerId" });
  if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

  const numeric = String(rawId).replace(/[^0-9]/g, "");
  if (!numeric) return res.status(400).json({ ok: false, error: "Invalid customerId" });

  const customerGid = `gid://shopify/Customer/${numeric}`;
  const dateKey = isYMD(body.clientDate) ? body.clientDate : localYMD();

  // ✅ STOP THE BLEEDING: identity verification first
  const v = await verifyCustomerIdentityREST(numeric, email);
  if (!v.ok) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      reason: v.reason,
      status: v.status || null,
      details: v.details || null,
      dateKey,
    });
  }

  // ✅ Only after verify: fetch daily_logs (GraphQL is fine for metafield)
  const q = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"custom", key:"daily_logs") {
          value
        }
      }
    }
  `;

  try {
    const data = await shopifyGraphQL(q, { id: customerGid });

    let logs = [];
    const raw = data?.customer?.metafield?.value;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        logs = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        logs = [];
      }
    }

    return res.status(200).json({ ok: true, logs, dateKey });
  } catch (e) {
    // ✅ Return REAL Shopify errors so we can fix immediately
    return res.status(500).json({
      ok: false,
      error: "Failed to load daily_logs",
      dateKey,
      shopifyStatus: e?.status || null,
      shopifyErrors: e?.shopify_errors || null,
      details: e?.raw || String(e?.message || e),
    });
  }
}
