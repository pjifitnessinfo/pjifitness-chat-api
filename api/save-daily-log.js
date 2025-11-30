// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION =
  process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Basic CORS helper
 */
function setCors(res) {
  // TODO: tighten this to your real domain (e.g. "https://pjifitness.com")
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    console.error("Network error when calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("Error parsing Shopify JSON:", err);
    throw new Error("Invalid JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }

  return json.data;
}

/**
 * Normalize any date-ish thing into YYYY-MM-DD
 */
function normalizeDateString(d) {
  if (!d) return null;

  try {
    if (typeof d === "string") {
      if (d.length >= 10) {
        const sliced = d.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(sliced)) return sliced;
      }
    }

    const dt = new Date(d);
    if (!isFinite(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  } catch (e) {
    return null;
  }
}

/**
 * Normalize incoming log (make sure date exists & is YYYY-MM-DD)
 */
function normalizeIncomingLog(rawLog) {
  const log = { ...(rawLog || {}) };

  let normalizedDate = null;
  if (log.date) {
    normalizedDate = normalizeDateString(log.date);
  }

  if (!normalizedDate) {
    const now = new Date();
    normalizedDate = now.toISOString().slice(0, 10);
  }

  log.date = normalizedDate;
  return log;
}

/**
 * Ensure ownerId is a proper Shopify Customer GID
 */
function normalizeOwnerId(raw) {
  if (!raw) return raw;
  let s = String(raw).trim();

  // Already a full GID
  if (s.startsWith("gid://shopify/Customer/")) {
    return s;
  }

  // If it's numeric (e.g. "9603496542392"), wrap it
  const digits = s.replace(/\D/g, "");
  if (digits.length > 0) {
    return `gid://shopify/Customer/${digits}`;
  }

  console.warn("OwnerId could not be normalized to a Customer GID:", raw);
  return s;
}

/**
 * Helper to map meal_type to one of breakfast/lunch/dinner/snacks
 */
function mapMealSlot(mealTypeRaw) {
  if (!mealTypeRaw) return null;
  const t = String(mealTypeRaw).toLowerCase();
  if (t.includes("breakfast")) return "breakfast";
  if (t.includes("lunch")) return "lunch";
  if (t.includes("dinner") || t.includes("supper")) return "dinner";
  if (t.includes("snack")) return "snacks";
  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    // Preflight request
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res
      .status(405)
      .json({ ok: false, error: "Method not allowed" });
  }

  // Parse body
  let body;
  try {
    body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};
  } catch (err) {
    console.error("Invalid JSON body:", err);
    return res
      .status(400)
      .json({ ok: false, error: "Invalid JSON body" });
  }

  const {
    customerId,
    customer_id,
    customerGid,
    customer_gid,
    ownerId: bodyOwner,
    log,
    daily_log,
    dailyLog,
    email, // not used for saving, but OK if present
  } = body || {};

  // We accept multiple possible fields for the customer ID
  const rawOwnerId =
    bodyOwner || customerId || customer_id || customerGid || customer_gid;

  const ownerId = normalizeOwnerId(rawOwnerId);
  const incomingLog = log || daily_log || dailyLog;

  if (!ownerId) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing customerId / ownerId" });
  }
  if (!incomingLog) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing daily log payload" });
  }

  const normalizedIncoming = normalizeIncomingLog(incomingLog);
  const logDate = normalizedIncoming.date;

  // ===============================
  // 1) Fetch existing daily_logs
  // ===============================
  const GET_DAILY_LOGS = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        id
        dailyLogs: metafield(namespace: "custom", key: "daily_logs") {
          id
          key
          namespace
          type
          value
        }
      }
    }
  `;

  let existingLogs = [];
  try {
    const data = await shopifyAdminFetch(GET_DAILY_LOGS, { id: ownerId });

    const mf = data?.customer?.dailyLogs;
    if (mf && mf.value) {
      try {
        const parsed = JSON.parse(mf.value);
        if (Array.isArray(parsed)) {
          existingLogs = parsed;
        } else if (parsed && typeof parsed === "object") {
          // Old format: single object → wrap in array
          existingLogs = [parsed];
        } else {
          console.warn(
            "daily_logs metafield value was not array/object, resetting to []"
          );
        }
      } catch (err) {
        console.error("Error parsing existing daily_logs JSON:", err);
      }
    }
  } catch (err) {
    console.error("Error fetching existing daily_logs metafield:", err);
    // If this fails, we’ll just treat it as no existing logs
  }

  // ===============================
  // 2) Append this new log
  //    (NEVER merge; each message = new entry)
  // ===============================
  const updatedLogs = Array.isArray(existingLogs) ? [...existingLogs] : [];
  updatedLogs.push(normalizedIncoming);

  // ===============================
  // 2b) Derive per-meal metafields
  //     for THE LOG'S OWN DATE
  // ===============================
  // Use the log's date as the target for aggregation.
  // If for some reason it's missing, fall back to "today".
  const targetDate =
    logDate || new Date().toISOString().slice(0, 10);

  const mealBuckets = {
    breakfast: { descParts: [], cals: 0 },
    lunch: { descParts: [], cals: 0 },
    dinner: { descParts: [], cals: 0 },
    snacks: { descParts: [], cals: 0 },
  };

  try {
    updatedLogs.forEach((entry) => {
      if (!entry) return;
      const d = normalizeDateString(entry.date);
      if (!d || d !== targetDate) return;

      const meals = Array.isArray(entry.meals) ? entry.meals : [];
      meals.forEach((meal) => {
        if (!meal) return;
        const slot = mapMealSlot(meal.meal_type);
        if (!slot || !mealBuckets[slot]) return;

        const items = Array.isArray(meal.items) ? meal.items : [];
        const text =
          items.length > 0
            ? items.join(", ")
            : String(meal.meal_type || "").trim();
        if (text) {
          mealBuckets[slot].descParts.push(text);
        }

        const rawCal = meal.calories;
        const numCal =
          rawCal == null ? 0 : parseFloat(rawCal);
        if (Number.isFinite(numCal) && numCal > 0) {
          mealBuckets[slot].cals += Math.round(numCal);
        }
      });
    });
  } catch (err) {
    console.error("Error aggregating per-meal data:", err);
  }

  const safeInt = (n) =>
    Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

  // Build descriptions; if there truly are no meals for that slot
  // we leave descParts empty and will handle that on the dashboard UI.
  const breakfastDesc =
    mealBuckets.breakfast.descParts.join(" | ");
  const lunchDesc =
    mealBuckets.lunch.descParts.join(" | ");
  const dinnerDesc =
    mealBuckets.dinner.descParts.join(" | ");
  const snacksDesc =
    mealBuckets.snacks.descParts.join(" | ");

  const breakfastCals = safeInt(mealBuckets.breakfast.cals);
  const lunchCals = safeInt(mealBuckets.lunch.cals);
  const dinnerCals = safeInt(mealBuckets.dinner.cals);
  const snacksCals = safeInt(mealBuckets.snacks.cals);

  // ===============================
  // 3) Save back to Shopify
  // ===============================
  const METAFIELDS_SET = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          namespace
          type
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafieldsPayload = [
    // Full history JSON
    {
      ownerId,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(updatedLogs),
    },
    // Breakfast
    {
      ownerId,
      namespace: "custom",
      key: "breakfast_description",
      type: "multi_line_text_field",
      value: breakfastDesc || "",
    },
    {
      ownerId,
      namespace: "custom",
      key: "breakfast_calories",
      type: "number_integer",
      value: String(breakfastCals || 0),
    },
    // Lunch
    {
      ownerId,
      namespace: "custom",
      key: "lunch_description",
      type: "multi_line_text_field",
      value: lunchDesc || "",
    },
    {
      ownerId,
      namespace: "custom",
      key: "lunch_calories",
      type: "number_integer",
      value: String(lunchCals || 0),
    },
    // Dinner
    {
      ownerId,
      namespace: "custom",
      key: "dinner_description",
      type: "multi_line_text_field",
      value: dinnerDesc || "",
    },
    {
      ownerId,
      namespace: "custom",
      key: "dinner_calories",
      type: "number_integer",
      value: String(dinnerCals || 0),
    },
    // Snacks
    {
      ownerId,
      namespace: "custom",
      key: "snacks_description",
      type: "multi_line_text_field",
      value: snacksDesc || "",
    },
    {
      ownerId,
      namespace: "custom",
      key: "snacks_calories",
      type: "number_integer",
      value: String(snacksCals || 0),
    },
  ];

  try {
    const result = await shopifyAdminFetch(METAFIELDS_SET, {
      metafields: metafieldsPayload,
    });

    const userErrors = result?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("metafieldsSet userErrors:", userErrors);
      return res.status(500).json({
        ok: false,
        error: "Failed to save daily logs",
        details: userErrors,
      });
    }

    const totalDayCals =
      breakfastCals + lunchCals + dinnerCals + snacksCals;

    return res.status(200).json({
      ok: true,
      savedDate: logDate,
      logsCount: updatedLogs.length,
      mealsForDate: targetDate,
      mealsSummary: {
        breakfastCals,
        lunchCals,
        dinnerCals,
        snacksCals,
        totalDayCals,
      },
    });
  } catch (err) {
    console.error("Error saving metafields:", err);
    return res.status(500).json({
      ok: false,
      error: "Error saving daily logs metafield",
    });
  }
}
