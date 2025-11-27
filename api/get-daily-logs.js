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
 * - Supports BOTH:
 *    • GET  /api/get-daily-logs?email=...
 *    • POST { "email": "..." }
 */
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let email = null;

  if (req.method === "GET") {
    const q = req.query || {};
    email =
      (q.email ||
        q.userEmail ||
        q.user_id ||
        q.userId ||
        q.customerId ||
        "").toLowerCase();
  } else if (req.method === "POST") {
    const body = req.body || {};
    email =
      (body.email ||
        body.userEmail ||
        body.user_id ||
        body.userId ||
        body.customerId ||
        "").toLowerCase();
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  try {
    console.log("get-daily-logs → email:", email);

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
      (log) => (log.customer_id || "").toLowerCase() === email
    );

    // 4️⃣ Sort newest -> oldest by date
    logs.sort((a, b) => {
      if (!a.date || !b.date) return 0;
      return a.date < b.date ? 1 : -1;
    });

    console.log(`get-daily-logs → found ${logs.length} logs for`, email);

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
