// /api/save-daily-log.js

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
    console.error("Failed to parse Shopify response JSON:", err);
    throw new Error("Bad JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", json.errors || json);
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/**
 * Find customer by email
 */
async function findCustomerByEmail(email) {
  const query = `
    query GetCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        nodes {
          id
          email
          metafields(first: 20, namespace: "custom") {
            edges {
              node {
                id
                namespace
                key
                type
                value
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyAdminFetch(query, {
    query: `email:${email}`,
  });

  const nodes = data?.customers?.nodes || [];
  return nodes[0] || null;
}

/**
 * Upsert customer metafield "daily_logs" (JSON)
 */
async function saveDailyLogsMetafield(customerId, logsArray) {
  const mutation = `
    mutation SaveDailyLogs($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafields = [
    {
      ownerId: customerId,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(logsArray),
    },
  ];

  const data = await shopifyAdminFetch(mutation, { metafields });

  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length > 0) {
    console.error("Error saving daily_logs metafield:", errors);
    throw new Error("Failed to save daily_logs metafield");
  }

  return data.metafieldsSet.metafields[0];
}

/**
 * Merge incoming log into existing logs for SAME date
 * - Keep other days intact
 * - Merge fields for today's date
 * - Append meals and recalc total_calories
 */
function mergeDailyLog(existingLogs, incomingLogRaw) {
  const todayISO = new Date().toISOString().slice(0, 10);

  const incoming = {
    date: incomingLogRaw.date || todayISO,
    weight:
      typeof incomingLogRaw.weight === "number"
        ? incomingLogRaw.weight
        : null,
    calories:
      typeof incomingLogRaw.calories === "number"
        ? incomingLogRaw.calories
        : null,
    steps:
      typeof incomingLogRaw.steps === "number"
        ? incomingLogRaw.steps
        : null,
    meals: Array.isArray(incomingLogRaw.meals)
      ? incomingLogRaw.meals
      : [],
    total_calories:
      typeof incomingLogRaw.total_calories === "number"
        ? incomingLogRaw.total_calories
        : null,
    mood:
      typeof incomingLogRaw.mood === "string"
        ? incomingLogRaw.mood
        : null,
    struggle:
      typeof incomingLogRaw.struggle === "string"
        ? incomingLogRaw.struggle
        : null,
    coach_focus:
      typeof incomingLogRaw.coach_focus === "string" &&
      incomingLogRaw.coach_focus.trim().length > 0
        ? incomingLogRaw.coach_focus.trim()
        : "",
  };

  const logs = Array.isArray(existingLogs) ? [...existingLogs] : [];

  const idx = logs.findIndex((d) => d && d.date === incoming.date);

  if (idx === -1) {
    // === No entry for this date yet: create one ===
    const totalCalories =
      incoming.total_calories ||
      incoming.calories ||
      (incoming.meals || []).reduce(
        (sum, m) =>
          sum + (typeof m.calories === "number" ? m.calories : 0),
        0
      );

    const newEntry = {
      date: incoming.date,
      weight: incoming.weight,
      calories: totalCalories || null,
      steps: incoming.steps,
      meals: incoming.meals || [],
      total_calories: totalCalories || null,
      mood: incoming.mood,
      struggle: incoming.struggle,
      coach_focus:
        incoming.coach_focus ||
        "Stay consistent with your plan today.",
    };

    logs.push(newEntry);
    return logs;
  }

  // === Merge into existing entry for this date ===
  const existing = logs[idx];

  // nums: overwrite if new value present
  if (incoming.weight !== null) {
    existing.weight = incoming.weight;
  }

  // steps
  if (incoming.steps !== null) {
    existing.steps = incoming.steps;
  }

  // mood & struggle
  if (incoming.mood !== null) {
    existing.mood = incoming.mood;
  }
  if (incoming.struggle !== null) {
    existing.struggle = incoming.struggle;
  }

  // coach_focus: always keep the latest non-empty
  if (incoming.coach_focus) {
    existing.coach_focus = incoming.coach_focus;
  } else if (!existing.coach_focus) {
    existing.coach_focus = "Stay consistent with your plan today.";
  }

  // Meals + calories
  const incomingMeals = incoming.meals || [];
  if (incomingMeals.length > 0) {
    const existingMeals = Array.isArray(existing.meals)
      ? existing.meals
      : [];
    const mergedMeals = existingMeals.concat(incomingMeals);

    const mergedTotal = mergedMeals.reduce(
      (sum, m) =>
        sum + (typeof m.calories === "number" ? m.calories : 0),
      0
    );

    existing.meals = mergedMeals;
    existing.total_calories = mergedTotal || null;
    existing.calories = mergedTotal || null;
  } else {
    // No meals in this log, but maybe a direct calorie number
    const calFromLog =
      incoming.total_calories || incoming.calories || null;
    if (calFromLog !== null) {
      existing.total_calories = calFromLog;
      existing.calories = calFromLog;
    }
  }

  logs[idx] = existing;
  return logs;
}

/**
 * Vercel handler
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const email = (body.email || "").toLowerCase();
    const log   = body.log;

    if (!email || !log) {
      res.status(400).json({
        error: "Missing required fields 'email' or 'log'",
      });
      return;
    }

    console.log("save-daily-log incoming email:", email);
    console.log("save-daily-log incoming log:", JSON.stringify(log));

    const customer = await findCustomerByEmail(email);
    if (!customer) {
      console.error("No customer found for email:", email);
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const customerId = customer.id;

    // Find existing daily_logs metafield in namespace "custom"
    let existingLogs = [];
    const metafieldEdges =
      customer.metafields?.edges || [];

    const dailyLogsMeta = metafieldEdges.find(
      (edge) => edge.node.key === "daily_logs"
    );

    if (dailyLogsMeta && dailyLogsMeta.node.value) {
      try {
        const parsed = JSON.parse(dailyLogsMeta.node.value);
        if (Array.isArray(parsed)) {
          existingLogs = parsed;
        }
      } catch (err) {
        console.error(
          "Failed to parse existing daily_logs JSON:",
          err
        );
      }
    }

    // Merge incoming log into existing logs
    const updatedLogs = mergeDailyLog(existingLogs, log);

    // Save back to Shopify
    await saveDailyLogsMetafield(customerId, updatedLogs);

    res.status(200).json({
      ok: true,
      message: "Daily log saved",
      count: updatedLogs.length,
    });
  } catch (err) {
    console.error("Error in /api/save-daily-log:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
