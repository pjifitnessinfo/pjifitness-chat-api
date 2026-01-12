// /api/state.js
// PURPOSE:
// Read coach state (plan + daily logs + flags) for the Coach UI
// NO PII (no email) – avoids Shopify permission errors

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

// --------------------------------------------------
// Shopify GraphQL helper
// --------------------------------------------------
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  }

  if (json?.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// --------------------------------------------------
// API handler
// --------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "missing_env_vars"
    });
  }

  // Accept ONLY numeric customerId (safe, no PII)
  const raw = String(req.query.customerId || "").trim();
  const numericId = raw.replace(/[^0-9]/g, "");
  const customerGid = numericId
    ? `gid://shopify/Customer/${numericId}`
    : null;

  if (!customerGid) {
    return res.status(400).json({
      ok: false,
      error: "missing_customerId"
    });
  }

  try {
    // 🚫 NO email, NO PII
    const query = `
      query GetCoachState($id: ID!) {
        customer(id: $id) {
          onboarding_complete: metafield(
            namespace: "custom"
            key: "onboarding_complete"
          ) { value }

          post_plan_stage: metafield(
            namespace: "custom"
            key: "post_plan_stage"
          ) { value }

          coach_plan: metafield(
            namespace: "custom"
            key: "coach_plan"
          ) { value }

          daily_logs: metafield(
            namespace: "custom"
            key: "daily_logs"
          ) { value }
        }
      }
    `;

    const data = await shopifyGraphQL(query, { id: customerGid });
    const c = data?.customer || {};

    let coachPlan = null;
    let dailyLogs = [];

    try {
      coachPlan = c?.coach_plan?.value
        ? JSON.parse(c.coach_plan.value)
        : null;
    } catch {}

    try {
      dailyLogs = c?.daily_logs?.value
        ? JSON.parse(c.daily_logs.value)
        : [];
    } catch {}

    if (!Array.isArray(dailyLogs)) dailyLogs = [];

    return res.status(200).json({
      ok: true,
      customerGid,
      onboarding_complete: c?.onboarding_complete?.value === "true",
      post_plan_stage: c?.post_plan_stage?.value || null,
      coach_plan: coachPlan,
      daily_logs: dailyLogs
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "state_failed",
      message: String(err?.message || err)
    });
  }
}
