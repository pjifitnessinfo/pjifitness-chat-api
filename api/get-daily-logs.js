// /api/get-daily-logs.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2024-01";

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

const DAILY_LOG_QUERY = `
  query DailyLogs($type: String!, $first: Int!, $query: String!) {
    metaobjects(type: $type, first: $first, query: $query) {
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

/**
 * Normalize Shopify metaobject -> plain log object
 */
function metaobjectToLog(node) {
  const fieldMap = {};
  (node.fields || []).forEach((f) => {
    fieldMap[f.key] = f.value;
  });

  const toNum = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  return {
    id: node.id,
    gid: node.id,
    display_name: node.displayName || null,

    date: fieldMap.date || null,

    weight: toNum(fieldMap.weight),
    calories: toNum(fieldMap.calories),
    steps: toNum(fieldMap.steps),

    mood: fieldMap.mood || null,
    feeling: fieldMap.feeling || null,
    struggle: fieldMap.struggle || null,
    coach_focus: fieldMap.coach_focus || null,
    meals: fieldMap.meals || null,

    // macros (may be null if not used yet)
    daily_protein: toNum(fieldMap.daily_protein),
    daily_carbs: toNum(fieldMap.daily_carbs),
    daily_fats: toNum(fieldMap.daily_fats),

    // customer + flag
    customer_id: fieldMap.customer_id || null,
    flag:
      typeof fieldMap.flag === "string"
        ? fieldMap.flag.toLowerCase() === "true"
        : null,
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Support both GET (?email=) and POST ({ email })
    let email = null;

    if (req.method === "GET") {
      email =
        req.query.email ||
        req.query.userEmail ||
        req.query.customerId ||
        null;
    } else {
      const body = req.body || {};
      email =
        body.email ||
        body.userEmail ||
        body.customerId ||
        null;
    }

    if (!email) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing email" });
    }

    email = String(email).toLowerCase();

    const queryString = `customer_id:${email}`;

    const data = await shopifyAdminFetch(DAILY_LOG_QUERY, {
      type: "daily_log",
      first: 200,
      query: queryString,
    });

    const edges = data?.metaobjects?.edges || [];
    const logs = edges.map((edge) => metaobjectToLog(edge.node));

    // sort ascending by date so dashboard code can do its thing
    logs.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

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
