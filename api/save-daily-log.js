// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

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
    console.error("Network error when calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("JSON parse error from Shopify:", err);
    throw new Error("Invalid JSON response from Shopify Admin API");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error(JSON.stringify(json));
  }

  return json.data;
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS for POST
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const {
      email,
      date,
      weight,
      calories,
      steps,
      meals,
      mood,
      struggle,
      coach_focus,
      flag,
    } = req.body;

    if (!email || !date) {
      return res.status(400).json({ error: "Missing email or date" });
    }

    const mutation = `
      mutation createDailyLog($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metaobjectInput = {
      type: "daily_log",
      fields: [
        { key: "date", value: date },
        { key: "weight", value: weight != null ? String(weight) : "" },
        { key: "calories", value: calories != null ? String(calories) : "" },
        { key: "steps", value: steps != null ? String(steps) : "" },
        { key: "meals", value: meals || "" },
        { key: "mood", value: mood || "" },
        { key: "struggle", value: struggle || "" },
        { key: "coach_focus", value: coach_focus || "" },
        { key: "flag", value: flag ? "true" : "false" },
        { key: "customer_id", value: email }, // used for filtering
      ],
    };

    const data = await shopifyAdminFetch(mutation, {
      metaobject: metaobjectInput,
    });

    const result = data.metaobjectCreate;
    if (result.userErrors && result.userErrors.length > 0) {
      console.error("metaobjectCreate errors:", result.userErrors);
      return res.status(500).json({
        error: "Failed to create daily log",
        details: result.userErrors,
      });
    }

    return res.status(200).json({
      success: true,
      logId: result.metaobject.id,
    });
  } catch (err) {
    console.error("save-daily-log error:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err.message || String(err),
    });
  }
}
