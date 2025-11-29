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
    console.error("Failed to parse Shopify JSON:", err);
    throw new Error("Failed to parse Shopify JSON");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }

  return json;
}

/**
 * Basic CORS helper
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
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const email = (req.query.email || "").toString().toLowerCase().trim();

  if (!email) {
    res.status(400).json({ ok: false, error: "Missing ?email=" });
    return;
  }

  try {
    // 1) Find the customer by email + pull metafields directly
    const query = `
      query GetCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              email

              metafield(namespace: "custom", key: "daily_logs") {
                id
                type
                value
              }

              metafield(namespace: "custom", key: "start_weight") {
                value
              }
              metafield(namespace: "custom", key: "goal_weight") {
                value
              }
              metafield(namespace: "custom", key: "calorie_goal") {
                value
              }
            }
          }
        }
      }
    `;

    const data = await shopifyAdminFetch(query, {
      query: `email:${email}`,
    });

    const edges = data?.data?.customers?.edges || [];
    if (!edges.length) {
      res.status(200).json({
        ok: true,
        email,
        source: "none",
        logs: [],
      });
      return;
    }

    const customer = edges[0].node;

    // 2) Read daily_logs metafield (JSON array)
    const mf = customer.metafield;
    let logs = [];

    if (mf && mf.value) {
      try {
        const parsed = JSON.parse(mf.value);
        if (Array.isArray(parsed)) {
          logs = parsed.map((log) => ({
            date: log.date || null,
            weight: log.weight ?? null,
            calories: log.calories ?? log.total_calories ?? null,
            steps: log.steps ?? null,
            meals: log.meals ?? null,
            total_calories:
              log.total_calories != null ? log.total_calories : log.calories ?? null,
            mood: log.mood ?? log.feeling ?? null,
            struggle: log.struggle ?? null,
            coach_focus: log.coach_focus || "Stay consistent today.",
            flag: log.flag ?? false,
          }));
        }
      } catch (err) {
        console.error("Error parsing daily_logs metafield JSON:", err);
      }
    }

    // 3) Sort logs by date DESC (latest first)
    function normalizeDate(value) {
      if (!value) return null;
      if (value instanceof Date) return value;
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        return new Date(value + "T00:00:00");
      }
      const t = Date.parse(value);
      if (!isNaN(t)) return new Date(t);
      return null;
    }

    logs = logs
      .map((l) => ({
        ...l,
        _d: normalizeDate(l.date),
      }))
      .filter((l) => !!l._d)
      .sort((a, b) => b._d.getTime() - a._d.getTime());

    // 4) Grab start/goal/calorie goals from metafields (if set)
    const startWeightMf = customer.metafield__custom_start_weight || customer.metafield_start_weight;
    const goalWeightMf = customer.metafield__custom_goal_weight || customer.metafield_goal_weight;
    const calorieGoalMf =
      customer.metafield__custom_calorie_goal || customer.metafield_calorie_goal;

    const start_weight = startWeightMf?.value
      ? Number(startWeightMf.value)
      : null;
    const goal_weight = goalWeightMf?.value ? Number(goalWeightMf.value) : null;
    const calorie_goal = calorieGoalMf?.value
      ? Number(calorieGoalMf.value)
      : null;

    res.status(200).json({
      ok: true,
      email,
      source: "metafield",
      start_weight,
      goal_weight,
      calorie_goal,
      logs,
    });
  } catch (err) {
    console.error("Error in /api/get-daily-logs:", err);
    res.status(500).json({
      ok: false,
      email,
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}

