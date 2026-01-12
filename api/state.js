// /api/state.js
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

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

export default async function handler(req, res) {
  // allow GET
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    return res.status(500).json({ error: "Missing Shopify env vars" });
  }

  const customerId = String(req.query.customerId || "").trim();
  const numeric = customerId.replace(/[^0-9]/g, "");
  const customerGid = numeric ? `gid://shopify/Customer/${numeric}` : null;

  if (!customerGid) {
    return res.status(400).json({ error: "Missing customerId" });
  }

  try {
    const q = `
      query($id: ID!) {
        customer(id: $id) {
          id
          email
          onboarding_complete: metafield(namespace:"custom", key:"onboarding_complete") { value }
          coach_plan: metafield(namespace:"custom", key:"coach_plan") { value }
          daily_logs: metafield(namespace:"custom", key:"daily_logs") { value }
          post_plan_stage: metafield(namespace:"custom", key:"post_plan_stage") { value }
        }
      }
    `;
    const data = await shopifyGraphQL(q, { id: customerGid });

    return res.status(200).json({
      ok: true,
      customerGid,
      onboarding_complete: data?.customer?.onboarding_complete?.value || null,
      post_plan_stage: data?.customer?.post_plan_stage?.value || null,
      coach_plan: data?.customer?.coach_plan?.value ? JSON.parse(data.customer.coach_plan.value) : null,
      daily_logs: data?.customer?.daily_logs?.value ? JSON.parse(data.customer.daily_logs.value) : []
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "state_failed",
      message: String(e?.message || e)
    });
  }
}
