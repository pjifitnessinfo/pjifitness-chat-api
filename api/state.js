// /api/state.js
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

// ✅ allow your Shopify domain + local dev
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
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    return res.status(500).json({ ok: false, error: "missing_env", message: "Missing Shopify env vars" });
  }

  const customerId = String(req.query.customerId || "").trim();
  const numeric = customerId.replace(/[^0-9]/g, "");
  const customerGid = numeric ? `gid://shopify/Customer/${numeric}` : null;

  if (!customerGid) {
    return res.status(400).json({ ok: false, error: "missing_customerId", message: "Missing customerId" });
  }

  try {
    // ✅ NO email, NO PII — only metafields
    const q = `
      query($id: ID!) {
        customer(id: $id) {
          id
          onboarding_complete: metafield(namespace:"custom", key:"onboarding_complete") { value }
          coach_plan: metafield(namespace:"custom", key:"coach_plan") { value }
          daily_logs: metafield(namespace:"custom", key:"daily_logs") { value }
          post_plan_stage: metafield(namespace:"custom", key:"post_plan_stage") { value }
        }
      }
    `;
    const data = await shopifyGraphQL(q, { id: customerGid });

    const coachPlanRaw = data?.customer?.coach_plan?.value || null;
    const dailyLogsRaw = data?.customer?.daily_logs?.value || null;

    let coach_plan = null;
    let daily_logs = [];
    try { coach_plan = coachPlanRaw ? JSON.parse(coachPlanRaw) : null; } catch {}
    try { daily_logs = dailyLogsRaw ? JSON.parse(dailyLogsRaw) : []; } catch {}

    return res.status(200).json({
      ok: true,
      customerGid,
      onboarding_complete: (data?.customer?.onboarding_complete?.value === "true") || (data?.customer?.onboarding_complete?.value === true),
      post_plan_stage: data?.customer?.post_plan_stage?.value || null,
      coach_plan,
      daily_logs
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "state_failed",
      message: String(e?.message || e),
    });
  }
}
