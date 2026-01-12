// /api/state.js
// Returns JSON state for coach app UI: onboarding_complete, coach_plan, daily_logs, post_plan_stage, etc.

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    throw new Error("Missing Shopify env vars");
  }

  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${text}`);

  const json = JSON.parse(text);
  if (json.errors?.length) {
    throw new Error(json.errors.map(e => e.message).join(" | "));
  }
  return json.data;
}

function isNumericId(x){
  const s = String(x || "");
  const n = s.replace(/[^0-9]/g, "");
  return n ? n : null;
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || "";
  const ALLOWED = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com",
  ]);
  if (ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const q = req.query || {};
    const customerId = q.customerId || q.customer_id || q.shopifyCustomerId || null;
    const email = q.email || null;

    let customerGid = null;

    // 1) Try customerId
    const numeric = isNumericId(customerId);
    if (numeric) customerGid = `gid://shopify/Customer/${numeric}`;

    // 2) Try email lookup
    if (!customerGid && email) {
      const data = await shopifyGraphQL(
        `
        query FindCustomerByEmail($query: String!) {
          customers(first: 1, query: $query) { edges { node { id email } } }
        }
        `,
        { query: `email:${email}` }
      );
      customerGid = data?.customers?.edges?.[0]?.node?.id || null;
    }

    if (!customerGid) {
      return res.status(200).json({
        ok: true,
        customerGid: null,
        onboarding_complete: null,
        post_plan_stage: null,
        coach_plan: null,
        plan_json: null,
        daily_logs: []
      });
    }

    const data = await shopifyGraphQL(
      `
      query GetState($id: ID!) {
        customer(id: $id) {
          onboarding: metafield(namespace:"custom", key:"onboarding_complete") { value }
          postStage:  metafield(namespace:"custom", key:"post_plan_stage") { value }
          coachPlan:  metafield(namespace:"custom", key:"coach_plan") { value }
          planJson:   metafield(namespace:"custom", key:"plan_json") { value }
          dailyLogs:  metafield(namespace:"custom", key:"daily_logs") { value }
        }
      }
      `,
      { id: customerGid }
    );

    const c = data?.customer || {};
    const onboarding_complete = (c?.onboarding?.value === "true");
    const post_plan_stage = c?.postStage?.value || null;

    let coach_plan = null, plan_json = null, daily_logs = [];
    try { coach_plan = c?.coachPlan?.value ? JSON.parse(c.coachPlan.value) : null; } catch {}
    try { plan_json  = c?.planJson?.value  ? JSON.parse(c.planJson.value)  : null; } catch {}
    try { daily_logs = c?.dailyLogs?.value ? JSON.parse(c.dailyLogs.value) : []; } catch {}

    if (!Array.isArray(daily_logs)) daily_logs = [];

    return res.status(200).json({
      ok: true,
      customerGid,
      onboarding_complete,
      post_plan_stage,
      coach_plan,
      plan_json,
      daily_logs
    });
  } catch (e) {
    console.error("state error", e);
    return res.status(500).json({ ok: false, error: "Server error", message: String(e?.message || e) });
  }
}
