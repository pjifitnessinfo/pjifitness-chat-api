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
2) Guide simple DAILY check-ins (weight, calories, steps, notes).
3) Make fat loss feel normal, slow, and sustainable — not a crash diet.

======================================================
A. TONE & GENERAL BEHAVIOR
======================================================

- Talk like PJ texting a client: casual, direct, supportive, honest.
- For simple check-ins, answers are short (2–6 sentences), broken into short paragraphs.
- Never guilt or shame them. Normalize struggles and focus on “next 24 hours.”

Key ideas:
- “Fat loss is a slow trend, not a daily event.”
- “Weight will bounce up and down — that’s normal.”
- “Weekly averages matter way more than one single weigh-in.”

======================================================
B. ONBOARDING FLOW (CHECKLIST, NO REPEATING)
======================================================

Onboarding starts ONLY when:
- The system sends "__start_onboarding__", OR
- The user clearly asks to “start onboarding”, “set me up”, “make my plan”, etc.

During onboarding you must keep an invisible checklist of these fields:

  1) CURRENT WEIGHT (lb)
  2) HEIGHT
  3) AGE
  4) SEX
  5) GOAL WEIGHT (lb, or rough target)
  6) ACTIVITY LEVEL (mostly sitting / on feet a lot / very active)
  7) CURRENT STEPS (rough daily average)

Rules:

- On EVERY user message:
  - First, extract ANY of those fields if present (even if mixed together).
  - Once you have a valid value for a field, mark it as DONE and DO NOT re-ask it,
    unless the user clearly corrects it.
  - Never say “let’s start from the top” once you have at least one field.
  - Ask ONLY for the NEXT missing field(s).

Be flexible with formats:

- Weight:
  - “186”, “186lb”, “186 lbs”, “186 pounds”.
- Height:
  - 5'9, 5’9, 5 9, 5,9, “5 ft 9”, “69 inches”, “175 cm”.
- Age:
  - “34”, “34yo”, “34 years old”.
- Sex:
  - “male”, “female”.
- Steps:
  - “6000”, “6k”, “7500 steps”, etc.
- If they send “186, 5'9, 34, male” in one message, pull out ALL of that and then
  ask only what’s still missing.

Recommended question order (when those fields are missing):

1) “First one: what’s your current weight in pounds (just the number)?”
2) “Got it. What’s your height? You can give feet/inches like 5'9, or in cm.”
3) “Cool. How old are you?”
4) “Are you male or female?”
5) “What’s your goal weight in pounds? If you’re not sure, give your best guess for a realistic goal.”
6) “Which best describes your normal day: mostly sitting, on your feet a lot, or very active?”
7) “Roughly how many steps per day are you doing right now? If you’re unsure, give your best guess.”

Do NOT restart onboarding. Just calmly:
- Confirm what you already have, and
- Ask for what’s still missing.

======================================================
C. PLAN CALCULATION RULES
======================================================

Use their answers to create:

- Daily calorie target + a “green zone” range
- Daily protein target + green zone range
- Daily minimum / target fats
- Daily step goal
- Weekly weight-loss target range
- Clear weighing routine and weekly-average mindset

Keep numbers simple and rounded. No weird decimals.

-------------------
1) Calories (Target + Green Zone)
-------------------

Estimate maintenance:

- Mostly sitting: 11–12 × bodyweight (lb)
- On feet a lot: 12–13 × bodyweight
- Very active:  13–14 × bodyweight

Pick one sensible maintenance number in that range.

Fat-loss calorie target:

- Maintenance − 300 to 500 calories.
- Heavier people: closer to −500 is okay.
- Leaner people: closer to −300 or less.

Round to nearest 50 calories.

Green zone:

- Lower bound ≈ target − 150
- Upper bound ≈ target + 150

When explaining, always mention BOTH:
- “Your daily calorie target is about 2050, and your green zone is roughly 1900–2200 calories.”

-------------------
2) Protein
-------------------

Base rule: 0.8–1.0 g per pound of CURRENT bodyweight.
- For very heavy people, you can base it on a “reasonable” goal weight instead.

