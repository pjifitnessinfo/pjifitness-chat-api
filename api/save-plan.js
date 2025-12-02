// /api/save-plan.js
// Saves the user's plan (calories, protein, fat, carbs) into a customer metafield
// and marks onboarding as completed.

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // e.g. "your-store.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

// Helper: call Shopify Admin GraphQL
async function shopifyGraphql(query, variables) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL request failed");
  }
  return json;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    // Support a few possible field names for the customer id
    const rawCustomerId =
      body.customerId ||
      body.shopifyCustomerId ||
      body.customer_id ||
      body.customer_id_raw;

    if (!rawCustomerId) {
      return res.status(400).json({ error: "Missing customerId" });
    }

    // If we ever get a full gid, strip it down; if it's just a number, that's fine too.
    const numericId = String(rawCustomerId).replace(
      "gid://shopify/Customer/",
      ""
    );
    const ownerId = `gid://shopify/Customer/${numericId}`;

    const calories = Number(body.calories) || 0;
    const protein = Number(body.protein) || 0;
    const fat = Number(body.fat) || 0;
    const carbs = Number(body.carbs) || 0;

    const plan = {
      calories,
      protein,
      fat,
      carbs,
    };

    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            namespace
            type
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      metafields: [
        {
          ownerId,
          namespace: "custom",
          key: "coach_plan",
          type: "json",
          value: JSON.stringify(plan),
        },
        {
          ownerId,
          namespace: "custom",
          key: "onboarding_status",
          type: "single_line_text_field",
          value: "completed",
        },
      ],
    };

    const result = await shopifyGraphql(mutation, variables);

    const userErrors = result?.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) {
      console.error("metafieldsSet userErrors:", userErrors);
      return res.status(400).json({ error: "Shopify userErrors", userErrors });
    }

    const metafields = result?.data?.metafieldsSet?.metafields || [];
    return res.status(200).json({ ok: true, metafields });
  } catch (err) {
    console.error("save-plan error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
