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
 * Create a daily_log metaobject in Shopify for this customer/email
 *
 * Expected POST body:
 * {
 *   "email": "user@example.com",
 *   "log": {
 *     "date": "2025-11-26",
 *     "weight": "190.4",
 *     "calories": "2150",
 *     "steps": "8200",
 *     "mood": "good",
 *     "feeling": "pretty calm",   // optional – we merge into mood
 *     "main_struggle": "late night cravings",
 *     "coach_focus": "plan last meal better",
 *     "flag": "true"
 *   }
 * }
 */
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS for POST
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { email, log } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }
    if (!log || !log.date) {
      return res.status(400).json({ error: "Missing log or log.date" });
    }

    // Normalize values as strings (Shopify metaobject fields are strings)
    const safe = (val) =>
      val === undefined || val === null ? null : String(val);

    const fields = [];

    // required link to customer (we use email, same as get-daily-logs)
    fields.push({ key: "customer_id", value: String(email).toLowerCase() });

    // date (required)
    fields.push({ key: "date", value: safe(log.date) || "" });

    if (safe(log.weight) !== null) {
      fields.push({ key: "weight", value: safe(log.weight) });
    }
    if (safe(log.calories) !== null) {
      fields.push({ key: "calories", value: safe(log.calories) });
    }
    if (safe(log.steps) !== null) {
      fields.push({ key: "steps", value: safe(log.steps) });
    }

    // mood / feeling / struggle / focus
    // 👉 Your Daily Log definition has "mood" but not "feeling",
    // so we MERGE feeling into mood text and do NOT send a field named "feeling".
    const moodVal = safe(log.mood);
    const feelingVal = safe(log.feeling);

    if (moodVal !== null || feelingVal !== null) {
      let combined = "";
      if (moodVal) combined += moodVal;
      if (feelingVal) {
        combined += combined ? ` | feeling: ${feelingVal}` : feelingVal;
      }
      fields.push({ key: "mood", value: combined });
    }

    if (safe(log.main_struggle) !== null) {
      // store under "struggle" which your dashboard already knows how to read
      fields.push({ key: "struggle", value: safe(log.main_struggle) });
    }
    if (safe(log.coach_focus) !== null) {
      fields.push({ key: "coach_focus", value: safe(log.coach_focus) });
    }

    // optional meals, if you add that later
    if (Array.isArray(log.meals) && log.meals.length > 0) {
      fields.push({ key: "meals", value: log.meals.join("\n") });
    }

    // flag: treat any truthy value as "true"
    if (log.flag !== undefined) {
      const val = String(log.flag).toLowerCase();
      const flagValue =
        val === "true" || val === "1" || val === "yes" ? "true" : "false";
      fields.push({ key: "flag", value: flagValue });
    }

    const mutation = `
      mutation CreateDailyLog($type: String!, $fields: [MetaobjectFieldInput!]!) {
        metaobjectCreate(metaobject: { type: $type, fields: $fields }) {
          metaobject {
            id
            type
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const data = await shopifyAdminFetch(mutation, {
      type: "daily_log",
      fields,
    });

    const createResult = data?.metaobjectCreate;
    if (createResult?.userErrors && createResult.userErrors.length > 0) {
      console.error(
        "metaobjectCreate userErrors:",
        JSON.stringify(createResult.userErrors, null, 2)
      );
      return res.status(500).json({
        error: "Shopify metaobjectCreate error",
        userErrors: createResult.userErrors,
      });
    }

    const createdId = createResult?.metaobject?.id || null;

    return res.status(200).json({
      ok: true,
      metaobjectId: createdId,
      email,
      log,
    });
  } catch (err) {
    console.error("save-daily-log error:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err.message || String(err),
    });
  }
}
