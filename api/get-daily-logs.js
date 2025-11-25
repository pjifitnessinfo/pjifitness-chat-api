// /api/get-daily-logs.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

async function shopifyAdminFetch(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL request failed");
  }

  return json.data;
}

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

  const edges = data.customers.edges;
  if (!edges || edges.length === 0) return null;

  return edges[0].node.id;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const customerId = await getCustomerIdByEmail(email);
    if (!customerId) {
      return res.status(404).json({ error: "Customer not found" });
    }

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

    // newest first
    logs.sort((a, b) => (a.date < b.date ? 1 : -1));

    return res.status(200).json({
      ok: true,
      customerId,
      logs,
    });
  } catch (err) {
    console.error("get-daily-logs error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
