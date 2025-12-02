// /api/save-plan.js
// Saves the user's coach plan into a Shopify customer metafield:
// namespace: custom, key: coach_plan, type: json

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "pjifitness.myshopify.com"
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN; // Private Admin API token

// Simple helper to parse JSON body
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    try {
      if (req.body && typeof req.body === "object") {
        return resolve(req.body);
      }
      let data = "";
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error("Invalid JSON body", e);
          resolve({});
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

export default async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_TOKEN) {
    res.status(500).json({ error: "Missing Shopify env vars" });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error("Error parsing body", e);
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const customerId = body.customerId;
  const plan = body.plan;

  if (!customerId || !plan) {
    res.status(400).json({ error: "Missing customerId or plan in body" });
    return;
  }

  // Shopify expects a GLOBAL ID, not the plain numeric ID
  // e.g. gid://shopify/Customer/1234567890
  const ownerId = `gid://shopify/Customer/${customerId}`;

  // The metafield value must be a STRING, even for json type
  const planJsonString = JSON.stringify(plan);

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
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
        value: planJsonString
      }
    ]
  };

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`;

  try {
    const shopifyRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    const json = await shopifyRes.json();

    if (!shopifyRes.ok || json.errors) {
      console.error("Shopify metafieldsSet error:", JSON.stringify(json, null, 2));
      res.status(500).json({ error: "Shopify API error", details: json });
      return;
    }

    const userErrors = json.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) {
      console.error("Shopify metafieldsSet userErrors:", userErrors);
      res.status(400).json({ error: "Shopify metafieldsSet userErrors", details: userErrors });
      return;
    }

    res.status(200).json({
      ok: true,
      message: "Coach plan saved to customer metafield.",
      metafields: json.data.metafieldsSet.metafields
    });
  } catch (e) {
    console.error("save-plan handler error:", e);
    res.status(500).json({ error: "Server error" });
  }
}
