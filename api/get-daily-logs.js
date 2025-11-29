// /api/get-daily-logs.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Simple CORS helper
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

/**
 * Helper: call Shopify Admin GraphQL and return data
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
    console.error("get-daily-logs: network error calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("get-daily-logs: failed to parse Shopify JSON:", err);
    throw new Error("Bad JSON from Shopify");
  }

  if (json.errors) {
    console.error("get-daily-logs: Shopify GraphQL errors:", json.errors);
    throw new Error("Shopify GraphQL error");
  }

  if (!json.data) {
    console.error("get-daily-logs: missing data in Shopify response:", json);
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/**
 * Map a metaobject node → simple daily log object
 */
function mapMetaobjectToLog(node) {
  const out = {
    id: node.id,
    gid: node.id,
  };

  if (Array.isArray(node.fields)) {
    node.fields.forEach((f) => {
      if (!f || !f.key) return;
      out[f.key] = f.value;
    });
  }

  // Normalize common numeric fields if present
  const numKeys = [
    "weight",
    "calories",
    "steps",
    "daily_protein",
    "daily_carbs",
    "daily_fats",
  ];

  numKeys.forEach((k) => {
    if (out[k] == null || out[k] === "") {
      out[k] = null;
    } else {
      const n = Number(out[k]);
      out[k] = isNaN(n) ? null : n;
    }
  });

  // Flag
  if ("flag" in out) {
    const v = out.flag;
    out.flag =
      v === true ||
      v === "true" ||
      v === "1" ||
      v === 1 ||
      v === "yes" ||
      v === "Y";
  }

  return out;
}

/**
 * GET /api/get-daily-logs?email=...
 */
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const email =
    (req.query.email || req.query.e || "").toString().toLowerCase().trim();

  if (!email) {
    res.status(400).json({ ok: false, error: "Missing email query parameter" });
    return;
  }

  try {
    // We search metaobjects by a field that stores the email.
    // Old code used something like customer_id:EMAIL – keep that pattern.
    const search = `customer_id:${email}`;

    const query = `
      query GetDailyLogs($search: String!) {
        metaobjects(type: "daily_log", first: 90, query: $search) {
          edges {
            node {
              id
              handle
              fields {
                key
                value
              }
            }
          }
        }
      }
    `;

    const data = await shopifyAdminFetch(query, { search });

    const edges = data.metaobjects?.edges || [];
    const logs = edges.map((edge) => mapMetaobjectToLog(edge.node));

    // Sort newest → oldest by date if available
    logs.sort((a, b) => {
      const da = a.date ? Date.parse(a.date) : 0;
      const db = b.date ? Date.parse(b.date) : 0;
      return db - da;
    });

    res.status(200).json({
      ok: true,
      email,
      source: "metaobject",
      logs,
    });
  } catch (err) {
    console.error("Error in /api/get-daily-logs:", err);
    res.status(500).json({
      ok: false,
      email,
      error: "Internal server error",
      details: err?.message || "Unknown error",
    });
  }
}
