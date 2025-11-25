// /api/get-daily-logs.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Helper to run Shopify Admin GraphQL with full error output
 */
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
    console.error("JSON parsing error from Shopify:", err);
    throw new Error("Invalid JSON response from Shopify Admin API");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error(JSON.stringify(json));
  }

  return json.data;
}

/**
 * Look up customer ID by email
 */
async function getCustomerIdByEmail(email) {
  const query = `
    query getCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            email
          }
        }
      }
    }
  `;

  const data = await shopifyAdminFetch(query, {
    query: `email:${email}`,
  });

  const edges = data?.customers?.edges || [];
  if (edges.length === 0) return null;

  return edges[0].node.id;
}

/**
 * Main API Route
 */
export default async function handler(req, res) {
  // Handle CORS preflight
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
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    // 1️⃣ Lookup Shopify Customer ID
    const customerId = await getCustomerIdByEmail(email);
    if (!customerId) {
      return res.status(404).json({
        error: "Customer not found",
        email,
      });
    }

    // 2️⃣ Fetch Daily Logs metafield references
    const query = `
      query getDailyLogs($id: ID!) {
        customer(id: $id) {
          id
          metafield(namespace: "custom", key: "daily_logs") {
            references(first: 100) {
              nodes {
                ... on Metaobject {
                  id
                  fields {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await shopifyAdminFetch(query, { id: customerId });
    const metafield = data.customer.metafield;

    // 3️⃣ Parse referenced metaobjects
    const logs = (metafield?.references?.nodes || []).map((node) => {
      const obj = {};
      for (const f of node.fields) {
        obj[f.key] = f.value;
      }
      return {
        id: node.id,
        ...obj,
      };
    });

    // 4️⃣ Sort newest first (if dates exist)
    logs.sort((a, b) => (a.date < b.date ? 1 : -1));

    return res.status(200).json({
      ok: true,
      customerId,
      logs,
    });
  } catch (err) {
    console.error("get-daily-logs error:", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err.message || String(err),
    });
  }
}

