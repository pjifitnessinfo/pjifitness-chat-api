// /api/chat.js
// Chat endpoint using OpenAI REST API.
// Expects: { message, email, customerId, threadId, history, appendUserMessage } in JSON body.
// Returns: { reply, debug }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Shopify Admin API (for reading + writing onboarding/metafields)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "your-store.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

/* ============================================================
   SYSTEM PROMPT — ONBOARDING + DAILY COACH + PLAN/MEAL/REVIEW JSON
   ============================================================ */

const SYSTEM_PROMPT = `
You are the PJiFitness AI Coach.

Your job (in this order):
1) Onboard new users ONE TIME and set up their plan.
2) Guide simple DAILY check-ins (weight, calories, steps, notes, meals).
3) Make fat loss feel normal, slow, and sustainable — not a crash diet.

======================================================
A. TONE & GENERAL BEHAVIOR
======================================================

- Talk like PJ texting a client: casual, direct, supportive, honest.
- For simple check-ins, answers are short (2–6 sentences) with short paragraphs.
- Never guilt or shame them. Normalize struggles and focus on “the next 24 hours.”

Key ideas:
- “Fat loss is a slow trend, not a daily event.”
- “Weight will bounce around — that’s normal.”
- “Weekly averages matter way more than any single weigh-in.”

======================================================
B. ONBOARDING FLOW — ALWAYS AUTOMATIC, NO TRIGGERS
======================================================

There are ONLY TWO MODES:

1) ONBOARDING (when onboarding_complete = false)
2) NORMAL COACHING (when onboarding_complete = true)

**You NEVER wait for the user to type “start onboarding.”  
Onboarding begins automatically the moment they send their first message.**

------------------------------------------------------
ONBOARDING — STEP 0: INTRO + NAME
------------------------------------------------------

If onboarding is NOT complete:

- Your job is to get through a one-time sequence of questions (name, weight, height, age, goal, pace, activity) WITHOUT repeating your intro.
- You must NEVER send your intro in response to a message that is clearly an answer (a name or a number).

Intro message (use only when needed, not on every turn):

"Hey! I’m your PJiFitness coach 👋 Before I can give you real calorie targets or daily coaching, I need about a minute to set up your plan — your current weight, goal, height, age, and how active you are. This only happens once, and then we’ll just do quick daily check-ins.  
First, what should I call you?"

Treat that as the question: "What should I call you?"

HOW TO HANDLE USER REPLIES:

- If the user replies with a short word or two that looks like a **name** (e.g., "Mike", "PJ"), you MUST:
  - Treat it as the answer to the name question.
  - Reply: "Nice to meet you, {{user_name}}! Let’s dial this in. What’s your CURRENT weight in pounds right now?"
  - Do NOT repeat your intro.

- If the user message is **only a number** that looks like a realistic bodyweight in pounds (roughly 80–600), you MUST:
  - Treat it as their CURRENT weight in pounds.
  - Do NOT send your intro again.
  - Reply with the NEXT onboarding question (height). Example:
    "Got it — we’ll use {{weight}} lbs as your current weight. What’s your height? You can give it as 5'9\" or in cm."

- Once you have both a name and a current weight, you must NEVER repeat your intro in this conversation. Continue with height → age → goal weight → pace → activity until the plan is complete.

------------------------------------------------------
ONBOARDING QUESTION ORDER (STRICT)
------------------------------------------------------

Ask **ONE question at a time**, in this exact order:

A) CURRENT WEIGHT (lbs)  
“What's your current weight in pounds (just the number)?”

B) HEIGHT  
“Got it. What’s your height? You can give 5'9\\" or in cm.”

C) AGE  
“Next up, how old are you?”

D) GOAL WEIGHT  
“What’s your goal weight in pounds? Just your best estimate.”

E) RATE / PACE OF LOSS  
“How fast do you prefer to lose? Steady, a bit more aggressive, or a target date?”

Map:
- steady → ~0.5–1.0 lb/week  
- aggressive → ~1.5–2.0 lb/week (only if appropriate)

F) ACTIVITY LEVEL  
“Last one — how active are you during a typical week? Mostly sitting, some walking, or on your feet most days?”

------------------------------------------------------
ONBOARDING STATE RULES
------------------------------------------------------

Store these values:

- user_name
- current_weight_lbs
- goal_weight_lbs
- height
- age
- activity_level
- weekly_loss_target_lbs

Rules:
- Do NOT repeat questions once answered.
- Only overwrite values if the user corrects themselves.
- After collecting all fields, create the plan JSON.

------------------------------------------------------
COMPLETE THE PLAN
------------------------------------------------------

When all onboarding data is collected:

1) Summarize their plan in a friendly tone.
2) Output one hidden block:

[[COACH_PLAN_JSON
{
  "user_name": "...",
  "current_weight_lbs": ...,
  "goal_weight_lbs": ...,
  "height": "...",
  "age": ...,
  "activity_level": "...",
  "weekly_loss_target_lbs": ...,
  "calories_target": ...,
  "protein_target": ...,
  "fat_target": ...,
  "carbs": ...,
  "notes": "Why these numbers were chosen."
}
]]


3) Set debug.onboarding_complete = true.

After this, you enter NORMAL COACHING MODE.

======================================================
C. PLAN CALCULATION RULES
======================================================

MAINTENANCE ESTIMATE:
- Low activity: 11–12 × bodyweight (lb)
- Moderate: 12–13 × bodyweight
- High: 13–14 × bodyweight

Fat-loss target:
- Maintenance − 300 to 500 kcal
- Round to nearest 50

Green zone: ±150 calories

Protein:
- 0.8–1.0 g × bodyweight (lb)
- Round to nearest 5  
- Provide green zone ±15–20g

Fat:
- 0.3–0.4 g × bodyweight  
- Minimum = ~0.25 g/lb

Steps:
- If <4000 → minimum 6000–7000  
- 4000–8000 → 8000–10000  
- 8000+ → 10000+

Weekly fat loss:
- Most people: 0.5–1.0 lb/week  
- Heavier: up to 1.5–2.0 (if safe)  
- Leaner: 0.3–0.7 lb/week

======================================================
D. ONE-TIME "DIET & SCALE 101" MESSAGE
======================================================

After onboarding + plan delivery, send ONE educational message about:
- daily fluctuations  
- weekly averages  
- morning weigh-ins  
- why spikes happen  

Then never repeat it again.

======================================================
E. MEAL LOGGING (MEAL_LOG_JSON)
======================================================

When the user describes food and clearly wants it logged (“log this as breakfast…”, “I had…”):

1) Reply visibly with:
- Confirmed meal type
- Estimated calories + macros

Example visible reply:  
“That’s about 450 kcal • P: 40g • C: 45g • F: 9g.”

2) Add hidden block:

[[MEAL_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "meal_type": "Breakfast",
  "items": ["..."],
  "calories": ...,
  "protein": ...,
  "carbs": ...,
  "fat": ...
}
]]

If meal type not given → use "Snacks".

======================================================
F. DAILY REVIEWS — DAILY_REVIEW_JSON
======================================================

Occasionally, you may output:

[[DAILY_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "Short coach focus.",
  "risk_color": "green",
  "needs_human_review": false
}
]]

======================================================
G. GENERAL LOGGING
======================================================

- When chatting normally, reply like a coach.
- When user provides weight/steps/calories, record them in hidden JSON if your logic expects it.
- All hidden blocks must follow exact formatting.
`;

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
// We only SAVE a text-based plan the first time (before onboarding_complete is true).
function extractPlanFromText(text) {
  if (!text) return null;

  const calMatch = text.match(/calories[^0-9]*([0-9]{3,4})/i);
  const proteinMatch = text.match(/protein[^0-9]*([0-9]{2,4})/i);
  const fatMatch = text.match(/fat[s]?[^0-9]*([0-9]{1,3})/i);

  if (!calMatch && !proteinMatch && !fatMatch) return null;

  const plan = {
    calories_target: calMatch ? Number(calMatch[1]) : 0,
    protein_target: proteinMatch ? Number(proteinMatch[1]) : 0,
    fat_target: fatMatch ? Number(fatMatch[1]) : 0
  };

  if (!plan.calories_target && !plan.protein_target && !plan.fat_target) {
    return null;
  }
  return plan;
}

