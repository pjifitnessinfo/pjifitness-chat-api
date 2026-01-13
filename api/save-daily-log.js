// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

/**
 * Date helpers (clientDate preferred; fallback server-local; NOT UTC)
 */
function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function localYMD() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function safeStr(x) {
  return x == null ? "" : String(x);
}

/**
 * Shopify Admin GraphQL
 */
async function shopifyAdminFetch(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_TOKEN) {
    throw new Error("Missing Shopify env vars");
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    const err = new Error("Shopify GraphQL error");
    err.shopifyResponse = json;
    throw err;
  }
  return json.data;
}

/**
 * Build absolute URL to our API on Vercel
 */
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Optional: call /api/nutrition ONLY when explicitly asked
 * Never throws: returns null on failure.
 */
async function callNutrition(req, { text, customerId }) {
  try {
    const baseUrl = getBaseUrl(req);
    const r = await fetch(`${baseUrl}/api/nutrition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, customerId }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) return null;
    return j;
  } catch (e) {
    console.error("[save-daily-log] callNutrition failed:", e);
    return null;
  }
}

/**
 * Normalize a meal object into canonical macros:
 * - calories
 * - protein_g
 * - carbs_g
 * - fat_g
 *
 * Accepts legacy fields protein/carbs/fat as well.
 */
function normalizeMeal(meal) {
  if (!meal || typeof meal !== "object") return null;

  const m = { ...meal };

  // Canonical id (helps later for edits/deletes)
  if (!m.id) {
    m.id = `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  // Canonical text
  if (!m.text) {
    m.text =
      (typeof m.description === "string" && m.description.trim()) ||
      (typeof m.name === "string" && m.name.trim()) ||
      (typeof m.items_text === "string" && m.items_text.trim()) ||
      "";
  }

  // Normalize calories
  if (m.calories == null) m.calories = null;
  m.calories = num(m.calories);

  // Normalize macros to *_g
  const p = m.protein_g != null ? m.protein_g : m.protein;
  const c = m.carbs_g != null ? m.carbs_g : m.carbs;
  const f = m.fat_g != null ? m.fat_g : m.fat;

  m.protein_g = num(p) ?? null;
  m.carbs_g = num(c) ?? null;
  m.fat_g = num(f) ?? null;

  // Remove ambiguous duplicates (optional, but keeps data clean)
  delete m.protein;
  delete m.carbs;
  delete m.fat;

  // Default meal_type
  if (!m.meal_type && typeof m.type === "string") m.meal_type = m.type;
  if (!m.meal_type) m.meal_type = "meal";

  // Ensure strings are safe
  if (m.meal_type) m.meal_type = safeStr(m.meal_type).toLowerCase();

  return m;
}

/**
 * Compute totals from canonical meal macros
 */
function computeTotalsFromMeals(meals) {
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  if (!Array.isArray(meals)) return totals;

  for (const meal of meals) {
    totals.calories += Number(meal?.calories || 0);
    totals.protein_g += Number(meal?.protein_g || 0);
    totals.carbs_g += Number(meal?.carbs_g || 0);
    totals.fat_g += Number(meal?.fat_g || 0);
  }
  return totals;
}

/**
 * Sanitize log fields. Forces date to dateKey.
 */
function sanitizeLog(raw, dateKey) {
  if (!raw || typeof raw !== "object") return null;

  const SAFE_FIELDS = [
    "date",
    "weight",
    "steps",
    "mood",
    "struggle",
    "coach_focus",
    "calorie_target",
    "notes",
    "risk_color",
    "needs_human_review",
    "coach_review",

    // totals (we will overwrite from meals when meals present)
    "calories",
    "total_calories",
    "total_protein",
    "total_carbs",
    "total_fat",

    // meals
    "meals",
  ];

  const clean = {};
  for (const key of SAFE_FIELDS) {
    if (raw[key] !== undefined) clean[key] = raw[key];
  }

  clean.date = isYMD(dateKey) ? dateKey : localYMD();

  if (clean.meals !== undefined && !Array.isArray(clean.meals)) {
    clean.meals = [];
  }

  return clean;
}

/**
 * Parse body safely
 */
function parseBody(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string") return JSON.parse(req.body);
  } catch (e) {}
  return {};
}

export default async function handler(req, res) {
  // ===== CORS =====
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = [
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com",
  ];

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Content-Type, Authorization, X-Requested-With, Accept"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // ===== END CORS =====

  const body = parseBody(req);

  const customerIdRaw = body?.customerId ?? body?.shopifyCustomerId ?? body?.customer_id;
  const clientDate = body?.clientDate;

  if (!customerIdRaw) {
    return res.status(400).json({ error: "Missing customerId" });
  }

  const customerId = String(customerIdRaw).replace(/[^0-9]/g, "");
  if (!customerId) {
    return res.status(400).json({ error: "Invalid customerId" });
  }

  const customerGid = `gid://shopify/Customer/${customerId}`;
  const dateKey = isYMD(clientDate) ? clientDate : localYMD();

  // New: action routing
  const action = safeStr(body?.action || "merge_log").toLowerCase();
  const estimateIfMissing = body?.estimateIfMissing === true;

  // Accept either:
  // - merge_log: { log: {...} }
  // - add_meal: { meal: {...} } OR { mealText: "..." }
  // - replace_meals: { meals: [...] }
  const rawLog = body?.log && typeof body.log === "object" ? body.log : {};
  const safeLog = sanitizeLog(rawLog, dateKey) || { date: dateKey };

  // 1) Read existing daily_logs metafield
  const GET_LOGS_QUERY = `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        id
        metafield(namespace: "custom", key: "daily_logs") {
          id
          value
        }
      }
    }
  `;

  let existingLogs = [];
  try {
    const data = await shopifyAdminFetch(GET_LOGS_QUERY, { id: customerGid });
    const mf = data?.customer?.metafield;
    if (mf?.value) {
      const parsed = JSON.parse(mf.value);
      if (Array.isArray(parsed)) existingLogs = parsed;
    }
  } catch (err) {
    console.error("Error fetching existing daily_logs:", err);
  }

  // 2) Upsert by date
  const dateStr = safeLog.date;
  const updatedLogs = Array.isArray(existingLogs) ? [...existingLogs] : [];
  const foundIndex = updatedLogs.findIndex((l) => l && l.date === dateStr);

  const existing = foundIndex >= 0 ? (updatedLogs[foundIndex] || {}) : {};
  const merged = { ...existing, ...safeLog, date: dateStr };

  // Ensure meals array exists if present previously
  if (!Array.isArray(merged.meals)) {
    merged.meals = Array.isArray(existing.meals) ? existing.meals : [];
  }

  // --- ACTION HANDLERS ---
  if (action === "replace_meals") {
    const incomingMeals = Array.isArray(body?.meals) ? body.meals : [];
    merged.meals = incomingMeals.map(normalizeMeal).filter(Boolean);

  } else if (action === "add_meal") {
    let mealObj = body?.meal && typeof body.meal === "object" ? body.meal : null;

    // Allow shortcut: { mealText: "..." }
    if (!mealObj && typeof body?.mealText === "string") {
      mealObj = { text: body.mealText };
    }

    // Normalize
    let m = normalizeMeal(mealObj);
    if (!m) {
      return res.status(400).json({ error: "Missing meal payload" });
    }

    // Optional estimation if macros missing
    const macrosMissing =
      m.calories == null || m.protein_g == null || m.carbs_g == null || m.fat_g == null;

    if (estimateIfMissing && macrosMissing && m.text) {
      const nut = await callNutrition(req, { text: m.text, customerId });
      if (nut?.totals) {
        m.nutrition = {
          items: Array.isArray(nut.items) ? nut.items : [],
          totals: nut.totals || null,
          needs_clarification: Array.isArray(nut.needs_clarification) ? nut.needs_clarification : [],
        };
        m.calories = num(nut.totals.calories) ?? m.calories;
        m.protein_g = num(nut.totals.protein) ?? m.protein_g;
        m.carbs_g = num(nut.totals.carbs) ?? m.carbs_g;
        m.fat_g = num(nut.totals.fat) ?? m.fat_g;
      }
    }

    merged.meals = Array.isArray(merged.meals) ? merged.meals : [];
    merged.meals.push(m);

  } else {
    // merge_log (default): if caller included meals explicitly, replace them
    if (body?.log && body.log.meals !== undefined) {
      const incomingMeals = Array.isArray(body.log.meals) ? body.log.meals : [];
      merged.meals = incomingMeals.map(normalizeMeal).filter(Boolean);
    }
  }

  // Recompute totals from meals (if meals exist)
  if (Array.isArray(merged.meals)) {
    const totals = computeTotalsFromMeals(merged.meals);
    merged.total_calories = totals.calories;
    merged.calories = totals.calories;
    merged.total_protein = totals.protein_g;
    merged.total_carbs = totals.carbs_g;
    merged.total_fat = totals.fat_g;
  }

  if (foundIndex >= 0) {
    updatedLogs[foundIndex] = merged;
  } else {
    updatedLogs.push(merged);
  }

  // Optional cap
  const MAX_LOGS = 365;
  const trimmedLogs =
    updatedLogs.length > MAX_LOGS
      ? updatedLogs.slice(updatedLogs.length - MAX_LOGS)
      : updatedLogs;

  // 3) Write back
  const SET_LOGS_MUTATION = `
    mutation SaveDailyLogs($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace }
        userErrors { field message }
      }
    }
  `;

  const metafieldsInput = [
    {
      ownerId: customerGid,
      namespace: "custom",
      key: "daily_logs",
      type: "json",
      value: JSON.stringify(trimmedLogs),
    },
  ];

  try {
    const result = await shopifyAdminFetch(SET_LOGS_MUTATION, { metafields: metafieldsInput });
    const errors = result?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      console.error("Shopify metafieldsSet errors:", errors);
      return res.status(500).json({ error: "Failed to save daily_logs", details: errors });
    }
  } catch (err) {
    console.error("Error saving daily_logs metafield:", err);
    return res.status(500).json({
      error: "Error saving daily_logs",
      details: err.shopifyResponse || err.message || String(err),
    });
  }

  return res.status(200).json({
    ok: true,
    action,
    dateKey,
    log: merged,
    totals: {
      calories: merged.total_calories || 0,
      protein_g: merged.total_protein || 0,
      carbs_g: merged.total_carbs || 0,
      fat_g: merged.total_fat || 0,
    },
  });
}
