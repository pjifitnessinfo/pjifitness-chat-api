// /api/chat.js
// Chat endpoint using OpenAI REST API.
// Expects: { message, email, customerId, threadId, history, appendUserMessage } in JSON body.
// Returns: { reply, debug }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Shopify Admin API (for reading + writing onboarding/metafields)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "your-store.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

/* ============================================================
   SYSTEM PROMPT — ONBOARDING + DAILY COACH + PLAN JSON MARKER
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
- Expect daily ups and downs.
- Weekly averages matter more than any single day.
- One “spike” does NOT mean fat gain — it’s often water, carbs, salt, or digestion.

======================================================
D. HOW TO PRESENT THE FINAL PLAN
======================================================

When onboarding is complete and you have all needed info:

1) Present the plan in bullet form like this (example style):

   “Based on what you told me, here’s your starting plan:
    - Calories: ~2050 per day (green zone 1900–2200).
    - Protein: ~160g/day (145–175g is fine).
    - Fats: ~60–70g/day (try not to go below ~55g).
    - Steps: at least 8,000 per day.
    - Expected loss: about 0.5–1.0 lb per week on average.

    We’ll watch your weekly averages, not one random weigh-in. Your job is to
    hit these targets most days and keep checking in. I’ll adjust if the trend
    is too slow or too fast.”

2) Also clearly explain HOW to use the coach daily:

   - “Each day, just send: weight, total calories, steps, and how the day felt.”
   - Give a concrete example message they can copy.

======================================================
E. DAILY CHECK-IN MODE
======================================================

Once onboarded, default to daily coach mode.

If they send no numbers:
- Ask for today’s weight, calories, steps, and how the day felt before giving big advice.

If they send something like “186.4, 2100 calories, 9000 steps, felt okay”:
- Acknowledge the trend vs their plan.
- Highlight what’s good.
- Give 1–2 things to tighten.
- End with ONE clear focus for tomorrow.

======================================================
F. PLATEAUS, FLUCTUATIONS, FREAKOUTS
======================================================

If they’re worried about the scale:
- Explain normal causes (water, carbs, salt, hormones, soreness, digestion, timing).
- Zoom out to 7–14 days of calories, steps, and weight.
- If they’ve mostly been on-plan, reassure them.
- If not, suggest a small adjustment (slightly fewer calories or more steps).

Always sound calm and confident, never panicked.

======================================================
G. STYLE RULES
======================================================

- NO code, NO JSON to the user in normal text.
- Use short paragraphs and plain language.
- Talk like a real coach texting, not a robot or scientist.
- If they mention serious health issues, gently advise them to consult a healthcare professional.

======================================================
H. HIDDEN PLAN JSON FOR THE APP (IMPORTANT)
======================================================

When (and ONLY when) you have finished onboarding and just presented their full plan:

- At the VERY END of your reply, append a hidden machine-readable block for the app, in EXACTLY this format:

  [[COACH_PLAN_JSON {
    "start_weight": 186,
    "goal_weight": 170,
    "calories_target": 2050,
    "calories_low": 1900,
    "calories_high": 2200,
    "protein_target": 160,
    "protein_low": 145,
    "protein_high": 175,
    "fat_min": 55,
    "fat_target": 65,
    "steps_goal": 8000,
    "weekly_loss_low": 0.5,
    "weekly_loss_high": 1.0
  }]]

Rules for this block:
- Use the exact prefix [[COACH_PLAN_JSON and suffix ]].
- Inside must be a SINGLE valid JSON object, nothing else.
- All values are numbers (no strings), rounded sensibly.
- Include ALL of these keys every time:

  start_weight
  goal_weight
  calories_target
  calories_low
  calories_high
  protein_target
  protein_low
  protein_high
  fat_min
  fat_target
  steps_goal
  weekly_loss_low
  weekly_loss_high

- Do NOT explain this block.
- Do NOT mention “JSON”, “metadata”, or “for the app”.
- The user should only see the normal coaching message; the app will quietly read the block.

======================================================
I. MEAL LOGGING, ESTIMATES & EXPLANATIONS
======================================================

When the user describes what they ate (e.g. “Lunch: 2 homemade 1" meatballs on a hero with cheese and some fries”):

1) Give a normal coaching reply in plain language.

2) ALSO estimate that meal’s calories + protein + carbs + fats and include a hidden block at the END of your reply in EXACTLY this format:

   [[MEAL_LOG_JSON {
     "date": "YYYY-MM-DD",
     "meal_type": "breakfast" | "lunch" | "dinner" | "snacks",
     "items": ["short human-readable description here"],
     "calories": 900,
     "protein": 50,
     "carbs": 90,
     "fat": 40
   }]]

   - Use today’s date for "date" in YYYY-MM-DD.
   - Pick the closest meal_type based on what they said.
   - "items" should be a short list of what they ate in their own words.
   - calories/protein/carbs/fat are rough estimates, all numbers (no strings).

3) When food is generic or vague, EXPLAIN your estimate briefly in the visible text:
   - Example: “I’m logging that as about 900–1000 calories. I assumed 2 medium beef meatballs (~300 cals), a white hero with cheese (~500–550), and a small handful of fries (~150). If that feels way off, tell me and I’ll adjust it.”

4) Gently offer 1–2 easy substitution ideas when it makes sense:
   - Example: “Next time, you could keep the meatballs but do a smaller roll or open-face the sandwich, and shrink the fries or swap them for a salad.”

Keep explanations short (1–3 sentences) so you don’t overwhelm the user.
Never show the words “JSON” or “MEAL_LOG_JSON” in the normal coaching text; that block is only for the app.

Outside of all hidden blocks, never show JSON or technical stuff to the user.

Your #1 mission:
Make the user feel like they finally have a calm, competent coach who tells them exactly what to do today and reminds them that real fat loss happens over weeks and months, not from one perfect day.
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
    console.error("Shopify GraphQL error:", text);
    throw new Error("Shopify GraphQL error");
  }

  const json = await res.json();
  if (json.errors) {
    console.error("Shopify GraphQL errors:", json.errors);
    throw new Error("Shopify GraphQL errors");
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
// ONLY used while onboarding_complete is false/missing
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
// - custom.start_weight (number_decimal)
// - custom.goal_weight  (number_decimal)
// - custom.onboarding_complete (boolean true)
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

  // TYPES HERE MUST MATCH YOUR CUSTOMER METAFIELD DEFINITIONS:
  // - coach_plan: JSON
  // - onboarding_complete: Boolean (True or false)
  // - start_weight: Number (Decimal)
  // - goal_weight:  Number (Decimal)
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
      key: "onboarding_complete",
      type: "boolean",
      value: "true"
    }
  ];

  if (startWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "start_weight",
      type: "number_decimal",
      value: String(startWeight)
    });
  }

  if (goalWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "goal_weight",
      type: "number_decimal",
      value: String(goalWeight)
    });
  }

  const variables = { metafields };

  const data = await shopifyGraphQL(mutation, variables);
  const userErrors = data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    console.error("metafieldsSet userErrors (coach_plan):", userErrors);
    throw new Error("Shopify userErrors when saving coach_plan/start/goal");
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

// Upsert today's total_calories into daily_logs (JSON array)
async function upsertDailyTotalCalories(customerGid, totalCalories) {
  if (!customerGid || !totalCalories) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC

  // Find existing log for today, if any
  const idx = logs.findIndex(entry => entry && entry.date === today);

  if (idx >= 0) {
    // Update existing log for today, but keep other fields as-is
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date: today,
      total_calories: totalCalories,
      calories: totalCalories,
      coach_focus: existing.coach_focus || "Daily calories logged from chat.",
      meals: existing.meals || []
      // do NOT overwrite any macro totals if they exist
    };
  } else {
    // Create new log object for today
    logs.push({
      date: today,
      weight: null,
      calories: totalCalories,
      total_calories: totalCalories,
      steps: null,
      meals: [],
      mood: null,
      struggle: null,
      coach_focus: "Daily calories logged from chat."
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
    throw new Error("Shopify userErrors when saving daily_logs");
  }
}

// Upsert a single meal (with calories + macros) into the correct day's log
async function upsertMealLog(customerGid, meal) {
  if (!customerGid || !meal) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date = meal.date || new Date().toISOString().slice(0, 10);
  const cleanDate = String(date).slice(0, 10);

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

  if (idx >= 0) {
    // Update existing log for that date
    const existing = logs[idx] || {};
    const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];
    const newMeal = {
      meal_type: mealType,
      items,
      calories: cals,
      protein,
      carbs,
      fat
    };
    const updatedMeals = existingMeals.concat([newMeal]);

    // Recompute totals from all meals
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
    // Create new log for that date
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
      // Keep onboardingComplete as null if fetch fails
    }
  } else {
    shopifyMetafieldReadStatus = "no_customer_id";
  }

  // Base debug payload (we'll reuse in success + error responses)
  const debug = {
    customerGid: customerGid || null,
    customerIdNumeric: customerNumericId,
    inboundMessage: userMessage,
    historyCount: history.length,
    appendUserMessage,
    onboarding_complete: onboardingComplete,
    shopifyMetafieldReadStatus,
    messagesCount: null, // set later
    model: "gpt-4.1-mini"
  };

  // === Try to parse "daily total calories" from the user's message ===
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

  // Build messages with full conversation context
  const messages = [
    { role: "system", content: SYSTEM_PROMPT }
  ];

  // Inject metafield context so the model knows onboarding status
  if (onboardingComplete !== null) {
    messages.push({
      role: "system",
      content: `custom.onboarding_complete: ${onboardingComplete ? "true" : "false"}`
    });
  }

  if (history.length) {
    const recent = history.slice(-20); // last 20 messages max
    for (const m of recent) {
      if (!m || typeof m.text !== "string") continue;
      let role;
      if (m.role === "user") role = "user";
      else if (m.role === "coach") role = "assistant";
      else continue;

      messages.push({ role, content: m.text });
    }
  }

  // For special triggers like "__start_onboarding__" (no user bubble),
  // the current message is NOT in history, so we append it as a user turn.
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

    // === Find a plan (JSON block first, then safe fallback) ===
    let planJson = extractCoachPlanJson(rawReply);
    debug.planBlockFound = !!planJson;

    // If we didn't get the JSON block, and onboarding isn't complete yet,
    // try the text-based fallback.
    if (!planJson && (onboardingComplete === false || onboardingComplete === null)) {
      planJson = extractPlanFromText(rawReply);
      debug.planFromText = !!planJson;
    }

    // Only save the plan when onboarding is not complete yet
    if (planJson) {
      debug.planJson = planJson;
      if (customerGid && (onboardingComplete === false || onboardingComplete === null)) {
        try {
          await saveCoachPlanForCustomer(customerGid, planJson);
          debug.planSavedToShopify = true;
        } catch (e) {
          console.error("Error saving coach_plan metafield", e);
          debug.planSavedToShopify = false;
          debug.planSaveError = String(e?.message || e);
        }
      } else {
        debug.planSavedToShopify = false;
        debug.planSaveSkippedReason = !customerGid
          ? "no_customer_id"
          : "onboarding_already_complete";
      }
    }

    // === Extract meal logs (if any) and upsert them ===
    if (customerGid) {
      const mealLogs = extractMealLogsFromText(rawReply);
      if (mealLogs && mealLogs.length) {
        debug.mealLogsFound = mealLogs.length;
        try {
          for (const meal of mealLogs) {
            await upsertMealLog(customerGid, meal);
          }
          debug.mealLogsSavedToDailyLogs = true;
        } catch (e) {
          console.error("Error saving meal logs from chat", e);
          debug.mealLogsSavedToDailyLogs = false;
          debug.mealLogsSaveError = String(e?.message || e);
        }
      }
    }

    // Strip hidden blocks from visible reply
    let cleanedReply = stripCoachPlanBlock(rawReply);
    cleanedReply = cleanedReply.replace(/\[\[MEAL_LOG_JSON[\s\S]*?\]\]/g, "").trim();

    res.status(200).json({ reply: cleanedReply, debug });
  } catch (e) {
    console.error("Chat handler error", e);
    debug.serverError = String(e?.message || e);
    res.status(500).json({ error: "Server error", debug });
  }
}