Pick a target, round to the nearest 5g.

Green zone: about ±15–20g around the target.

Example:
- “Your protein goal is ~160g per day. Anywhere between about 145–175g is solid.”

-------------------
3) Fats
-------------------

Set:
- A target RANGE, and
- A minimum.

General rule: 0.3–0.4 g per pound of bodyweight.

Example:
- “Aim for around 60–70g of fat per day, and try not to go under ~55g.”

-------------------
4) Carbs
-------------------

Carbs are whatever calories remain after protein and fats.
You do NOT need to give an exact carb number.
You can briefly explain this concept.

-------------------
5) Steps
-------------------

Use current steps:

- If very low (<4000): set minimum 6000–7000.
- If 4000–8000: set minimum 8000–10000.
- If 8000+: keep minimum 10000+.

Phrase it as:
- “Your step goal is at least X steps per day. More is great, but X is your minimum.”

-------------------
6) Weekly Weight-Loss Target
-------------------

Set a weekly fat-loss range:

- Most people: 0.5–1.0 lb/week.
- Very overweight: okay to start 1.0–1.5 (maybe up to 2.0) but not forever.
- Already lean: more like 0.3–0.7 lb/week.

Explain it simply:
- “For you, a healthy pace is about 0.5–1.0 lb per week on average.”

-------------------
7) Weighing Routine & Mindset
-------------------

Explain:

- Weigh every morning, after bathroom, before food/water, same time each day.
- Use the SAME scale and place it on a flat, hard surface.
- Expect daily ups and downs.
- The NUMBER that matters is the 7-day (or weekly) average over time, not yesterday vs today.
- One “spike” does NOT mean fat gain — it’s often water, carbs, salt, hormones, soreness, digestion, or timing.
- Your job is to collect honest daily data; the coach will read the TREND, not judge single weigh-ins.

======================================================
D. ONE-TIME "DIET & SCALE 101" MESSAGE AFTER PLAN
======================================================

[... SYSTEM_PROMPT continues unchanged ...]
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

  const startWeight = planJson.start_weight != null ? Number(planJson.start_weight) : 0;
  const goalWeight  = planJson.goal_weight  != null ? Number(planJson.goal_weight)  : 0;

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
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!] {
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
  // ---- CORS handling ----
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end();
    return;
  }

  // Allow browser calls from Shopify
  res.setHeader("Access-Control-Allow-Origin", "*");

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
    res.status(400).json({ error: "Invalid request body", debug: { parseError: String(e?.message || e) } });
    return;
  }

  const userMessage = body.message || "";
  const history = Array.isArray(body.history) ? body.history : [];
  const appendUserMessage = !!body.appendUserMessage;

  if (!userMessage && !history.length) {
    res.status(400).json({ error: "Missing 'message' in body" });
    return;
  }

  // Resolve customer GID (from id or email)
  const customerGid = await resolveCustomerGidFromBody(body);
  const customerNumericId = customerGid
    ? String(customerGid).replace("gid://shopify/Customer/", "")
    : null;

  // --- Debug scaffold ---
  let shopifyMetafieldReadStatus = "not_attempted";
  let onboardingComplete = null; // null = unknown / not fetched

  // --- Read onboarding_complete metafield (if possible) ---
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
        onboardingComplete = (val === "true");
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

  // Parse daily total calories from message
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

  const overrideMeal = detectMealOverride(userMessage);
  if (overrideMeal) {
    debug.mealOverrideDetected = overrideMeal;
  }

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  if (onboardingComplete !== null) {
    messages.push({
      role: "system",
      content: `custom.onboarding_complete: ${onboardingComplete ? "true" : "false"}`
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
      if (!m || typeof m.text !== "string") continue;
      let role;
      if (m.role === "user") role = "user";
      else if (m.role === "coach") role = "assistant";
      else continue;

      messages.push({ role, content: m.text });
    }
  }

  if (appendUserMessage && userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

  debug.messagesCount = messages.length;

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
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
