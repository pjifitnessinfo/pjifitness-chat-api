// /api/get-plan.js
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

// allow your Shopify domain + local dev
const ALLOWED_ORIGINS = new Set([
  "https://www.pjifitness.com",
  "https://pjifitness.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  if (json?.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function safeJsonParse(x) {
  if (!x) return null;
  if (typeof x === "object") return x;
  try { return JSON.parse(String(x)); } catch { return null; }
}

function toCustomerGid(input) {
  if (input == null) return null;
  const s = String(input).trim();

  if (!s || s === "null" || s === "undefined") return null;
  if (s.startsWith("gid://shopify/Customer/")) return s;

  const numeric = s.replace(/[^0-9]/g, "");
  if (!numeric) return null;
  return `gid://shopify/Customer/${numeric}`;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    return res.status(500).json({ ok: false, error: "missing_env", message: "Missing Shopify env vars" });
  }

  let customerGid = null;

  if (req.method === "GET") {
    customerGid = toCustomerGid(req.query?.customerId);
  } else if (req.method === "POST") {
    let body = null;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    } catch {
      return res.status(400).json({ ok: false, error: "bad_json", message: "Invalid JSON body" });
    }
    customerGid = toCustomerGid(body.customerId);
  } else {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!customerGid) {
    return res.status(400).json({ ok: false, error: "missing_customerId", message: "Missing customerId" });
  }

  try {
    const query = `
      query GetPlan($id: ID!) {
        customer(id: $id) {
          id
          coach_plan: metafield(namespace: "custom", key: "coach_plan") { value }
          plan_json: metafield(namespace: "custom", key: "plan_json") { value }
          chat_transcript: metafield(namespace: "custom", key: "chat_transcript") { value }
          onboarding_complete: metafield(namespace: "custom", key: "onboarding_complete") { value }
          post_plan_stage: metafield(namespace: "custom", key: "post_plan_stage") { value }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { id: customerGid });
    const c = data?.customer;

    const coach_plan = safeJsonParse(c?.coach_plan?.value) || null;
    const plan_json = safeJsonParse(c?.plan_json?.value) || null;
    const chat_transcript = safeJsonParse(c?.chat_transcript?.value) || [];

    const onboarding_complete =
      String(c?.onboarding_complete?.value || "").toLowerCase() === "true";

    const post_plan_stage = String(c?.post_plan_stage?.value || "").trim() || null;

    return res.status(200).json({
      ok: true,
      customerGid,
      onboarding_complete,
      post_plan_stage,
      coach_plan,
      plan_json,
      chat_transcript: Array.isArray(chat_transcript) ? chat_transcript : [],
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "get_plan_failed",
      message: String(e?.message || e),
    });
  }
}
