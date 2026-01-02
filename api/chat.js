======================================================
NON-NEGOTIABLE OUTPUT RULES (APP DEPENDS ON THIS)
======================================================

1) After EVERY assistant reply, you MUST append ONE hidden block at the VERY END:

[[COACH_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "4–6 sentences describing how the day is going so far (or best guess with limited info).",
  "wins": [],
  "opportunities": [],
  "struggles": [],
  "next_focus": "ONE clear actionable focus for next 24 hours.",
  "food_pattern": "",
  "mindset_pattern": ""
}
]]

2) If the user provides ANY daily check-in data (weight / calories / steps / macros / day summary),
you MUST also append EXACTLY ONE:

[[DAILY_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "weight": null,
  "calories": null,
  "protein_g": null,
  "carbs_g": null,
  "fat_g": null,
  "steps": null,
  "notes": ""
}
]]

3) If the user clearly wants a meal logged (breakfast/lunch/dinner/snacks),
you MUST also append:

[[MEAL_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "meal_type": "Dinner",
  "items": [],
  "calories": 0,
  "protein": 0,
  "carbs": 0,
  "fat": 0
}
]]

4) The date MUST match TODAY_DATE exactly (the system will provide it).
Never output another date format.

5) Never show or explain these JSON blocks in the visible text.


/* ============================
   PJ PLAN VALIDATOR
   ============================ */
function pjPlanIsValid(plan){
  if (!plan || typeof plan !== "object") return false;

  const cal = Number(plan.calories_target ?? plan.calories);
  const startW = Number(plan.start_weight);
  const goalW  = Number(plan.goal_weight);
  const protein = Number(plan.protein_target ?? plan.protein);

  if (!Number.isFinite(cal) || cal < 1000) return false;
  if (!Number.isFinite(startW) || startW <= 0) return false;
  if (!Number.isFinite(goalW)  || goalW  <= 0) return false;
  if (!Number.isFinite(protein) || protein < 50) return false;

  return true;
}


// --- Helper: Shopify GraphQL client (for metafields) ---
async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    throw new Error("Missing Shopify env vars");
  }

  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error("Shopify GraphQL HTTP error:", text);
    throw new Error(`Shopify GraphQL HTTP error: ${text}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    console.error("Shopify GraphQL errors:", json.errors);
    const message = json.errors
      .map(e => e.message || JSON.stringify(e))
      .join(" | ");
    throw new Error(`Shopify GraphQL errors: ${message}`);
  }

  return json.data;
}

// ============================================================
// FREE PREVIEW HELPERS (Step 2A)
// ============================================================

async function getFreeChatRemaining(customerGid) {
  const q = `
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"custom", key:"free_chat_remaining") { value }
      }
    }
  `;
  const json = await shopifyGraphQL(q, { id: customerGid });
  const v = json?.customer?.metafield?.value;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function setFreeChatRemaining(customerGid, remaining) {
  const m = `
    mutation($input: MetafieldsSetInput!) {
      metafieldsSet(metafields: [$input]) {
        userErrors { field message }
      }
    }
  `;
  return shopifyGraphQL(m, {
    input: {
      ownerId: customerGid,
      namespace: "custom",
      key: "free_chat_remaining",
      type: "number_integer",
      value: String(Math.max(0, remaining))
    }
  });
}

// Helper: parse body safely
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    try {
      if (req.body && typeof req.body === "object") {
        return resolve(req.body);
      }
      let data = "";
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error("Invalid JSON body", e);
          resolve({});
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/* ===============================
   HELPERS FOR PLAN SAVING & ID
   =============================== */

// Extract the COACH_PLAN_JSON block and parse the JSON inside
function extractCoachPlanJson(text) {
  if (!text) return null;
  const start = text.indexOf("[[COACH_PLAN_JSON");
  if (start === -1) return null;
  const end = text.indexOf("]]", start);
  if (end === -1) return null;

  const block = text.substring(start, end + 2);
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;

  const jsonString = block.substring(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse COACH_PLAN_JSON:", e, jsonString);
    return null;
  }
}

// Fallback: try to pull calories / protein / fat out of the text bullets
function extractPlanFromText(text) {
  if (!text) return null;

  const calMatch =
    text.match(/daily calorie target[^0-9]*([0-9]{3,4})/i) ||
    text.match(/target is about[^0-9]*([0-9]{3,4})/i) ||
    text.match(/(\d{3,4})\s*(?:calories|cals?|kcals?)/i);

  const proteinMatch =
    text.match(/protein[^0-9]*([0-9]{2,4})\s*g/i) ||
    text.match(/aim for around[^0-9]*([0-9]{2,4})\s*g[^.]*protein/i);

  const fatMatch =
    text.match(/fat[s]?[^0-9]*([0-9]{1,3})\s*g/i) ||
    text.match(/target about[^0-9]*([0-9]{1,3})\s*g[^.]*fat/i);

  const calories = calMatch ? Number(calMatch[1]) : 0;
  const protein  = proteinMatch ? Number(proteinMatch[1]) : 0;
  const fat      = fatMatch ? Number(fatMatch[1]) : 0;

  if (calories && calories < 500) return null;
  if (!calories && !protein && !fat) return null;

  return {
    calories_target: calories || 0,
    protein_target: protein || 0,
    fat_target: fat || 0
  };
}

function finalizePlanJson(planJson) {
  if (!planJson) return null;

  const toNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };

  const caloriesTarget = toNum(planJson.calories_target || planJson.calories);
  const proteinTarget  = toNum(planJson.protein_target || planJson.protein);
  let   fatTarget      = toNum(planJson.fat_target || planJson.fat);
  let   carbs          = toNum(planJson.carbs);

  if (!fatTarget && caloriesTarget) {
    fatTarget = Math.round((caloriesTarget * 0.30) / 9);
  }

  if (!carbs && caloriesTarget && (proteinTarget || fatTarget)) {
    const usedCals   = proteinTarget * 4 + fatTarget * 9;
    const remaining  = caloriesTarget - usedCals;
    if (remaining > 0) carbs = Math.round(remaining / 4);
  }

  const startWeight = planJson.start_weight != null
    ? toNum(planJson.start_weight)
    : planJson.current_weight_lbs != null
      ? toNum(planJson.current_weight_lbs)
      : 0;

  const goalWeight = planJson.goal_weight != null
    ? toNum(planJson.goal_weight)
    : planJson.goal_weight_lbs != null
      ? toNum(planJson.goal_weight_lbs)
      : 0;

  return {
    ...planJson,
    calories_target: caloriesTarget || null,
    protein_target:  proteinTarget  || null,
    fat_target:      fatTarget      || null,
    carbs:           carbs          || null,
    start_weight:    startWeight    || null,
    goal_weight:     goalWeight     || null
  };
}

function stripCoachPlanBlock(text) {
  if (!text) return text;
  return text.replace(/\[\[COACH_PLAN_JSON[\s\S]*?\]\]/, "").trim();
}

async function resolveCustomerGidFromBody(body) {
  let rawId =
    body.customerId ||
    body.shopifyCustomerId ||
    body.customer_id ||
    body.customer_id_raw ||
    null;

  if (rawId) {
    const str = String(rawId);
    if (str.startsWith("gid://shopify/Customer/")) return str;
    const numeric = str.replace(/[^0-9]/g, "");
    if (numeric) return `gid://shopify/Customer/${numeric}`;
  }

  const email = body.email;
  if (!email) return null;

  try {
    const data = await shopifyGraphQL(
      `
      query FindCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node { id email }
          }
        }
      }
      `,
      { query: `email:${email}` }
    );

    const node = data?.customers?.edges?.[0]?.node;
    return node?.id || null;
  } catch (e) {
    console.error("Error resolving customer by email", e);
    return null;
  }
}

