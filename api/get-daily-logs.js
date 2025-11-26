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

/**
 * API route: return all daily logs for a given email
 * We avoid the Customer object completely (no PII gate) and
 * instead query metaobjects(type: "daily_log") and filter in code.
 *
 * NOW supports:
 *   - GET  /api/get-daily-logs?email=...
 *   - POST /api/get-daily-logs  { email }
 * with CORS enabled for your Shopify storefront.
 */
export default async function handler(req, res) {
  // 🔥 CORS for browser requests (Shopify dashboard)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Support both GET (querystring) and POST (JSON body)
    let email;

    if (req.method === "GET") {
      email = req.query.email;
    } else {
      const { email: bodyEmail } = req.body || {};
      email = bodyEmail;
    }

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    // 1️⃣ Pull all Daily Log metaobjects
    const query = `
      query getAllDailyLogs {
        metaobjects(type: "daily_log", first: 250) {
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

    const data = await shopifyAdminFetch(query);
    const edges = data?.metaobjects?.edges || [];

    // 2️⃣ Turn into JS objects
    const allLogs = edges.map(({ node }) => {
      const obj = {};
      for (const f of node.fields) {
        obj[f.key] = f.value;
      }
      return {
        id: node.id,
        ...obj,
      };
    });

    // 3️⃣ Filter for this customer (by email stored in customer_id)
    const logs = allLogs.filter(
      (log) => (log.customer_id || "").toLowerCase() === email.toLowerCase()
    );

    // 4️⃣ Sort newest -> oldest by date
    logs.sort((a, b) => {
      if (!a.date || !b.date) return 0;
      return a.date < b.date ? 1 : -1;
    });

    return res.status(200).json({
      ok: true,
      email,
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
