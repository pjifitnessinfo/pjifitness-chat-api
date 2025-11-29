// /api/get-daily-logs.js
// Pull daily logs ONLY from metaobjects, no Customer object access (fixes PII error)

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
    console.error("get-daily-logs: network error calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("get-daily-logs: failed to parse Shopify response JSON:", err);
    throw new Error("Failed to parse Shopify response from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("get-daily-logs: Shopify GraphQL error:", json.errors);
    const error = new Error("Shopify GraphQL error");
    error.shopifyErrors = json.errors || [];
    throw error;
  }

  return json;
}

/**
 * Very small helper to coerce strings → numbers / booleans / JSON safely
 */
function smartParse(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Try integer / float
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }

  // Try JSON (for meals array, etc.)
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }

  return trimmed;
}

/**
 * Flatten a Metaobject node into a simple JS object
 */
function flattenDailyLogMetaobject(node) {
  const obj = {
    id: node.id,
    gid: node.id,
    display_name: node.displayName || node.display_name || null,
  };

  if (Array.isArray(node.fields)) {
    for (const f of node.fields) {
      if (!f || !f.key) continue;
      obj[f.key] = smartParse(f.value);
    }
  }

  return obj;
}

/**
 * CORS
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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

  const email = (req.query.email || req.query.userEmail || "").toLowerCase().trim();

  if (!email) {
    res.status(400).json({ ok: false, error: "Missing ?email= query parameter" });
    return;
  }

  try {
    // 🔹 IMPORTANT: We ONLY query metaobjects, NOT customers (avoids PII restriction)
    const query = /* GraphQL */ `
      query DailyLogsByCustomer($customerId: String!) {
        metaobjects(
          type: "daily_log"
          first: 100
          reverse: true
          query: $customerId
        ) {
          edges {
            node {
              id
              displayName
              fields {
                key
                value
              }
            }
          }
        }
      }
    `;

    const variables = {
      customerId: email, // we save customer_id as the email string in the metaobject
    };

    const json = await shopifyAdminFetch(query, variables);

    const edges = json.data?.metaobjects?.edges || [];
    const logs = edges
      .map((edge) => flattenDailyLogMetaobject(edge.node))
      // safety: only keep logs that actually match this email in customer_id
      .filter((log) => {
        const cid = (log.customer_id || log.customerId || "").toLowerCase();
        return cid === email;
      });

    // Sort newest → oldest by date if present
    logs.sort((a, b) => {
      const da = new Date(a.date || a.log_date || 0).getTime();
      const db = new Date(b.date || b.log_date || 0).getTime();
      return db - da;
    });

    res.status(200).json({
      ok: true,
      email,
      source: "metaobject",
      logs,
    });
  } catch (err) {
    console.error("get-daily-logs: handler error:", err);
    res.status(500).json({
      ok: false,
      email,
      error: "Shopify GraphQL error",
      details: err.message || String(err),
      shopifyErrors: err.shopifyErrors || null,
      logs: [],
      source: "error",
    });
  }
}
