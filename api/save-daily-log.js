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
 * Helper: normalize a single log object for merging
 */
function normalizeLogForMerging(log) {
  if (!log || typeof log !== "object") return null;
  const copy = { ...log };

  // Normalize date
  copy.date = normalizeDateString(copy.date) || copy.date || null;

  // Ensure meals is an array
  if (!Array.isArray(copy.meals)) {
    copy.meals = [];
  }

  // Recompute total_calories from meals if possible
  const totalFromMeals = copy.meals.reduce((sum, m) => {
    if (!m) return sum;
    const c = Number(m.calories);
    return Number.isFinite(c) ? sum + c : sum;
  }, 0);

  if (copy.meals.length > 0 && totalFromMeals > 0) {
    copy.total_calories = totalFromMeals;
  } else if (
    copy.total_calories !== null &&
    copy.total_calories !== undefined &&
    !Number.isNaN(Number(copy.total_calories))
  ) {
    copy.total_calories = Number(copy.total_calories);
  } else {
    copy.total_calories = null;
  }

  // Normalize top-level calories if present
  if (
    copy.calories !== null &&
    copy.calories !== undefined &&
    !Number.isNaN(Number(copy.calories))
  ) {
    copy.calories = Number(copy.calories);
  } else {
    copy.calories = null;
  }

  return copy;
}

/**
 * Merge a new daily log into an existing array of logs (by date).
 * - If no log exists for that date, push a new one.
 * - If one exists, append meals and recompute total_calories.
 * - Update weight/steps/etc. when new values are provided.
 */
function mergeDailyLog(existingLogs, newLogRaw) {
  const logsArray = Array.isArray(existingLogs) ? existingLogs : [];
  const normalizedNew = normalizeLogForMerging(newLogRaw);

  if (!normalizedNew || !normalizedNew.date) {
    console.warn("mergeDailyLog: incoming log missing a valid date, skipping", newLogRaw);
    return logsArray;
  }

  // Normalize existing logs
  const logs = logsArray.map((l) => normalizeLogForMerging(l)).filter(Boolean);

  const idx = logs.findIndex(
    (l) => normalizeDateString(l.date) === normalizedNew.date
  );

  // If this date doesn't exist yet -> add as new entry
  if (idx === -1) {
    // Ensure total_calories is consistent with its meals
    const totalFromMeals = normalizedNew.meals.reduce((sum, m) => {
      if (!m) return sum;
      const c = Number(m.calories);
      return Number.isFinite(c) ? sum + c : sum;
    }, 0);

    normalizedNew.total_calories =
      normalizedNew.meals.length > 0 && totalFromMeals > 0
        ? totalFromMeals
        : normalizedNew.total_calories ?? null;

    return [...logs, normalizedNew];
  }

  // Merge with existing log for that date
  const existing = logs[idx];

  const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];
  const newMeals = Array.isArray(normalizedNew.meals) ? normalizedNew.meals : [];
  const mergedMeals = [...existingMeals, ...newMeals];

  const mergedTotalCalories = mergedMeals.reduce((sum, m) => {
    if (!m) return sum;
    const c = Number(m.calories);
    return Number.isFinite(c) ? sum + c : sum;
  }, 0);

  const merged = {
    ...existing,
    // keep date from normalizedNew (same YYYY-MM-DD)
    date: normalizedNew.date,
    meals: mergedMeals,
    total_calories:
      mergedMeals.length > 0 && mergedTotalCalories > 0
        ? mergedTotalCalories
        : null,

    // Prefer new weight/steps/calories if provided, otherwise keep existing
    weight:
      normalizedNew.weight !== null && normalizedNew.weight !== undefined
        ? normalizedNew.weight
        : existing.weight ?? null,
    steps:
      normalizedNew.steps !== null && normalizedNew.steps !== undefined
        ? normalizedNew.steps
        : existing.steps ?? null,
    calories:
      normalizedNew.calories !== null && normalizedNew.calories !== undefined
        ? normalizedNew.calories
        : existing.calories ?? null,

    // Mood / struggle: take new if present, else keep old
    mood:
      normalizedNew.mood !== null && normalizedNew.mood !== undefined
        ? normalizedNew.mood
        : existing.mood ?? null,
    struggle:
      normalizedNew.struggle !== null && normalizedNew.struggle !== undefined
        ? normalizedNew.struggle
        : existing.struggle ?? null,

    // coach_focus: prefer the newest non-empty one
    coach_focus:
      (normalizedNew.coach_focus && String(normalizedNew.coach_focus).trim()) ||
      (existing.coach_focus && String(existing.coach_focus).trim()) ||
      "",
  };

  const newLogs = [...logs];
  newLogs[idx] = merged;
  return newLogs;
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
    // If this fails, we'll just treat it as no existing logs
  }

  // ===============================
  // 2) Merge this new log by date
  // ===============================
  const updatedLogs = mergeDailyLog(existingLogs, normalizedIncoming);

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
    {
      ownerId,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(updatedLogs),
    },
  ];

  try {
    const result = await shopifyAdminFetch(METAFIELDS_SET, {
      metafields: metafieldsPayload,
    });

    const userErrors =
      result?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("metafieldsSet userErrors:", userErrors);
      return res.status(500).json({
        ok: false,
        error: "Failed to save daily logs",
        details: userErrors,
      });
    }

    return res.status(200).json({
      ok: true,
      savedDate: logDate,
      logsCount: updatedLogs.length,
    });
  } catch (err) {
    console.error("Error saving daily_logs metafield:", err);
    return res.status(500).json({
      ok: false,
      error: "Error saving daily logs metafield",
    });
  }
}
