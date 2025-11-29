// /api/get-daily-logs.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Basic CORS helper
 */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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
    console.error("get-daily-logs: network error talking to Shopify:", err);
    throw new Error("Network error contacting Shopify Admin API");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("get-daily-logs: failed to parse Shopify JSON:", err);
    throw new Error("Invalid JSON from Shopify Admin API");
  }

  return json;
}

/**
 * NEXT handler
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

  const emailRaw =
    (req.query.email ||
      req.query.userEmail ||
      req.query.e ||
      "").toString();

  const email = emailRaw.toLowerCase().trim();

  if (!email) {
    res.status(400).json({ ok: false, error: "Missing ?email=" });
    return;
  }

  console.log("get-daily-logs: fetching daily_logs metafield for", email);

  try {
    // 1) Find customer by email + pull custom.daily_logs metafield
    const query = `
      query GetCustomerDailyLogs($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              email
              metafield(namespace: "custom", key: "daily_logs") {
                type
                value
              }
            }
          }
        }
      }
    `;

    const variables = {
      query: `email:${email}`,
    };

    const shopifyJson = await shopifyAdminFetch(query, variables);

    if (shopifyJson.errors) {
      console.error("get-daily-logs: Shopify GraphQL errors:", shopifyJson.errors);
      // Still return 200 so the dashboard doesn't blow up – just no logs.
      res.status(200).json({
        ok: false,
        email,
        error: "Shopify GraphQL error",
        shopifyErrors: shopifyJson.errors,
        logs: [],
        source: "error",
      });
      return;
    }

    const edges = shopifyJson.data?.customers?.edges || [];
    if (!edges.length) {
      console.log("get-daily-logs: no customer found for", email);
      res.status(200).json({
        ok: true,
        email,
        logs: [],
        source: "no_customer",
      });
      return;
    }

    const customerNode = edges[0].node;
    const mf = customerNode.metafield;

    let logs = [];

    if (mf && typeof mf.value === "string" && mf.value.trim().length > 0) {
      try {
        const parsed = JSON.parse(mf.value);
        if (Array.isArray(parsed)) {
          logs = parsed;
        } else {
          console.warn(
            "get-daily-logs: daily_logs metafield is not an array, got:",
            typeof parsed
          );
        }
      } catch (err) {
        console.error(
          "get-daily-logs: failed to parse daily_logs metafield JSON:",
          err,
          "raw value:",
          mf.value
        );
      }
    } else {
      console.log("get-daily-logs: no daily_logs metafield or empty value");
    }

    // Shape the response for the dashboard
    res.status(200).json({
      ok: true,
      email,
      logs,
      source: "customer_metafield",
    });
  } catch (err) {
    console.error("get-daily-logs: unexpected server error:", err);
    res.status(500).json({
      ok: false,
      email,
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
