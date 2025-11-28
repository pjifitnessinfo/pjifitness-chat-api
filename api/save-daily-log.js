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
 * NEW expected POST body from /api/chat:
 * {
 *   "email": "user@example.com",
 *   "log": {
 *     "date": "2025-11-26",
 *     "weight": 190.4,
 *     "calories": 2100,          // optional, we prefer total_calories
 *     "total_calories": 2100,    // preferred
 *     "steps": 8200,
 *     "mood": "tired",
 *     "struggle": "late night cravings",
 *     "coach_focus": "evening snacks",
 *     "meals": [
 *       {
 *         "meal_type": "Dinner",
 *         "items": ["chicken bowl", "rice"],
 *         "calories": 650
 *       }
 *     ],
 *     "flag": true
 *   }
 * }
 *
 * NOTE: we also still support the older fields:
 *   main_struggle, feeling, flag, etc.
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
    // Body can be object or string depending on environment
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch (err) {
        console.error("Failed to parse JSON body:", err);
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    const { email, log } = body;

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

    // Prefer total_calories, fallback to calories
    const weightVal = safe(log.weight);
    const caloriesVal = safe(
      log.total_calories !== undefined ? log.total_calories : log.calories
    );
    const stepsVal = safe(log.steps);

    if (weightVal !== null) {
      fields.push({ key: "weight", value: weightVal });
    }
    if (caloriesVal !== null) {
      fields.push({ key: "calories", value: caloriesVal });
    }
    if (stepsVal !== null) {
      fields.push({ key: "steps", value: stepsVal });
    }

    // mood / feeling / struggle / focus
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

    // struggle: support both new "struggle" and old "main_struggle"
    const struggleVal = safe(
      log.struggle !== undefined ? log.struggle : log.main_struggle
    );
    if (struggleVal !== null) {
      fields.push({ key: "struggle", value: struggleVal });
    }

    if (safe(log.coach_focus) !== null) {
      fields.push({ key: "coach_focus", value: safe(log.coach_focus) });
    }

    // meals:
    // - If array of strings, join with newlines
    // - If array of objects { meal_type, items, calories }, make readable lines
    if (Array.isArray(log.meals) && log.meals.length > 0) {
      let mealsField = null;

      if (typeof log.meals[0] === "string") {
        mealsField = log.meals.join("\n");
      } else {
        const lines = log.meals
          .map((m) => {
            if (!m) return "";
            const type = m.meal_type || m.type || "Meal";
            const items = Array.isArray(m.items)
              ? m.items.join(", ")
              : m.items || "";
            const cals =
              m.calories !== undefined
                ? m.calories
                : m.kcal !== undefined
                ? m.kcal
                : null;

            let line = type;
            if (items) line += `: ${items}`;
            if (cals !== null) line += ` (~${cals} kcal)`;
            return line;
          })
          .filter(Boolean);

        if (lines.length > 0) {
          mealsField = lines.join("\n");
        }
      }

      if (mealsField !== null) {
        fields.push({ key: "meals", value: mealsField });
      }
    }

    // flag: treat any truthy value as "true" (optional; might not be present)
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