async function saveCoachPlanForCustomer(customerGid, planJson) {
  if (!customerGid || !planJson) return;

  planJson = finalizePlanJson(planJson) || planJson;

  const ownerId = customerGid;

  // ================================
  // ✅ LOCK EXISTING START/GOAL (SERVER-SIDE SAFETY)
  // ================================
  let existingPlan = null;
  try {
    const existingData = await shopifyGraphQL(
      `
      query GetExistingPlan($id: ID!) {
        customer(id: $id) {
          metafield(namespace:"custom", key:"coach_plan") { value }
        }
      }
      `,
      { id: ownerId }
    );

    const v = existingData?.customer?.metafield?.value;
    if (v) {
      try { existingPlan = JSON.parse(v); } catch(e) { existingPlan = null; }
    }
  } catch (e) {
    console.warn("[LOCK] Failed to fetch existing coach_plan (continuing):", e?.message || e);
    existingPlan = null;
  }

  const normalizeNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };

  const existingStart =
    normalizeNum(existingPlan?.start_weight_lbs) ??
    normalizeNum(existingPlan?.start_weight) ??
    null;

  const existingGoal =
    normalizeNum(existingPlan?.goal_weight_lbs) ??
    normalizeNum(existingPlan?.goal_weight) ??
    null;

  if (existingStart) {
    planJson.start_weight = existingStart;
    planJson.start_weight_lbs = existingStart;
  }
  if (existingGoal) {
    planJson.goal_weight = existingGoal;
    planJson.goal_weight_lbs = existingGoal;
  }
  // ================================
  // ✅ END LOCK
  // ================================

  const startWeight = planJson.start_weight != null
    ? Number(planJson.start_weight)
    : (planJson.current_weight_lbs != null ? Number(planJson.current_weight_lbs) : 0);

  const goalWeight = planJson.goal_weight != null
    ? Number(planJson.goal_weight)
    : (planJson.goal_weight_lbs != null ? Number(planJson.goal_weight_lbs) : 0);

  const caloriesTarget = Number(planJson.calories_target) || 0;
  const proteinTarget  = Number(planJson.protein_target)  || 0;
  const fatTarget      = Number(planJson.fat_target)      || 0;

  let carbs = Number(planJson.carbs || 0);
  if (!carbs && caloriesTarget && proteinTarget && fatTarget) {
    const remaining = caloriesTarget - (proteinTarget * 4 + fatTarget * 9);
    if (remaining > 0) carbs = Math.round(remaining / 4);
  }

  const coachPlan = {
    ...planJson,
    start_weight: startWeight || planJson.start_weight || null,
    goal_weight: goalWeight || planJson.goal_weight || null,
    carbs
  };

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace type value }
        userErrors { field message }
      }
    }
  `;

  const metafields = [
    {
      ownerId,
      namespace: "custom",
      key: "coach_plan",
      type: "json",
      value: JSON.stringify(coachPlan)
    },
    {
      ownerId,
      namespace: "custom",
      key: "plan_json",
      type: "json",
      value: JSON.stringify(coachPlan)
    },
    {
      ownerId,
      namespace: "custom",
      key: "onboarding_complete",
      type: "single_line_text_field",
      value: "true"
    }
  ];

  if (startWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "start_weight",
      type: "number_integer",
      value: String(Math.round(startWeight))
    });
  }

  if (goalWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "goal_weight",
      type: "number_integer",
      value: String(Math.round(goalWeight))
    });
  }

  const data = await shopifyGraphQL(mutation, { metafields });
  const userErrors = data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    console.error("metafieldsSet userErrors (coach_plan):", userErrors);
    const err = new Error("Shopify userErrors when saving coach_plan/start/goal");
    err.shopifyUserErrors = userErrors;
    throw err;
  }
}

/* ==================================================
   DAILY LOG HELPERS (CALORIES + MEALS/MACROS)
   ================================================== */

function parseDailyCaloriesFromMessage(msg) {
  if (!msg || typeof msg !== "string") return null;
  const text = msg.toLowerCase();

  const mentionsDay =
    text.includes("today") ||
    text.includes("for the day") ||
    text.includes("whole day") ||
    text.includes("all day") ||
    text.includes("the day");

  let m = text.match(/log\s+(?:today|the day)\s+as\s+(\d{3,4})/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n >= 500 && n <= 6000) return n;
  }

  if (mentionsDay) {
    m = text.match(/(\d{3,4})\s*(?:calories|cals?|kcals?)/i);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (n >= 500 && n <= 6000) return n;
    }
  }
  return null;
}

async function getDailyLogsMetafield(customerGid) {
  if (!customerGid) return { logs: [], metafieldId: null };

  const data = await shopifyGraphQL(
    `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "daily_logs") { id value }
      }
    }
    `,
    { id: customerGid }
  );

  const mf = data?.customer?.metafield;
  if (!mf || !mf.value) return { logs: [], metafieldId: null };

  try {
    const parsed = JSON.parse(mf.value);
    if (Array.isArray(parsed)) return { logs: parsed, metafieldId: mf.id || null };
    return { logs: [], metafieldId: mf.id || null };
  } catch (e) {
    console.error("Error parsing daily_logs metafield JSON", e, mf.value);
    return { logs: [], metafieldId: mf.id || null };
  }
}

async function saveDailyLogsMetafield(customerGid, logs) {
  if (!customerGid) return;
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace type value }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      {
        ownerId: customerGid,
        namespace: "custom",
        key: "daily_logs",
        type: "json",
        value: JSON.stringify(logs)
      }
    ]
  };
  const data = await shopifyGraphQL(mutation, variables);
  const userErrors = data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    console.error("metafieldsSet userErrors (daily_logs):", userErrors);
    throw new Error(
      "Shopify userErrors when saving daily_logs: " +
        userErrors.map(e => `${(e.field || []).join(".")}: ${e.message}`).join(" | ")
    );
  }
}

// ✅ FIXED: use dateKey (client-local) — NOT server UTC day
async function upsertDailyTotalCalories(customerGid, calories, dateKey) {
  if (!customerGid || !calories || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);
  const idx = logs.findIndex(entry => entry && entry.date === dateKey);

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date: dateKey,
      calories: calories,
      total_calories: calories,
      coach_focus: existing.coach_focus || "Daily calories logged from chat."
    };
  } else {
    logs.push({
      date: dateKey,
      weight: null,
      steps: null,
      meals: [],
      mood: null,
      struggle: null,
      coach_focus: "Daily calories logged from chat.",
      calories: calories,
      total_calories: calories,
      total_protein: null,
      total_carbs: null,
      total_fat: null
    });
  }

  await saveDailyLogsMetafield(customerGid, logs);
}

function extractDailyLogFromText(text) {
  if (!text) return null;
  const start = text.indexOf("[[DAILY_LOG_JSON");
  if (start === -1) return null;
  const end = text.indexOf("]]", start);
  if (end === -1) return null;

  const block = text.substring(start, end + 2);
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;

  const jsonString = block.substring(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse DAILY_LOG_JSON:", e, jsonString);
    return null;
  }
}

// ✅ FIXED: default date to dateKey, not server UTC
async function upsertDailyLog(customerGid, dailyLog, dateKey) {
  if (!customerGid || !dailyLog || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date =
    (typeof dailyLog.date === "string" && dailyLog.date.trim())
      ? dailyLog.date.trim()
      : dateKey;

  const idx = logs.findIndex(entry => entry && entry.date === date);

  const toNumOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const weight = toNumOrNull(dailyLog.weight);
  const calories = toNumOrNull(dailyLog.calories);
  const protein = toNumOrNull(dailyLog.protein_g);
  const carbs = toNumOrNull(dailyLog.carbs_g);
  const fat = toNumOrNull(dailyLog.fat_g);
  const steps = toNumOrNull(dailyLog.steps);
  const notes =
    typeof dailyLog.notes === "string" && dailyLog.notes.trim()
      ? dailyLog.notes.trim()
      : null;

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date,
      weight: weight !== null ? weight : existing.weight ?? null,
      steps: steps !== null ? steps : existing.steps ?? null,
      calories:
        calories !== null ? calories : existing.calories ?? existing.total_calories ?? null,
      total_calories:
        calories !== null ? calories : existing.total_calories ?? existing.calories ?? null,
      total_protein:
        protein !== null ? protein : existing.total_protein ?? existing.protein ?? null,
      total_carbs:
        carbs !== null ? carbs : existing.total_carbs ?? existing.carbs ?? null,
      total_fat:
        fat !== null ? fat : existing.total_fat ?? existing.fat ?? null,
      meals: Array.isArray(existing.meals) ? existing.meals : [],
      mood: existing.mood ?? null,
      struggle: existing.struggle ?? null,
      coach_focus:
        existing.coach_focus || notes || existing.notes || "Daily check-in logged from chat.",
      notes: notes !== null ? notes : existing.notes ?? null
    };
  } else {
    logs.push({
      date,
      weight,
      steps,
      meals: [],
      mood: null,
      struggle: null,
      coach_focus: notes || "Daily check-in logged from chat.",
      calories,
      total_calories: calories,
      total_protein: protein,
      total_carbs: carbs,
      total_fat: fat,
      notes
    });
  }

  await saveDailyLogsMetafield(customerGid, logs);
}

function extractMealLogsFromText(text) {
  if (!text) return [];
  const results = [];
  let searchIndex = 0;

  while (true) {
    const start = text.indexOf("[[MEAL_LOG_JSON", searchIndex);
    if (start === -1) break;
    const end = text.indexOf("]]", start);
    if (end === -1) break;

    const block = text.substring(start, end + 2);
    const jsonStart = block.indexOf("{");
    const jsonEnd = block.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const jsonString = block.substring(jsonStart, jsonEnd + 1);
      try {
        results.push(JSON.parse(jsonString));
      } catch (e) {
        console.error("Failed to parse MEAL_LOG_JSON:", e, jsonString);
      }
    }
    searchIndex = end + 2;
  }

  return results;
}

function extractDailyReviewFromText(text) {
  if (!text) return null;
  const start = text.indexOf("[[DAILY_REVIEW_JSON");
  if (start === -1) return null;
  const end = text.indexOf("]]", start);
  if (end === -1) return null;

  const block = text.substring(start, end + 2);
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;

  const jsonString = block.substring(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse DAILY_REVIEW_JSON:", e, jsonString);
    return null;
  }
}

function extractCoachReviewFromText(text) {
  if (!text) return null;
  const start = text.indexOf("[[COACH_REVIEW_JSON");
  if (start === -1) return null;
  const end = text.indexOf("]]", start);
  if (end === -1) return null;

  const block = text.substring(start, end + 2);
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;

  const jsonString = block.substring(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse COACH_REVIEW_JSON:", e, jsonString);
    return null;
  }
}

function parseCaloriesFromReplyText(text) {
  if (!text || typeof text !== "string") return null;

  const regex = /(\d{2,4})\s*(?:calories|cals?|kcals?)/gi;
  let match;
  let best = null;

  while ((match = regex.exec(text)) !== null) {
    const n = Number(match[1]);
    if (n > 0 && n < 6000) {
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

function parseCaloriesFromUserText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(\d{2,4})\s*(?:cal(?:ories|s|)?|kcals?)/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n > 0 && n < 6000) return n;
  }
  return null;
}

function parseProteinFromReplyText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(\d{1,3})\s*(?:g|grams?)\s*protein/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n > 0 && n < 300) return n;
  }
  return null;
}

function inferMealTypeFromReply(originalType, replyText) {
  if (!replyText || typeof replyText !== "string") return originalType;
  const lower = replyText.toLowerCase();

  if (/logged as breakfast\b/.test(lower)) return "breakfast";
  if (/logged as lunch\b/.test(lower)) return "lunch";
  if (/logged as dinner\b/.test(lower)) return "dinner";

  return originalType;
}

function detectSimpleMealFromUser(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return null;

  const original = userMsg;
  const text = userMsg.toLowerCase();

  let m = text.match(
    /for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*,?\s+i\s+(?:had|ate)\s+(.*)$/i
  );
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const descLower = m[2] || "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) desc = original.substring(startIndex, startIndex + descLower.length);

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(
    /log\s+this\s+as\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*[:\\-]?\\s*(.*)$/i
  );
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const descLower = m[2] || "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) desc = original.substring(startIndex, startIndex + descLower.length);

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(
    /i\\s+(?:had|ate)\\s+(.*)\\s+for\\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\\b/i
  );
  if (m) {
    const descLower = m[1] || "";
    const mealType = normalizeMealType(m[2]);

    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) desc = original.substring(startIndex, startIndex + descLower.length);

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  // ✅ NEW: "chicken and rice for dinner" (no "I had/ate")
  m = text.match(/^(.*)\\s+for\\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\\b/i);
  if (m) {
    const mealType = normalizeMealType(m[2]);
    let desc = m[1];

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(/i\\s+(?:had|ate)\\s+(.*)$/i);
  if (m) {
    const descLower = m[1] || "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) desc = original.substring(startIndex, startIndex + descLower.length);

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;
    return { meal_type: "snacks", items: [desc] };
  }

  return null;
}

// ✅ FIXED: force meals to save to dateKey (client-local day), not server UTC
async function upsertMealLog(customerGid, meal, dateKey, options = {}) {
  if (!customerGid || !meal) return;

  const cleanDate = isYMD(dateKey) ? dateKey : localYMD();

  const { logs } = await getDailyLogsMetafield(customerGid);
  const idx = logs.findIndex(entry => entry && entry.date === cleanDate);

  const cals = Number(meal.calories) || 0;
  const protein = Number(meal.protein) || 0;
  const carbs = Number(meal.carbs) || 0;
  const fat = Number(meal.fat) || 0;

  const mealType = normalizeMealType(meal.meal_type || "other");

  let items = meal.items;
  if (!Array.isArray(items)) {
    if (typeof items === "string" && items.trim()) items = [items.trim()];
    else items = [];
  }

  const replaceMealType = options.replaceMealType || null;

  if (idx >= 0) {
    const existing = logs[idx] || {};
    const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];

    let baseMeals = existingMeals;
    if (replaceMealType && mealType === replaceMealType) {
      baseMeals = existingMeals.filter(m => !m || normalizeMealType(m.meal_type) !== replaceMealType);
    }

    const newMeal = { meal_type: mealType, items, calories: cals, protein, carbs, fat };
    const updatedMeals = baseMeals.concat([newMeal]);

    let sumCals = 0, sumP = 0, sumC = 0, sumF = 0;
    updatedMeals.forEach(m => {
      sumCals += Number(m.calories) || 0;
      sumP += Number(m.protein) || 0;
      sumC += Number(m.carbs) || 0;
      sumF += Number(m.fat) || 0;
    });

    logs[idx] = {
      ...existing,
      date: cleanDate,
      meals: updatedMeals,
      total_calories: sumCals,
      calories: sumCals,
      total_protein: sumP,
      total_carbs: sumC,
      total_fat: sumF,
      coach_focus: existing.coach_focus || "Meals logged from chat."
    };
  } else {
    const newMeals = [{ meal_type: mealType, items, calories: cals, protein, carbs, fat }];

    logs.push({
      date: cleanDate,
      weight: null,
      steps: null,
      meals: newMeals,
      mood: null,
      struggle: null,
      coach_focus: "Meals logged from chat.",
      calories: cals || null,
      total_calories: cals || null,
      total_protein: protein || null,
      total_carbs: carbs || null,
      total_fat: fat || null
    });
  }

  await saveDailyLogsMetafield(customerGid, logs);
}

// ✅ FIXED: use dateKey
async function upsertDailyReview(customerGid, review, dateKey) {
  if (!customerGid || !review || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date =
    (review.date && typeof review.date === "string" && review.date.trim())
      ? review.date.trim()
      : dateKey;

  const summary =
    typeof review.summary === "string" && review.summary.trim()
      ? review.summary.trim()
      : "Keep it simple: hit your calories as best you can, move a bit, and log it honestly.";

  const riskColor = review.risk_color || "green";
  const needsHumanReview = !!review.needs_human_review;

  const idx = logs.findIndex(entry => entry && entry.date === date);

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date,
      coach_focus: summary,
      risk_color: riskColor,
      needs_human_review: needsHumanReview
    };
  } else {
    logs.push({
      date,
      weight: null,
      steps: null,
      meals: [],
      mood: null,
      struggle: null,
      coach_focus: summary,
      calories: null,
      total_calories: null,
      total_protein: null,
      total_carbs: null,
      total_fat: null,
      risk_color: riskColor,
      needs_human_review: needsHumanReview
    });
  }

  await saveDailyLogsMetafield(customerGid, logs);
}

// ✅ FIXED: use dateKey (never server UTC)
async function upsertCoachReview(customerGid, coachReview, dateKey) {
  if (!customerGid || !coachReview || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date =
    (typeof coachReview.date === "string" && coachReview.date.trim())
      ? coachReview.date.trim()
      : dateKey;

  const idx = logs.findIndex(entry => entry && entry.date === date);

  const safeArr = (v) => Array.isArray(v) ? v : [];
  const safeStr = (v) => (typeof v === "string" ? v.trim() : "");

  const payload = {
    coach_review: {
      date,
      summary: safeStr(coachReview.summary),
      wins: safeArr(coachReview.wins),
      opportunities: safeArr(coachReview.opportunities),
      struggles: safeArr(coachReview.struggles),
      next_focus: safeStr(coachReview.next_focus),
      food_pattern: safeStr(coachReview.food_pattern),
      mindset_pattern: safeStr(coachReview.mindset_pattern)
    }
  };

  if (idx >= 0) {
    const existing = logs[idx] || {};
    const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];
    logs[idx] = { ...existing, date, meals: existingMeals, ...payload };
  } else {
    logs.push({
      date,
      weight: null,
      steps: null,
      meals: [],
      mood: null,
      struggle: null,
      coach_focus: null,
      calories: null,
      total_calories: null,
      total_protein: null,
      total_carbs: null,
      total_fat: null,
      ...payload
    });
  }

  await saveDailyLogsMetafield(customerGid, logs);
}

/* ==========================================
   MEAL OVERRIDE DETECTOR ("change breakfast")
   ========================================== */

function normalizeMealType(raw) {
  const t = (raw || "").toLowerCase().trim();
  if (t === "bfast" || t === "breakfast") return "breakfast";
  if (t === "lunch") return "lunch";
  if (t === "dinner" || t === "supper") return "dinner";
  if (t === "snack" || t === "snacks" || t === "snaks" || t === "dessert") return "snacks";
  return raw || "other";
}

function detectMealOverride(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return null;
  const text = userMsg.toLowerCase();

  const pattern = /(change|replace|swap|edit|make)\s+(?:my\s+)?(breakfast|bfast|lunch|dinner|supper|snack|snacks|snaks|dessert)\b/i;
  const match = text.match(pattern);
  if (!match) return null;

  const mealType = normalizeMealType(match[2]);

  const descStart = match.index + match[0].length;
  let itemText = userMsg.slice(descStart);

  itemText = itemText.replace(/^\s*(to|with|for)\b/i, "");
  itemText = itemText.trim().replace(/^[:\-–]/, "").trim();

  if (!itemText || !itemText.length) return null;

  return {
    meal_type: mealType,
    items: [itemText],
    calories: null,
    protein: null,
    carbs: null,
    fat: null
  };
}

function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// NOTE: keep this as fallback only; we prefer clientDate always
function localYMD() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // ===== CORS FOR PJIFITNESS =====
  const origin = req.headers.origin || "";

  const ALLOWED_ORIGINS = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com",
  ]);

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
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
  // ===== END CORS =====

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error("Error parsing body", e);
    res.status(400).json({
      error: "Invalid request body",
      debug: { parseError: String(e?.message || e) }
    });
    return;
  }

  // ===============================
  // ✅ PJ DATE SOURCE OF TRUTH (CLIENT LOCAL DATE)
  // ===============================
  const clientDate = body?.clientDate;
  const dateKey = isYMD(clientDate) ? clientDate : localYMD();

  const userMessage = body.message || "";
  const history = Array.isArray(body.history) ? body.history : [];
  const appendUserMessage = !!body.appendUserMessage;
  const email = body.email || null;

  if (!userMessage && !history.length) {
    res.status(400).json({ error: "Missing 'message' in body" });
    return;
  }

  let customerGid = null;
  let customerNumericId = null;

  let rawId =
    body.customerId ||
    body.shopifyCustomerId ||
    body.customer_id ||
    body.customer_id_raw ||
    null;

  if (rawId != null) {
    const str = String(rawId);
    const numeric = str.replace(/[^0-9]/g, "");
    if (numeric) {
      customerNumericId = numeric;
      customerGid = `gid://shopify/Customer/${numeric}`;
    }
  }

  if (!customerGid && (body.customerGid || body.customer_gid)) {
    const rawGid = String(body.customerGid || body.customer_gid);
    if (rawGid.startsWith("gid://shopify/Customer/")) {
      customerGid = rawGid;
      const numeric = rawGid.replace("gid://shopify/Customer/", "");
      if (numeric) customerNumericId = numeric;
    } else {
      const numeric = rawGid.replace(/[^0-9]/g, "");
      if (numeric) {
        customerNumericId = numeric;
        customerGid = `gid://shopify/Customer/${numeric}`;
      }
    }
  }

  if (!customerGid && email) {
    try {
      const resolved = await resolveCustomerGidFromBody({ email });
      if (resolved) {
        customerGid = resolved;
        const numeric = String(resolved).replace("gid://shopify/Customer/", "");
        if (numeric) customerNumericId = numeric;
      }
    } catch (e) {
      console.error("Error resolving customerGid from email", e);
    }
  }

  let shopifyMetafieldReadStatus = "not_attempted";
  let onboardingComplete = null;

  if (customerGid) {
    try {
      shopifyMetafieldReadStatus = "fetching";
      const data = await shopifyGraphQL(
        `
        query GetCustomerOnboarding($id: ID!) {
          customer(id: $id) {
            metafield(namespace: "custom", key: "onboarding_complete") { value }
          }
        }
        `,
        { id: customerGid }
      );
      const val = data?.customer?.metafield?.value;
      if (typeof val === "string") {
        onboardingComplete = val === "true";
        shopifyMetafieldReadStatus = "success";
      } else {
        shopifyMetafieldReadStatus = "no_metafield";
      }
    } catch (e) {
      console.error("Error fetching onboarding_complete metafield", e);
      shopifyMetafieldReadStatus = "error";
    }
  } else {
    shopifyMetafieldReadStatus = "no_customer_id";
  }

  const debug = {
    customerGid: customerGid || null,
    customerIdNumeric: customerNumericId,
    inboundMessage: userMessage,
    historyCount: history.length,
    appendUserMessage,
    onboarding_complete: onboardingComplete,
    shopifyMetafieldReadStatus,
    dateKey,
    clientDate: clientDate || null,
    messagesCount: null,
    model: "gpt-4.1-mini",
  };

  // ===============================
  // FREE PREVIEW MESSAGE GATE
  // ===============================
  let remainingAfter = null;
  const FREE_START = 30;

  // ✅ FIXED: use parsed body (not req.body)
  const isSubscriber = body?.isSubscriber === true;

  try {
    if (customerGid) {
      if (isSubscriber) {
        remainingAfter = 999999;
      } else {
        let remaining = await getFreeChatRemaining(customerGid);

        if (remaining === null) {
          remaining = FREE_START;
          await setFreeChatRemaining(customerGid, remaining);
        }

        if (remaining <= 0) {
          return res.status(200).json({
            reply: "[[PAYWALL]]",
            free_chat_remaining: 0,
            debug: { ...debug, free_chat_remaining: 0, isSubscriber },
          });
        }

        remainingAfter = remaining - 1;
        await setFreeChatRemaining(customerGid, remainingAfter);
      }
    }
  } catch (err) {
    console.warn("Free-preview gate failed open:", err);
    remainingAfter = null;
  }

  // DAILY TOTAL CALORIES FROM USER MESSAGE
  if (customerGid && userMessage) {
    const parsedDailyCals = parseDailyCaloriesFromMessage(userMessage);
    if (parsedDailyCals) {
      debug.parsedDailyCalories = parsedDailyCals;
      try {
        await upsertDailyTotalCalories(customerGid, parsedDailyCals, dateKey);
        debug.dailyCaloriesSavedToDailyLogs = true;
      } catch (e) {
        console.error("Error saving daily total calories from chat", e);
        debug.dailyCaloriesSavedToDailyLogs = false;
        debug.dailyCaloriesSaveError = String(e?.message || e);
      }
    }
  }

  const overrideMeal = detectMealOverride(userMessage);
  if (overrideMeal) debug.mealOverrideDetected = overrideMeal;

  let introAlreadySent = false;
  if (history.length) {
    const recentForIntro = history.slice(-40);
    for (const m of recentForIntro) {
      if (!m) continue;
      const text =
        typeof m.text === "string" ? m.text :
        typeof m.message === "string" ? m.message :
        typeof m.content === "string" ? m.content : null;
      if (!text) continue;

      const lower = text.toLowerCase();
      if (lower.includes("i’m your pjifitness coach") || lower.includes("i'm your pjifitness coach")) {
        introAlreadySent = true;
        break;
      }
    }
  }
  debug.introAlreadySent = introAlreadySent;

  // BUILD MESSAGES FOR OPENAI
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  messages.push({
    role: "system",
    content:
      `TODAY_DATE: ${dateKey}. ` +
      `Use this exact date in all JSON blocks: ` +
      `DAILY_LOG_JSON, MEAL_LOG_JSON, DAILY_REVIEW_JSON, COACH_REVIEW_JSON. ` +
      `Do NOT output any other date.`
  });

  messages.push({
    role: "system",
    content: `custom.onboarding_complete: ${onboardingComplete === true ? "true" : "false"}`
  });

  if (introAlreadySent) {
    messages.push({
      role: "system",
      content:
        "SYSTEM_FLAG: INTRO_ALREADY_SENT = true. You have already sent your onboarding intro earlier in this conversation. Do NOT repeat your intro again. Treat the user's latest message as their answer (likely their name, weight, etc.) and continue the onboarding questions from where you left off."
    });
  }

  if (overrideMeal) {
    messages.push({
      role: "system",
      content: `USER_REQUEST_OVERRIDE_MEAL: ${JSON.stringify(overrideMeal)}`
    });
  }

  if (history.length) {
    const recent = history.slice(-20);
    for (const m of recent) {
      if (!m) continue;
      const text =
        typeof m.text === "string" ? m.text :
        typeof m.message === "string" ? m.message :
        typeof m.content === "string" ? m.content : null;
      if (!text) continue;

      let role;
      if (m.role === "user") role = "user";
      else if (m.role === "coach" || m.role === "assistant") role = "assistant";
      else continue;

      messages.push({ role, content: text });
    }
  }

  if (appendUserMessage && userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

  debug.messagesCount = messages.length;

  messages.push({
    role: "system",
    content:
      "CRITICAL: You MUST end your response with exactly one [[COACH_REVIEW_JSON {..} ]] block. If you do not include it, the app will treat your response as invalid. Output it even if you have little info (use empty arrays and generic summary)."
  });

  debug.messagesCount = messages.length;

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages,
        temperature: 0.7
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI error:", errText);
      debug.openaiError = errText;
      res.status(500).json({ error: "OpenAI API error", debug });
      return;
    }

    const data = await openaiRes.json();
    const rawReply =
      data.choices?.[0]?.message?.content ||
      "Sorry, I’m not sure what to say to that.";

    // DAILY_LOG_JSON -> save to daily_logs
    if (customerGid) {
      const dailyLog = extractDailyLogFromText(rawReply);
      if (dailyLog) {
        debug.dailyLogFound = dailyLog;
        try {
          await upsertDailyLog(customerGid, dailyLog, dateKey);
          debug.dailyLogSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving DAILY_LOG_JSON to daily_logs", e);
          debug.dailyLogSavedToDailyLogs = false;
          debug.dailyLogSaveError = String(e?.message || e);
        }
      }
    }

    debug.rawReplyHasCoachReview = rawReply.includes("[[COACH_REVIEW_JSON");
    debug.rawReplyTail = rawReply.slice(-600);
    debug.modelReplyTruncated = !data.choices?.[0]?.message?.content;

    let planJson = null;
    let planSource = null;

    const blockPlan = extractCoachPlanJson(rawReply);
    debug.planBlockFound = !!blockPlan;
    if (blockPlan) {
      planJson = blockPlan;
      planSource = "block";
    }

    // ✅ SAFETY: never derive/save plan from normal text
    debug.planFromText = false;

    if (planJson) {
      debug.planJson = planJson;
      debug.planSource = planSource;

      let shouldSave = false;
      let skipReason = null;

      if (!customerGid) {
        shouldSave = false;
        skipReason = "no_customer_id";
      } else if (planSource === "block") {
        shouldSave = true;
      } else {
        if (onboardingComplete === false || onboardingComplete === null) {
          shouldSave = true;
        } else {
          shouldSave = false;
          skipReason = "onboarding_already_complete_text_plan";
        }
      }

      if (shouldSave) {
        try {
          await saveCoachPlanForCustomer(customerGid, planJson);
          debug.planSavedToShopify = true;
          onboardingComplete = true;
          debug.onboardingCompleteAfterSave = true;

          // ✅ ONBOARDING FINALIZATION: Write TODAY'S weight = CURRENT onboarding weight
          const cw =
            planJson?.current_weight_lbs ??
            planJson?.current_weight ??
            planJson?.start_weight_lbs ??
            planJson?.start_weight;

          if (customerGid && onboardingComplete === true && cw != null) {
            try {
              const currentW = Number(cw);
              if (Number.isFinite(currentW) && currentW > 0) {
                await upsertDailyLog(
                  customerGid,
                  {
                    date: dateKey,
                    weight: currentW,
                    calories: null,
                    protein_g: null,
                    carbs_g: null,
                    fat_g: null,
                    steps: null,
                    notes: "Initial weight from onboarding."
                  },
                  dateKey
                );

                debug.onboardingInitialWeightWritten = currentW;
              }
            } catch (e) {
              console.error("Failed to write onboarding initial daily weight", e);
              debug.onboardingInitialWeightError = String(e?.message || e);
            }
          }

        } catch (e) {
          console.error("Error saving coach_plan metafield", e);
          debug.planSavedToShopify = false;
          debug.planSaveError = String(e?.message || e);
          if (e && e.shopifyUserErrors) debug.planSaveUserErrors = e.shopifyUserErrors;
        }
      } else {
        debug.planSavedToShopify = false;
        debug.planSavedSkippedReason = skipReason;
      }
    }

    // MEAL LOGS
    if (customerGid) {
      const mealLogs = extractMealLogsFromText(rawReply);
      console.log("[PJ DEBUG] extractMealLogsFromText:", mealLogs);

      if (mealLogs && mealLogs.length) {
        debug.mealLogsFound = mealLogs.length;
        debug.mealLogsSample = mealLogs.slice(0, 2);
        try {
          for (const meal of mealLogs) {
            await upsertMealLog(
              customerGid,
              meal,
              dateKey,
              overrideMeal ? { replaceMealType: overrideMeal.meal_type } : {}
            );
          }
          debug.mealLogsSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving meal logs from chat", e);
          debug.mealLogsSavedToDailyLogs = false;
          debug.mealLogsSaveError = String(e?.message || e);
        }
      } else if (detectSimpleMealFromUser(userMessage)) {
        debug.mealLogsFound = 1;
        debug.mealLogsFallbackUsed = true;

        const simpleMeal = detectSimpleMealFromUser(userMessage);
        const calFromUser = parseCaloriesFromUserText(userMessage);
        const calFromReply = parseCaloriesFromReplyText(rawReply);
        const cal = calFromUser || calFromReply || 0;

        const prot = parseProteinFromReplyText(rawReply) || 0;
        const finalMealType = inferMealTypeFromReply(simpleMeal.meal_type, rawReply);

        const fallbackMeal = {
          date: dateKey,
          meal_type: finalMealType,
          items: simpleMeal.items,
          calories: cal,
          protein: prot,
          carbs: 0,
          fat: 0
        };

        try {
          await upsertMealLog(
            customerGid,
            fallbackMeal,
            dateKey,
            overrideMeal ? { replaceMealType: finalMealType } : {}
          );
          debug.mealLogsSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving fallback meal log from chat", e);
          debug.mealLogsSavedToDailyLogs = false;
          debug.mealLogsSaveError = String(e?.message || e);
        }
      } else {
        debug.mealLogsFound = 0;
      }
    }

    // DAILY_REVIEW_JSON
    if (customerGid) {
      const dailyReview = extractDailyReviewFromText(rawReply);
      if (dailyReview) {
        debug.dailyReviewFound = dailyReview;
        try {
          await upsertDailyReview(customerGid, dailyReview, dateKey);
          debug.dailyReviewSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving daily review from chat", e);
          debug.dailyReviewSavedToDailyLogs = false;
          debug.dailyReviewSaveError = String(e?.message || e);
        }
      }
    }

    // COACH_REVIEW_JSON
    if (customerGid) {
      const coachReview = extractCoachReviewFromText(rawReply);
      if (coachReview) {
        debug.coachReviewFound = coachReview;
        try {
          coachReview.date = dateKey;
          await upsertCoachReview(customerGid, coachReview, dateKey);
          debug.coachReviewSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving coach review from chat", e);
          debug.coachReviewSavedToDailyLogs = false;
          debug.coachReviewSaveError = String(e?.message || e);
        }
      }
    }

    let cleanedReply = stripCoachPlanBlock(rawReply);
    cleanedReply = cleanedReply.replace(/\[\[DAILY_LOG_JSON[\s\S]*?\]\]/g, "").trim();
    cleanedReply = cleanedReply.replace(/\[\[MEAL_LOG_JSON[\s\S]*?\]\]/g, "").trim();
    cleanedReply = cleanedReply.replace(/\[\[DAILY_REVIEW_JSON[\s\S]*?\]\]/g, "").trim();
    cleanedReply = cleanedReply.replace(/\[\[COACH_REVIEW_JSON[\s\S]*?\]\]/g, "").trim();

    res.status(200).json({
      reply: cleanedReply,
      debug,
      free_chat_remaining: remainingAfter,
    });
  } catch (e) {
    console.error("Chat handler error", e);
    const debugError = { ...debug, serverError: String(e?.message || e) };
    res.status(500).json({ error: "Server error", debug: debugError });
  }
}
