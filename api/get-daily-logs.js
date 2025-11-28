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
 * OLD: metaobject query (kept as fallback)
 */
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
 * NEW: customer + metafields query
 */
const CUSTOMER_DAILY_LOGS_QUERY = `
  query CustomerDailyLogs($query: String!) {
    customers(first: 1, query: $query) {
      edges {
        node {
          id
          email
          metafield(namespace: "custom", key: "daily_logs") {
            id
            value
          }
          metafield_start: metafield(namespace: "custom", key: "start_weight") {
            value
          }
          metafield_goal: metafield(namespace: "custom", key: "goal_weight") {
            value
          }
          metafield_cal_goal: metafield(namespace: "custom", key: "calorie_goal") {
            value
          }
        }
      }
    }
  }
`;

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? null : n;
}

/**
 * Normalize OLD metaobject -> plain log object
 */
function metaobjectToLog(node) {
  const fieldMap = {};
  (node.fields || []).forEach((f) => {
    fieldMap[f.key] = f.value;
  });

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
    meals: fieldMap.meals || null, // old string-style meals
    daily_protein: toNum(fieldMap.daily_protein),
    daily_carbs: toNum(fieldMap.daily_carbs),
    daily_fats: toNum(fieldMap.daily_fats),
    customer_id: fieldMap.customer_id || null,
    flag:
      typeof fieldMap.flag === "string"
        ? fieldMap.flag.toLowerCase() === "true"
        : null,
  };
}

/**
 * NEW: Normalize metafield JSON entry -> plain log object
 */
function metafieldEntryToLog(entry, idx) {
  const e = entry || {};
  return {
    id: e.id || `metafield-log-${idx}`,
    gid: e.id || null,
    display_name: e.display_name || null,
    date: e.date || null,
    weight: toNum(e.weight),
    calories: toNum(e.calories),
    total_calories: toNum(e.total_calories),
    steps: toNum(e.steps),
    mood: e.mood || null,
    feeling: e.feeling || null,
    struggle: e.struggle || null,
    coach_focus: e.coach_focus || null,
    meals: Array.isArray(e.meals) ? e.meals : [],
    daily_protein: toNum(e.daily_protein),
    daily_carbs: toNum(e.daily_carbs),
    daily_fats: toNum(e.daily_fats),
    customer_id: e.customer_id || null,
    flag:
      typeof e.flag === "string"
        ? e.flag.toLowerCase() === "true"
        : e.flag === true
        ? true
        : null,
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

    // ==============================
    // 1) TRY NEW METAFIELD-BASED FLOW
    // ==============================
    let logs = [];
    let startWeight = null;
    let goalWeight = null;
    let calorieGoal = null;

    try {
      // IMPORTANT CHANGE: wrap email in quotes for Shopify search
      const customerQuery = `email:${JSON.stringify(email)}`; // e.g. email:"pjantoniato@gmail.com"

      const customerData = await shopifyAdminFetch(
        CUSTOMER_DAILY_LOGS_QUERY,
        { query: customerQuery }
      );

      const customerEdges = customerData?.customers?.edges || [];

      if (customerEdges.length > 0) {
        const customerNode = customerEdges[0].node;

        const mfDailyLogs = customerNode.metafield;
        if (mfDailyLogs && typeof mfDailyLogs.value === "string") {
          try {
            const parsed = JSON.parse(mfDailyLogs.value || "[]");
            if (Array.isArray(parsed)) {
              logs = parsed.map(metafieldEntryToLog);
            }
          } catch (e) {
            console.error(
              "Error parsing daily_logs metafield JSON:",
              e
            );
          }
        }

        if (customerNode.metafield_start && customerNode.metafield_start.value != null) {
          startWeight = toNum(customerNode.metafield_start.value);
        }
        if (customerNode.metafield_goal && customerNode.metafield_goal.value != null) {
          goalWeight = toNum(customerNode.metafield_goal.value);
        }
        if (customerNode.metafield_cal_goal && customerNode.metafield_cal_goal.value != null) {
          calorieGoal = toNum(customerNode.metafield_cal_goal.value);
        }
      }
    } catch (e) {
      console.error("Error fetching customer/metafield daily logs:", e);
      // fall through to metaobject fallback
    }

    if (logs.length > 0) {
      logs.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      return res.status(200).json({
        ok: true,
        email,
        source: "metafield",
        start_weight: startWeight,
        goal_weight: goalWeight,
        calorie_goal: calorieGoal,
        logs,
      });
    }

    // =====================================
    // 2) FALLBACK: OLD METAOBJECT-BASED FLOW
    // =====================================

    const queryString = `customer_id:${email}`;

    const data = await shopifyAdminFetch(DAILY_LOG_QUERY, {
      type: "daily_log",
      first: 200,
      query: queryString,
    });

    const edges = data?.metaobjects?.edges || [];
    const metaobjectLogs = edges.map((edge) =>
      metaobjectToLog(edge.node)
    );

    metaobjectLogs.sort((a, b) =>
      (a.date || "").localeCompare(b.date || "")
    );

    return res.status(200).json({
      ok: true,
      email,
      source: "metaobject",
      logs: metaobjectLogs,
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
