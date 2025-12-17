// /api/get-daily-logs.js
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function localYMD() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", json);
    throw new Error("Shopify GraphQL error");
  }
  return json.data;
}

export default async function handler(req, res) {
  // CORS
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
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {}

  const rawId = body.customerId || body.shopifyCustomerId;
  if (!rawId)
    return res.status(400).json({ error: "Missing customerId" });

  const numeric = String(rawId).replace(/[^0-9]/g, "");
  const customerGid = `gid://shopify/Customer/${numeric}`;

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
    try {
      logs = JSON.parse(data?.customer?.metafield?.value || "[]");
    } catch {}
    if (!Array.isArray(logs)) logs = [];

    const dateKey = isYMD(body.clientDate)
      ? body.clientDate
      : localYMD();

    return res.status(200).json({
      ok: true,
      logs,
      dateKey,
    });
  } catch (e) {
    console.error("get-daily-logs error:", e);
    return res.status(500).json({ error: "Failed to load daily_logs" });
  }
}
