// /api/save-plan.js
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
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
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

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeObj(x) {
  if (!x) return null;
  if (typeof x === "object") return x;
  try { return JSON.parse(String(x)); } catch { return null; }
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    return res.status(500).json({ ok: false, error: "missing_env", message: "Missing Shopify env vars" });
  }

  let body = null;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: "bad_json", message: "Invalid JSON body" });
  }

  const customerId = String(body.customerId || "").trim();
  const numeric = customerId.replace(/[^0-9]/g, "");
  const customerGid = numeric ? `gid://shopify/Customer/${numeric}` : null;

  if (!customerGid) {
    return res.status(400).json({ ok: false, error: "missing_customerId", message: "Missing customerId" });
  }

  // Accept either coach_plan or plan_json in payload (we store both)
  const coach_plan = safeObj(body.coach_plan) || safeObj(body.plan_json) || {};
  const plan_json  = safeObj(body.plan_json) || safeObj(body.coach_plan) || {};

  // Light normalization (don’t overdo it)
  if (coach_plan.current_weight_lbs == null && plan_json.current_weight_lbs != null) coach_plan.current_weight_lbs = plan_json.current_weight_lbs;
  if (coach_plan.goal_weight_lbs == null && plan_json.goal_weight_lbs != null) coach_plan.goal_weight_lbs = plan_json.goal_weight_lbs;
  if (coach_plan.age == null && plan_json.age != null) coach_plan.age = plan_json.age;

  // Mark onboarding complete + stage done
  const onboarding_complete_value = "true";
  const post_plan_stage_value = "done";

  try {
    const mutation = `
      mutation SetPlan($id: ID!, $mf: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $mf) {
          metafields { id namespace key value }
          userErrors { field message }
        }
      }
    `;

    const metafields = [
      {
        ownerId: customerGid,
        namespace: "custom",
        key: "coach_plan",
        type: "json",
        value: JSON.stringify(coach_plan || {}),
      },
      {
        ownerId: customerGid,
        namespace: "custom",
        key: "plan_json",
        type: "json",
        value: JSON.stringify(plan_json || {}),
      },
      {
        ownerId: customerGid,
        namespace: "custom",
        key: "onboarding_complete",
        type: "single_line_text_field",
        value: onboarding_complete_value,
      },
      {
        ownerId: customerGid,
        namespace: "custom",
        key: "post_plan_stage",
        type: "single_line_text_field",
        value: post_plan_stage_value,
      },
    ];

    const data = await shopifyGraphQL(mutation, { id: customerGid, mf: metafields });

    const errs = data?.metafieldsSet?.userErrors || [];
    if (errs.length) {
      return res.status(400).json({ ok: false, error: "shopify_user_errors", userErrors: errs });
    }

    return res.status(200).json({
      ok: true,
      customerGid,
      onboarding_complete: true,
      post_plan_stage: "done",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "save_plan_failed",
      message: String(e?.message || e),
    });
  }
}