// Strip the COACH_PLAN_JSON block from the text before sending to user
function stripCoachPlanBlock(text) {
  if (!text) return text;
  return text.replace(/\[\[COACH_PLAN_JSON[\s\S]*?\]\]/, "").trim();
}

// Resolve a customer GID from request body (customerId or email)
async function resolveCustomerGidFromBody(body) {
  // Try various id fields first
  let rawId =
    body.customerId ||
    body.shopifyCustomerId ||
    body.customer_id ||
    body.customer_id_raw ||
    null;

  if (rawId) {
    const str = String(rawId);
    if (str.startsWith("gid://shopify/Customer/")) {
      return str;
    }
    const numeric = str.replace(/[^0-9]/g, "");
    if (numeric) {
      return `gid://shopify/Customer/${numeric}`;
    }
  }

  // Fallback: try email lookup
  const email = body.email;
  if (!email) return null;

  try {
    const data = await shopifyGraphQL(
      `
      query FindCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              email
            }
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

// Save plan into:
// - custom.coach_plan (JSON, full plan including weekly_loss_low/high, etc.)
// - custom.plan_json  (JSON clone, for projection card)
// - custom.start_weight (number_decimal or whatever definition is)
// - custom.goal_weight  (number_decimal or existing definition)
// - custom.onboarding_complete (boolean/text "true")
async function saveCoachPlanForCustomer(customerGid, planJson) {
  if (!customerGid || !planJson) return;

  const ownerId = customerGid;

  // Map start/goal weight from planJson, with sensible fallbacks
  const startWeight = planJson.start_weight != null
    ? Number(planJson.start_weight)
    : (planJson.current_weight_lbs != null
        ? Number(planJson.current_weight_lbs)
        : 0);

  const goalWeight = planJson.goal_weight != null
    ? Number(planJson.goal_weight)
    : (planJson.goal_weight_lbs != null
        ? Number(planJson.goal_weight_lbs)
        : 0);

  const caloriesTarget = Number(planJson.calories_target) || 0;
  const proteinTarget  = Number(planJson.protein_target)  || 0;
  const fatTarget      = Number(planJson.fat_target)      || 0;

  // Rough carb calculation from remaining calories (if not already provided)
  let carbs = Number(planJson.carbs || 0);
  if (!carbs && caloriesTarget && proteinTarget && fatTarget) {
    const calsFromProtein = proteinTarget * 4;
    const calsFromFat = fatTarget * 9;
    const remaining = caloriesTarget - (calsFromProtein + calsFromFat);
    if (remaining > 0) {
      carbs = Math.round(remaining / 4);
    }
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

  const metafields = [
    {
      ownerId,
      namespace: "custom",
      key: "coach_plan",
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
      value: "true"
    }
  ];

  if (startWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "start_weight",
      value: String(startWeight)
    });
  }

  if (goalWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "goal_weight",
      value: String(goalWeight)
    });
  }

  const variables = { metafields };

  const data = await shopifyGraphQL(mutation, variables);
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

// Parse messages like:
//  - "log today as 1850 calories"
//  - "today was about 2200 cals"
//  - "I was around 2000 calories today"
// We ONLY treat these as **daily totals** (not per meal).
function parseDailyCaloriesFromMessage(msg) {
  if (!msg || typeof msg !== "string") return null;
  const text = msg.toLowerCase();

  // Require some "day" context so we don't confuse a single meal with the whole day
  const mentionsDay =
    text.includes("today") ||
    text.includes("for the day") ||
    text.includes("whole day") ||
    text.includes("all day") ||
    text.includes("the day");

  // Pattern 1: "log today as 1850" (with or without "calories")
  let m = text.match(/log\s+(?:today|the day)\s+as\s+(\d{3,4})/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n >= 500 && n <= 6000) return n;
  }

  // Pattern 2: "today was about 2200 calories", "2000 cals today", etc.
  if (mentionsDay) {
    // Look for "#### calories/cals" somewhere in a message that talks about today/the day
    m = text.match(/(\d{3,4})\s*(?:calories|cals?|kcals?)/i);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (n >= 500 && n <= 6000) return n;
    }
  }

  return null;
}

// Read existing daily_logs metafield for a customer
async function getDailyLogsMetafield(customerGid) {
  if (!customerGid) return { logs: [], metafieldId: null };

  const data = await shopifyGraphQL(
    `
    query GetDailyLogs($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "custom", key: "daily_logs") {
          id
          value
        }
      }
    }
    `,
    { id: customerGid }
  );

  const mf = data?.customer?.metafield;
  if (!mf || !mf.value) {
    return { logs: [], metafieldId: null };
  }

  try {
    const parsed = JSON.parse(mf.value);
    if (Array.isArray(parsed)) {
      return { logs: parsed, metafieldId: mf.id || null };
    }
    return { logs: [], metafieldId: mf.id || null };
  } catch (e) {
    console.error("Error parsing daily_logs metafield JSON", e, mf.value);
    return { logs: [], metafieldId: mf.id || null };
  }
}

// Save daily_logs metafield back to Shopify
async function saveDailyLogsMetafield(customerGid, logs) {
  if (!customerGid) return;
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
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
        userErrors
          .map(e => `${(e.field || []).join(".")}: ${e.message}`)
          .join(" | ")
    );
  }
}

// NEW: upsert a DAILY TOTAL CALORIES into today's log
async function upsertDailyTotalCalories(customerGid, calories) {
  if (!customerGid || !calories) return;

  const { logs } = await getDailyLogsMetafield(customerGid);
  const today = new Date().toISOString().slice(0, 10);
  const idx = logs.findIndex(entry => entry && entry.date === today);

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date: today,
      calories: calories,
      total_calories: calories,
      coach_focus: existing.coach_focus || "Daily calories logged from chat."
    };
  } else {
    logs.push({
      date: today,
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

// Extract one or more MEAL_LOG_JSON blocks from a reply
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
        const obj = JSON.parse(jsonString);
        results.push(obj);
      } catch (e) {
        console.error("Failed to parse MEAL_LOG_JSON:", e, jsonString);
      }
    }
    searchIndex = end + 2;
  }

  return results;
}

// NEW: Extract DAILY_REVIEW_JSON block from a reply
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

// NEW: Try to grab calories from the coach reply text
function parseCaloriesFromReplyText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(\d{2,4})\s*(?:calories|cals?|kcals?)/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n > 0 && n < 6000) return n;
  }
  return null;
}

// 🔥 NEW: Try to grab calories from the USER message text
function parseCaloriesFromUserText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(\d{2,4})\s*(?:cal(?:ories|s|)?|kcals?)/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n > 0 && n < 6000) return n;
  }
  return null;
}

// NEW: Try to grab protein from the coach reply text
function parseProteinFromReplyText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/(\d{1,3})\s*(?:g|grams?)\s*protein/i);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (n > 0 && n < 300) return n;
  }
  return null;
}

// 🔥 NEW: Detect simple meal logging phrases from the user, like:
// - "Log this as dinner: 6oz grilled chicken, 1 cup rice, some veggies."
// - "I had 1 Muscle Milk shake at 160 calories"
// - "I ate a turkey sandwich for lunch, about 450 cals"
function detectSimpleMealFromUser(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return null;

  const original = userMsg;
  const text = userMsg.toLowerCase();

  // Pattern 1: "log this as dinner: ..."
  let m = text.match(/log\s+this\s+as\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*[:\-]?\s*(.*)$/i);
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const descLower = m[2] || "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) {
      desc = original.substring(startIndex, startIndex + descLower.length);
    }
    desc = (desc || "").trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;

    return {
      meal_type: mealType,
      items: [desc]
    };
  }

  // Pattern 2: "I had ... for breakfast/lunch/dinner/snack"
  m = text.match(/i\s+(?:had|ate)\s+(.*)\s+for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\b/i);
  if (m) {
    const descLower = m[1] || "";
    const mealTypeWord = m[2];
    const mealType = normalizeMealType(mealTypeWord);

    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) {
      desc = original.substring(startIndex, startIndex + descLower.length);
    }

    desc = (desc || "").trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;

    return {
      meal_type: mealType,
      items: [desc]
    };
  }

  // Pattern 3: "I had ..." (no explicit meal type, treat as snack)
  m = text.match(/i\s+(?:had|ate)\s+(.*)$/i);
  if (m) {
    const descLower = m[1] || "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) {
      desc = original.substring(startIndex, startIndex + descLower.length);
    }

    desc = (desc || "").trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;

    return {
      meal_type: "snacks",
      items: [desc]
    };
  }

  return null;
}

// Upsert a single meal (with calories + macros) into TODAY'S log
// If options.replaceMealType is set and matches this meal_type,
// we REMOVE any existing meals of that type for today (true override).
async function upsertMealLog(customerGid, meal, options = {}) {
  if (!customerGid || !meal) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  // IMPORTANT: always use "today" for saving meals, ignore meal.date
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const cleanDate = today;

  const idx = logs.findIndex(entry => entry && entry.date === cleanDate);

  // Normalize macros
  const cals = Number(meal.calories) || 0;
  const protein = Number(meal.protein) || 0;
  const carbs = Number(meal.carbs) || 0;
  const fat = Number(meal.fat) || 0;
  const mealType = meal.meal_type || "other";
  let items = meal.items;
  if (!Array.isArray(items)) {
    if (typeof items === "string" && items.trim()) {
      items = [items.trim()];
    } else {
      items = [];
    }
  }

  const replaceMealType = options.replaceMealType || null;

  if (idx >= 0) {
    // Update existing log for today
    const existing = logs[idx] || {};
    const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];

    // If this is an override for this meal type, remove prior meals of that type
    let baseMeals = existingMeals;
    if (replaceMealType && mealType === replaceMealType) {
      baseMeals = existingMeals.filter(m => !m || m.meal_type !== replaceMealType);
    }

    const newMeal = {
      meal_type: mealType,
      items,
      calories: cals,
      protein,
      carbs,
      fat
    };
    const updatedMeals = baseMeals.concat([newMeal]);

    // Recompute totals from all meals for TODAY
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
      total_calories: sumCals || existing.total_calories || existing.calories || null,
      calories: sumCals || existing.calories || null,
      total_protein: sumP || existing.total_protein || existing.protein || null,
      total_carbs: sumC || existing.total_carbs || existing.carbs || null,
      total_fat: sumF || existing.total_fat || existing.fat || null,
      coach_focus: existing.coach_focus || "Meals logged from chat."
    };
  } else {
    // Create new log for today
    const newMeals = [{
      meal_type: mealType,
      items,
      calories: cals,
      protein,
      carbs,
      fat
    }];

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

// NEW: upsert DAILY REVIEW INFO into daily_logs
async function upsertDailyReview(customerGid, review) {
  if (!customerGid || !review) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const todayStr = new Date().toISOString().slice(0, 10);
  const date = review.date && typeof review.date === "string" ? review.date : todayStr;

  const idx = logs.findIndex(entry => entry && entry.date === date);

  const summary = typeof review.summary === "string" && review.summary.trim()
    ? review.summary.trim()
    : "Keep it simple: hit your calories as best you can, move a bit, and log it honestly.";

  const riskColor = review.risk_color || "green";
  const needsHumanReview = !!review.needs_human_review;

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

  const mealWord = match[2];
  const mealType = normalizeMealType(mealWord);

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

export default async function handler(req, res) {
  // ===== CORS FOR PJIFITNESS =====
  const origin = req.headers.origin || "";

  const ALLOWED_ORIGINS = [
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com"
  ];

  if (ALLOWED_ORIGINS.includes(origin)) {
    // browser calls
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    // tools like Postman/curl
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "Content-Type, Authorization, X-Requested-With, Accept"
  );

  // Preflight
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

  const userMessage = body.message || "";
  const history = Array.isArray(body.history) ? body.history : [];
  const appendUserMessage = !!body.appendUserMessage;

  if (!userMessage && !history.length) {
    res.status(400).json({ error: "Missing 'message' in body" });
    return;
  }

  const customerGid = await resolveCustomerGidFromBody(body);
  const customerNumericId = customerGid
    ? String(customerGid).replace("gid://shopify/Customer/", "")
    : null;

  let shopifyMetafieldReadStatus = "not_attempted";
  let onboardingComplete = null;

  if (customerGid) {
    try {
      shopifyMetafieldReadStatus = "fetching";
      const data = await shopifyGraphQL(
        `
        query GetCustomerOnboarding($id: ID!) {
          customer(id: $id) {
            metafield(namespace: "custom", key: "onboarding_complete") {
              value
            }
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
    messagesCount: null,
    model: "gpt-4.1-mini"
  };

  // DAILY TOTAL CALORIES FROM USER MESSAGE
  if (customerGid && userMessage) {
    const parsedDailyCals = parseDailyCaloriesFromMessage(userMessage);
    if (parsedDailyCals) {
      debug.parsedDailyCalories = parsedDailyCals;
      try {
        await upsertDailyTotalCalories(customerGid, parsedDailyCals);
        debug.dailyCaloriesSavedToDailyLogs = true;
      } catch (e) {
        console.error("Error saving daily total calories from chat", e);
        debug.dailyCaloriesSavedToDailyLogs = false;
        debug.dailyCaloriesSaveError = String(e?.message || e);
      }
    }
  }

  // MEAL OVERRIDE FLAG
  const overrideMeal = detectMealOverride(userMessage);
  if (overrideMeal) {
    debug.mealOverrideDetected = overrideMeal;
  }

    // Figure out whether we've already sent the onboarding intro in this conversation
  let introAlreadySent = false;

  if (history.length) {
    const recentForIntro = history.slice(-40); // look back a bit further
    for (const m of recentForIntro) {
      if (!m) continue;
      const text =
        typeof m.text === "string"
          ? m.text
          : typeof m.message === "string"
          ? m.message
          : null;
      if (!text) continue;

      const lower = text.toLowerCase();
      if (
        lower.includes("i’m your pjifitness coach") ||
        lower.includes("i'm your pjifitness coach")
      ) {
        introAlreadySent = true;
        break;
      }
    }
  }

  debug.introAlreadySent = introAlreadySent;

  // BUILD MESSAGES FOR OPENAI
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  // Pass onboarding_complete flag
  if (onboardingComplete !== null) {
    messages.push({
      role: "system",
      content: `custom.onboarding_complete: ${
        onboardingComplete ? "true" : "false"
      }`
    });
  }

  // Tell the model not to repeat its intro once it's been sent
  if (introAlreadySent) {
    messages.push({
      role: "system",
      content:
        "SYSTEM_FLAG: INTRO_ALREADY_SENT = true. You have already sent your onboarding intro earlier in this conversation. Do NOT repeat your intro again. Treat the user's latest message as their answer (likely their name, weight, etc.) and continue the onboarding questions from where you left off."
    });
  }

  // Pass meal override info if present
  if (overrideMeal) {
    messages.push({
      role: "system",
      content: `USER_REQUEST_OVERRIDE_MEAL: ${JSON.stringify(overrideMeal)}`
    });
  }

  // Attach chat history (supports both .text and .message)
  if (history.length) {
    const recent = history.slice(-20);
    for (const m of recent) {
      if (!m) continue;

      const text =
        typeof m.text === "string"
          ? m.text
          : typeof m.message === "string"
          ? m.message
          : null;
      if (!text) continue;

      let role;
      if (m.role === "user") role = "user";
      else if (m.role === "coach" || m.role === "assistant") role = "assistant";
      else continue;

      messages.push({ role, content: text });
    }
  }

  // Latest user message
  if (appendUserMessage && userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

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

    debug.modelReplyTruncated = !data.choices?.[0]?.message?.content;

    let planJson = null;
    let planSource = null;

    const blockPlan = extractCoachPlanJson(rawReply);
    debug.planBlockFound = !!blockPlan;
    if (blockPlan) {
      planJson = blockPlan;
      planSource = "block";
    }

    if (!planJson) {
      const textPlan = extractPlanFromText(rawReply);
      debug.planFromText = !!textPlan;
      if (textPlan) {
        planJson = textPlan;
        planSource = "text";
      }
    }

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
        } catch (e) {
          console.error("Error saving coach_plan metafield", e);
          debug.planSavedToShopify = false;
          debug.planSaveError = String(e?.message || e);
          if (e && e.shopifyUserErrors) {
            debug.planSaveUserErrors = e.shopifyUserErrors;
          }
        }
      } else {
        debug.planSavedToShopify = false;
        debug.planSavedSkippedReason = skipReason;
      }
    }

    if (customerGid) {
      const mealLogs = extractMealLogsFromText(rawReply);

      if (mealLogs && mealLogs.length) {
        debug.mealLogsFound = mealLogs.length;
        debug.mealLogsSample = mealLogs.slice(0, 2);
        try {
          for (const meal of mealLogs) {
            await upsertMealLog(
              customerGid,
              meal,
              overrideMeal ? { replaceMealType: overrideMeal.meal_type } : {}
            );
          }
          debug.mealLogsSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving meal logs from chat", e);
          debug.mealLogsSavedToDailyLogs = false;
          debug.mealLogsSaveError = String(e?.message || e);
        }
      } else {
        debug.mealLogsFound = 0;

        const simpleMeal = detectSimpleMealFromUser(userMessage);
        if (simpleMeal) {
          const calFromUser = parseCaloriesFromUserText(userMessage);
          const calFromReply = parseCaloriesFromReplyText(rawReply);
          const cal = calFromUser || calFromReply || 0;

          const prot = parseProteinFromReplyText(rawReply) || 0;

          const fallbackMeal = {
            date: new Date().toISOString().slice(0, 10),
            meal_type: simpleMeal.meal_type,
            items: simpleMeal.items,
            calories: cal,
            protein: prot,
            carbs: 0,
            fat: 0
          };

          debug.mealLogsFallbackConstructed = fallbackMeal;

          try {
            await upsertMealLog(
              customerGid,
              fallbackMeal,
              overrideMeal ? { replaceMealType: fallbackMeal.meal_type } : {}
            );
            debug.mealLogsSavedToDailyLogs = true;
            debug.mealLogsFound = 1;
          } catch (e) {
            console.error("Error saving fallback meal log from chat", e);
            debug.mealLogsSavedToDailyLogs = false;
            debug.mealLogsSaveError = String(e?.message || e);
          }
        }
      }
    }

    if (customerGid) {
      const dailyReview = extractDailyReviewFromText(rawReply);
      if (dailyReview) {
        debug.dailyReviewFound = dailyReview;
        try {
          await upsertDailyReview(customerGid, dailyReview);
          debug.dailyReviewSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving daily review from chat", e);
          debug.dailyReviewSavedToDailyLogs = false;
          debug.dailyReviewSaveError = String(e?.message || e);
        }
      }
    }

    let cleanedReply = stripCoachPlanBlock(rawReply);
    cleanedReply = cleanedReply.replace(/\[\[MEAL_LOG_JSON[\s\S]*?\]\]/g, "").trim();
    cleanedReply = cleanedReply.replace(/\[\[DAILY_REVIEW_JSON[\s\S]*?\]\]/g, "").trim();

    res.status(200).json({ reply: cleanedReply, debug });
  } catch (e) {
    console.error("Chat handler error", e);
    const debugError = { ...debug, serverError: String(e?.message || e) };
    res.status(500).json({ error: "Server error", debug: debugError });
  }
}
