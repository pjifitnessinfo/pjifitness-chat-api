// /api/get-daily-logs.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Helper: call Shopify Admin GraphQL
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
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ✅ Support BOTH GET ?email=... and POST { email }
  let email = null;

  if (req.method === "GET") {
    // Next.js / Vercel exposes query params on req.query
    const q = req.query || {};
    email = (q.email || "").toLowerCase();
  } else if (req.method === "POST") {
    const body = req.body || {};
    email = (body.email || "").toLowerCase();
  } else {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!email) {
    return res.status(400).json({ ok: false, error: "Missing email" });
  }

  try {
    const gql = `
      query DailyLogs($query: String) {
        metaobjects(type: "daily_log", first: 60, query: $query) {
          edges {
            node {
              id
              fields {
                key
                value
              }
            }
          }
        }
      }
    `;

    const data = await shopifyAdminFetch(gql, {
      query: `customer_id:${email}`,
    });

    const edges = data?.metaobjects?.edges || [];

    // Flatten to a simple array of log objects
    const logs = edges.map((edge) => {
      const node = edge.node;
      const obj = { id: node.id };

      for (const field of node.fields || []) {
        obj[field.key] = field.value;
      }

      return obj;
    });

    return res.status(200).json({
      ok: true,
      email,
      logs,
    });
  } catch (err) {
    console.error("get-daily-logs error:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      details: err.message || String(err),
    });
  }
}
