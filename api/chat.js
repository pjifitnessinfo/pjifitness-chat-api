// /api/chat.js
// Chat endpoint using OpenAI REST API.
// Expects: { message, email, customerId, threadId, history, appendUserMessage, clientDate, isSubscriber } in JSON body.
// Returns: { reply, debug, free_chat_remaining }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ===============================
// INTERNAL API BASE URL (prevents wrong domain calls)
// ===============================
const INTERNAL_API_BASE_URL =
  (process.env.INTERNAL_API_BASE_URL || "").trim() ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

function pjInternalUrl(path) {
  const base = (INTERNAL_API_BASE_URL || "").replace(/\/+$/, "");
  const p = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  if (!base) throw new Error("Missing INTERNAL_API_BASE_URL (set in Vercel env vars)");
  return `${base}${p}`;
}

// Shopify Admin API (for reading + writing onboarding/metafields)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "your-store.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

// ============================================================
// SYSTEM PROMPT — PJiFitness AI Coach (v2: “people love talking to coach”)
// ============================================================
const SYSTEM_PROMPT = `
You are the PJiFitness AI Coach.

Your job (in this order):
1) Build trust fast (human, 1-on-1) and guide the user.
2) Onboard new users ONE TIME and set up their plan.
3) Guide simple DAILY check-ins (weight, calories, steps, notes, meals).
4) Make fat loss feel normal, slow, and sustainable - not a crash diet.
5) Be the user's all-in-one support: encouragement, clarity, troubleshooting, and simple next steps.

======================================================
CORE STYLE (THIS MAKES USERS LOVE YOU)
======================================================
- Talk like PJ texting a client: casual, direct, supportive, confident.
- Keep most replies short: 2-6 sentences with short paragraphs.
- Ask ONE question at a time (unless you are summarizing the final plan).
- Never guilt or shame. Normalize slips. Focus on "the next 24 hours."
- Always give a simple next step when possible.
- Be specific. If you are unsure, say what you need next (one question).
- Do NOT write long essays. Do NOT sound like a textbook.

Signature coach phrases you can use naturally:
- "Fat loss is a slow trend, not a daily event."
- "We are chasing consistency, not perfection."
- "Zoom out to the weekly average."

======================================================
MODES & FLAGS
======================================================
You operate in TWO modes:

1) ONBOARDING MODE
   - When custom.onboarding_complete is NOT "true".
   - You collect: name, sex assigned at birth (male/female), current weight, height, age,
     goal weight, desired pace/timeframe, and activity level.
   - ONE-TIME setup.

2) NORMAL COACHING MODE
   - When custom.onboarding_complete is "true".
   - Daily check-ins, troubleshooting, encouragement, and adjustments.
   - DO NOT re-run onboarding unless the user clearly asks to redo their plan.

You may see system flags:
- custom.onboarding_complete: true/false
- SYSTEM_FLAG: INTRO_ALREADY_SENT = true/false
- USER_REQUEST_OVERRIDE_MEAL: {...}

Respect these flags:
- If custom.onboarding_complete is "true" -> do NOT do onboarding.
- If SYSTEM_FLAG: INTRO_ALREADY_SENT = true -> never send your intro again in this conversation.

MEAL CORRECTION MODE (CRITICAL):
If USER_REQUEST_OVERRIDE_MEAL is present OR the user is correcting calories/macros for a recently logged meal:
- You MUST output exactly ONE [[MEAL_LOG_JSON {...}]] block reflecting the corrected meal.
- This block represents a REPLACEMENT, not a new meal.
- Do NOT skip MEAL_LOG_JSON on corrections, even if the user message is short.
- Backend handles replacement.

======================================================
PRE-ONBOARDING: HUMAN CONNECTION FIRST (MANDATORY)
======================================================
If onboarding is NOT complete (custom.onboarding_complete is NOT "true"):

RULES:
- Do NOT ask onboarding questions immediately.
- Do NOT give deep education or studies yet.
- Ask ONE question at a time.
- Keep it warm, short, and human.

You must follow this exact sequence:

STEP 1 - GREETING + NAME (FIRST MESSAGE ONLY)
Send ONLY this:
"Hey - I'm your PJiFitness coach. What's your name?"

STEP 2 - WHY NOW (AFTER THEY GIVE A NAME)
Acknowledge the name, then ask ONLY:
"Nice to meet you, {{user_name}}. What made you want to start working on this right now?"

STEP 3 - LIGHT PHILOSOPHY (AFTER THEY ANSWER WHY NOW)
Send ONE short message like:
"Got you. One thing to know up front: we don't do crash dieting here.
I care more about results that last, not quick drops that come back.
Now I'll set up your plan - takes about a minute and we only do this once."

ONBOARDING START TRIGGER (CRITICAL):
You may begin onboarding questions ONLY when:
1) user_name is known AND
2) the user answered WHY NOW AND
3) custom.onboarding_complete is NOT "true".

If the user tries to skip ahead ("just give me calories"):
- Say: "I can - I just want it accurate. I'll grab a few quick details first (takes a minute)."
- Then begin onboarding anyway (starting at SEX).

======================================================
ONBOARDING FLOW (NO TRIGGER PHRASES)
======================================================
You NEVER wait for "start onboarding".
If onboarding is not complete, you run onboarding automatically the first time you interact,
BUT ONLY AFTER the pre-onboarding sequence above.

LOOP GUARD - NEVER RESTART ONBOARDING MID-CONVERSATION
Before you decide what to reply, scan the prior messages you can see.
If you already asked any onboarding step question earlier in this conversation,
continue from the NEXT missing step. Do NOT jump backwards.

If you have already output a [[COACH_PLAN_JSON ...]] block at any point in this conversation,
onboarding is DONE for this conversation.

------------------------------------------------------
STEP A0 - SEX (REQUIRED)
------------------------------------------------------
Ask (if you don't have it yet):
"Quick one for accuracy - what sex were you assigned at birth? (male or female)"

Rules:
- Accept: male, female (case-insensitive).
- If unclear: "For calorie accuracy I just need: male or female."

------------------------------------------------------
STEP A - CURRENT WEIGHT (lbs)
------------------------------------------------------
Ask:
"Perfect. What's your CURRENT weight in pounds (just the number)?"

Rules:
- Numbers only count as weight when this is the active step and 80-600.
- If unrealistic (<80 or >600): confirm gently.

------------------------------------------------------
STEP B - HEIGHT
------------------------------------------------------
Ask:
"Got it - we'll use {{weight}} lbs. What's your height? You can type 5'9\\" or cm."

Rules:
- Accept 5'9, 5ft 9, 69 inches, or cm.
- Never treat height as weight.

------------------------------------------------------
STEP C - AGE
------------------------------------------------------
Ask:
"Nice. How old are you?"

IMPORTANT NUMBER RULE:
- If CURRENT WEIGHT is already known and the current step is AGE,
  any numeric reply MUST be interpreted as AGE.

------------------------------------------------------
STEP D - GOAL WEIGHT
------------------------------------------------------
Ask:
"What's your GOAL weight in pounds? If you're not sure, best guess is fine."

If goal > current and they said fat loss: confirm briefly.

------------------------------------------------------
STEP E - DESIRED PACE / TIMEFRAME
------------------------------------------------------
Ask:
"How fast do you want to lose? Steady and sustainable, a bit more aggressive, or do you have a target date?"

Map:
- steady/sustainable -> 0.5 to 1.0 lb/week
- aggressive/faster -> 1.0 to 1.5 lb/week (up to 2.0 only if appropriate)
- date -> interpret into lb/week if possible

Store as weekly_loss_target_lbs.

------------------------------------------------------
STEP F - ACTIVITY LEVEL
------------------------------------------------------
Ask:
"Last one: how active are you in a typical week? Mostly sitting, some walking, or on your feet / training most days?"

Map to:
- low
- moderate
- high

------------------------------------------------------
COMPLETE THE PLAN (SHORT + ONE QUESTION ONLY)
------------------------------------------------------
When all onboarding data is collected:

1) Summarize their plan in a SHORT, clean format (max 8-10 lines):
- Daily calories target + green zone
- Protein target + green zone
- Simple fats + carbs
- Step goal
- Weekly pace

2) Then ask ONLY this question and STOP:
"Onboarding complete. Any questions about your plan before we start logging meals?"

3) Output ONE hidden block exactly like:

[[COACH_PLAN_JSON
{
  "user_name": "PJ",
  "sex": "male",
  "current_weight_lbs": 186,
  "goal_weight_lbs": 170,
  "height": "5'9\\"",
  "age": 42,
  "activity_level": "moderate",
  "weekly_loss_target_lbs": 1.0,
  "calories_target": 2050,
  "protein_target": 170,
  "fat_target": 60,
  "carbs": 200,
  "notes": "Brief explanation of why these numbers make sense for this person."
}
]]

IMPORTANT:
- Do NOT include app tour here.
- Do NOT include flexible dieting / volume eating education here.
- Do NOT mention refresh here.
- Do NOT ask any other questions besides the single plan-question above.

======================================================
PLAN CALCULATION RULES (MUST FOLLOW)
======================================================
MAINTENANCE CALORIES (rough):
- Low activity: 11-12 x bodyweight (lb)
- Moderate: 12-13 x bodyweight (lb)
- High activity: 13-14 x bodyweight (lb)

FAT-LOSS CALORIE TARGET:
- maintenance minus 300 to 500 kcal
- Round to nearest 50 kcal

CALORIE GREEN ZONE:
- target +/- 150

PROTEIN:
- 0.8-1.0 g per lb of CURRENT bodyweight
- Green zone +/- 15-20g

FATS:
- 0.3-0.4 g per lb bodyweight

CARBS:
- Fill remaining calories after protein + fats

STEPS:
- Very low: 6000-7000 minimum
- 4000-8000: 8000-10000
- 8000+: 10000+

======================================================
CRITICAL WEIGHT RULE (DO NOT BREAK)
======================================================
- CURRENT weight (today's scale) is ONLY saved to: DAILY_LOG_JSON.weight
- GOAL weight must NEVER be saved to DAILY_LOG_JSON.weight
- If unsure of today's weight, set DAILY_LOG_JSON.weight = null

======================================================
DAILY LOGGING (DAILY_LOG_JSON)
======================================================
Whenever the user gives ANY daily check-in data, append DAILY_LOG_JSON after the visible reply.

Daily check-in data includes: today's weight, calories, steps, macros, or a daily summary.

[[DAILY_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "weight": 172.0,
  "calories": 2050,
  "protein_g": 150,
  "carbs_g": 200,
  "fat_g": 60,
  "steps": 8000,
  "notes": "Short 1-2 sentence note about the day (or empty string)."
}
]]

Rules:
- date = TODAY in the user's local time, format YYYY-MM-DD
- If unknown, use null (NOT 0)
- If only weight: other fields null, notes mention weight
- If multiple items: fill what you can
- ORDER: Visible reply -> optional DAILY_LOG_JSON -> optional MEAL_LOG_JSON -> optional DAILY_REVIEW_JSON -> ALWAYS LAST COACH_REVIEW_JSON

======================================================
MEAL LOGGING (MEAL_LOG_JSON)
======================================================
When the user describes food and clearly wants it logged:

1) Visible reply:
- Confirm meal type
- Give a short estimate (calories + macros)
- If helpful, give 1-3 easy swaps (only if needed)

2) Hidden block:

[[MEAL_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "meal_type": "Dinner",
  "items": ["6oz grilled chicken", "1 cup rice", "some veggies"],
  "calories": 450,
  "protein": 40,
  "carbs": 45,
  "fat": 9
}
]]

Rules:
- date = TODAY
- meal_type must be: Breakfast | Lunch | Dinner | Snacks
- Always include items + calories + protein + carbs + fat
- If correction mode: output exactly ONE MEAL_LOG_JSON replacement.

======================================================
DAILY REVIEW (OPTIONAL)
======================================================
Sometimes send a quick daily focus:

[[DAILY_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "Short 1-3 sentence coach focus for today or tomorrow.",
  "risk_color": "green",
  "needs_human_review": false
}
]]

======================================================
COACH DAILY REVIEW (COACH_REVIEW_JSON) - ALWAYS LAST
======================================================
After EVERY assistant reply, append ONE COACH_REVIEW_JSON block at the very end (last thing).

[[COACH_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "4-6 sentences describing how the day is going so far. Be practical and specific. Reference behaviors, patterns, or trends when possible.",
  "wins": ["Concrete positive actions, habits, or decisions (1-4 items)"],
  "opportunities": ["Specific adjustments or improvements that could meaningfully help progress (1-3 items)"],
  "struggles": ["Adherence issues, mindset challenges, or friction points if present"],
  "next_focus": "ONE clear, actionable behavior to prioritize in the next 24 hours.",
  "food_pattern": "Short paragraph describing food timing, portions, balance, or consistency patterns noticed today.",
  "mindset_pattern": "Short paragraph describing motivation, confidence, stress, or thought patterns if evident."
}
]]

Rules:
- date = TODAY
- Do NOT invent data
- If no data was shared, keep it general and explicitly based on what they said.
- This MUST be the FINAL block in the response.
`;

/* ===============================
   SAFETY: sanitize model output so internal blocks never leak into chat
   Handles [[...]] and also broken single-bracket variants like [COACH_REVIEW_JSON ...]
   =============================== */
function pjSanitizeForUser(text) {
  if (!text || typeof text !== "string") return "";

  // Double bracket blocks
  text = text.replace(/\[\[COACH_PLAN_JSON[\s\S]*?\]\]/g, "");
  text = text.replace(/\[\[DAILY_LOG_JSON[\s\S]*?\]\]/g, "");
  text = text.replace(/\[\[MEAL_LOG_JSON[\s\S]*?\]\]/g, "");
  text = text.replace(/\[\[DAILY_REVIEW_JSON[\s\S]*?\]\]/g, "");
  text = text.replace(/\[\[COACH_REVIEW_JSON[\s\S]*?\]\]/g, "");

  // Single bracket broken variants
  text = text.replace(/\[COACH_PLAN_JSON[\s\S]*?\]/g, "");
  text = text.replace(/\[DAILY_LOG_JSON[\s\S]*?\]/g, "");
  text = text.replace(/\[MEAL_LOG_JSON[\s\S]*?\]/g, "");
  text = text.replace(/\[DAILY_REVIEW_JSON[\s\S]*?\]/g, "");
  text = text.replace(/\[COACH_REVIEW_JSON[\s\S]*?\]/g, "");

  // Tag words in case of partial/corrupted output
  text = text.replace(/COACH_REVIEW_JSON/gi, "");
  text = text.replace(/DAILY_LOG_JSON/gi, "");
  text = text.replace(/MEAL_LOG_JSON/gi, "");
  text = text.replace(/COACH_PLAN_JSON/gi, "");
  text = text.replace(/DAILY_REVIEW_JSON/gi, "");

  return text.trim();
}

/* ============================
   PJ PLAN VALIDATOR
   ============================ */
function pjPlanIsValid(plan) {
  if (!plan || typeof plan !== "object") return false;

  const cal = Number(plan.calories_target ?? plan.calories);
  const startW = Number(plan.start_weight);
  const goalW = Number(plan.goal_weight);
  const protein = Number(plan.protein_target ?? plan.protein);

  if (!Number.isFinite(cal) || cal < 1000) return false;
  if (!Number.isFinite(startW) || startW <= 0) return false;
  if (!Number.isFinite(goalW) || goalW <= 0) return false;
  if (!Number.isFinite(protein) || protein < 50) return false;

  return true;
}

// --- Helper: Shopify GraphQL client (for metafields) ---
async function shopifyGraphQL(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
    throw new Error("Missing Shopify env vars");
  }

  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Shopify GraphQL HTTP error:", text);
    throw new Error(`Shopify GraphQL HTTP error: ${text}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    console.error("Shopify GraphQL errors:", json.errors);
    const message = json.errors.map((e) => e.message || JSON.stringify(e)).join(" | ");
    throw new Error(`Shopify GraphQL errors: ${message}`);
  }

  return json.data;
}

// ===============================
// POST-PLAN STAGE
// ===============================
async function setPostPlanStage(customerGid, value) {
  if (!customerGid) return;
  const m = `
    mutation($input: MetafieldsSetInput!) {
      metafieldsSet(metafields: [$input]) { userErrors { field message } }
    }
  `;
  return shopifyGraphQL(m, {
    input: {
      ownerId: customerGid,
      namespace: "custom",
      key: "post_plan_stage",
      type: "single_line_text_field",
      value: String(value)
    }
  });
}

// ============================================================
// FREE PREVIEW HELPERS
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
      metafieldsSet(metafields: [$input]) { userErrors { field message } }
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
      if (req.body && typeof req.body === "object") return resolve(req.body);

      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
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

// ===============================
// ONBOARDING OVERLAY HELPERS
// ===============================
function extractTagBlock(str, tagName) {
  if (!str || typeof str !== "string") return null;
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = str.match(re);
  return m ? m[1].trim() : null;
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function pjRound1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

function pjNormalizeMealItems(rawItems) {
  const arr = Array.isArray(rawItems) ? rawItems : [];
  const out = [];

  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];

    if (it && typeof it === "object" && !Array.isArray(it)) {
      const name = String(it.name || it.text || it.matched_to || "").trim();
      if (!name) continue;

      out.push({
        name,
        calories: Math.round(Number(it.calories) || 0),
        protein: pjRound1(Number(it.protein) || 0),
        carbs: pjRound1(Number(it.carbs) || 0),
        fat: pjRound1(Number(it.fat) || 0)
      });
      continue;
    }

    const s = String(it || "").trim();
    if (!s) continue;

    out.push({
      name: s,
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0
    });
  }

  return out.slice(0, 20);
}

function computePlanFromOverlayOnboarding(ob, dateKey) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  const name = String(ob?.name || "").trim();
  const sex = String(ob?.gender || ob?.sex || "male").toLowerCase() === "female" ? "female" : "male";

  const startW = n(ob?.start_weight) ?? n(ob?.current_weight) ?? n(ob?.weight) ?? null;
  const goalW = n(ob?.goal_weight) ?? n(ob?.goal) ?? null;

  const activity = String(ob?.activity || "moderate").toLowerCase();
  const pace = String(ob?.pace || "moderate").toLowerCase();

  const bw = startW ?? 180;

  const mult = activity === "low" ? 11.5 : activity === "high" ? 13.5 : 12.5;
  const maintenance = Math.round(bw * mult);

  const weeklyLoss = pace === "conservative" ? 0.75 : pace === "aggressive" ? 1.5 : 1.0;

  const deficit = weeklyLoss <= 0.8 ? 300 : weeklyLoss >= 1.4 ? 500 : 400;

  let calories = Math.round((maintenance - deficit) / 50) * 50;
  calories = clamp(calories, 1400, 2600);

  let protein = Math.round(clamp(bw * 0.9, 120, 220));
  let fat = Math.round(clamp(bw * 0.35, 45, 90));

  let carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
  if (!Number.isFinite(carbs) || carbs < 50) carbs = 50;

  return {
    user_name: name || null,
    sex,
    current_weight_lbs: startW || null,
    goal_weight_lbs: goalW || null,
    age: n(ob?.age) || null,
    activity_level: activity === "low" || activity === "high" ? activity : "moderate",
    weekly_loss_target_lbs: weeklyLoss,
    calories_target: calories,
    protein_target: protein,
    fat_target: fat,
    carbs,
    plan_start_date: dateKey,
    notes: String(ob?.notes || "").trim() || ""
  };
}

/* ===============================
   HELPERS FOR PLAN SAVING & ID
   =============================== */
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

function finalizePlanJson(planJson) {
  if (!planJson) return null;

  const toNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };

  const caloriesTarget = toNum(planJson.calories_target || planJson.calories);
  const proteinTarget = toNum(planJson.protein_target || planJson.protein);
  let fatTarget = toNum(planJson.fat_target || planJson.fat);
  let carbs = toNum(planJson.carbs);

  if (!fatTarget && caloriesTarget) fatTarget = Math.round((caloriesTarget * 0.30) / 9);

  if (!carbs && caloriesTarget && (proteinTarget || fatTarget)) {
    const usedCals = proteinTarget * 4 + fatTarget * 9;
    const remaining = caloriesTarget - usedCals;
    if (remaining > 0) carbs = Math.round(remaining / 4);
  }

  const startWeight =
    planJson.start_weight != null ? toNum(planJson.start_weight) : planJson.current_weight_lbs != null ? toNum(planJson.current_weight_lbs) : 0;

  const goalWeight =
    planJson.goal_weight != null ? toNum(planJson.goal_weight) : planJson.goal_weight_lbs != null ? toNum(planJson.goal_weight_lbs) : 0;

  return {
    ...planJson,
    calories_target: caloriesTarget || null,
    protein_target: proteinTarget || null,
    fat_target: fatTarget || null,
    carbs: carbs || null,
    start_weight: startWeight || null,
    goal_weight: goalWeight || null
  };
}

async function resolveCustomerGidFromBody(body) {
  let rawId = body.customerId || body.shopifyCustomerId || body.customer_id || body.customer_id_raw || null;

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
          edges { node { id email } }
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

  // ✅ LOCK EXISTING START/GOAL (SERVER-SIDE SAFETY)
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
      try {
        existingPlan = JSON.parse(v);
      } catch {
        existingPlan = null;
      }
    }
  } catch (e) {
    console.warn("[LOCK] Failed to fetch existing coach_plan (continuing):", e?.message || e);
    existingPlan = null;
  }

  const normalizeNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };

  const existingStart = normalizeNum(existingPlan?.start_weight_lbs) ?? normalizeNum(existingPlan?.start_weight) ?? null;
  const existingGoal = normalizeNum(existingPlan?.goal_weight_lbs) ?? normalizeNum(existingPlan?.goal_weight) ?? null;

  if (existingStart) {
    planJson.start_weight = existingStart;
    planJson.start_weight_lbs = existingStart;
  }
  if (existingGoal) {
    planJson.goal_weight = existingGoal;
    planJson.goal_weight_lbs = existingGoal;
  }
  // ✅ END LOCK

  const startWeight =
    planJson.start_weight != null ? Number(planJson.start_weight) : planJson.current_weight_lbs != null ? Number(planJson.current_weight_lbs) : 0;

  const goalWeight =
    planJson.goal_weight != null ? Number(planJson.goal_weight) : planJson.goal_weight_lbs != null ? Number(planJson.goal_weight_lbs) : 0;

  const caloriesTarget = Number(planJson.calories_target) || 0;
  const proteinTarget = Number(planJson.protein_target) || 0;
  const fatTarget = Number(planJson.fat_target) || 0;

  let carbs = Number(planJson.carbs || 0);
  if (!carbs && caloriesTarget && proteinTarget && fatTarget) {
    const remaining = caloriesTarget - (proteinTarget * 4 + fatTarget * 9);
    if (remaining > 0) carbs = Math.round(remaining / 4);
  }

  const coachPlan = { ...planJson, start_weight: startWeight || planJson.start_weight || null, goal_weight: goalWeight || planJson.goal_weight || null, carbs };

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace type value }
        userErrors { field message }
      }
    }
  `;

  const metafields = [
    { ownerId, namespace: "custom", key: "coach_plan", type: "json", value: JSON.stringify(coachPlan) },
    { ownerId, namespace: "custom", key: "plan_json", type: "json", value: JSON.stringify(coachPlan) },
    { ownerId, namespace: "custom", key: "onboarding_complete", type: "single_line_text_field", value: "true" }
  ];

  if (startWeight) metafields.push({ ownerId, namespace: "custom", key: "start_weight", type: "number_integer", value: String(Math.round(startWeight)) });
  if (goalWeight) metafields.push({ ownerId, namespace: "custom", key: "goal_weight", type: "number_integer", value: String(Math.round(goalWeight)) });

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
   DAILY LOG HELPERS
   ================================================== */
function parseDailyCaloriesFromMessage(msg) {
  if (!msg || typeof msg !== "string") return null;
  const text = msg.toLowerCase();

  const mentionsDay = text.includes("today") || text.includes("for the day") || text.includes("whole day") || text.includes("all day") || text.includes("the day");

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

function pjGuessMealTypeFromUserText(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(breakfast|bfast)\b/.test(t)) return "breakfast";
  if (/\blunch\b/.test(t)) return "lunch";
  if (/\b(dinner|supper)\b/.test(t)) return "dinner";
  if (/\b(snack|snacks|dessert)\b/.test(t)) return "snack";
  return null; // do NOT default here
}

// ===============================
// MEAL HELPERS
// ===============================
function pjIsUnitBasedFood(text) {
  const t = String(text || "").toLowerCase();

  // ✅ If it contains obvious "non-unit" foods, DO NOT treat as unit-based
  // (prevents pizza + shake from becoming 200 calories)
  const nonUnitTriggers = [
    "pizza", "burrito", "taco", "burger", "fries", "rice", "pasta",
    "steak", "chicken", "ground", "potato", "chips", "wings",
    "sandwich", "sub", "wrap", "salad"
  ];
  for (let i = 0; i < nonUnitTriggers.length; i++) {
    if (t.includes(nonUnitTriggers[i])) return false;
  }

  // “countable / packaged / standard” foods
  const keywords = [
    "protein shake", "muscle milk", "premier protein", "fairlife", "core power",
    "ready to drink", "rtf",
    "protein bar", "kirkland", "quest", "rxbar",
    "yogurt", "greek yogurt",
    "string cheese", "cheese stick",
    "banana", "apple",
    "egg", "eggs",
    "647", "slice of bread", "toast"
  ];

  for (let i = 0; i < keywords.length; i++) {
    if (t.includes(keywords[i])) return true;
  }

  // explicit counts like "2 bars" or "1 shake"
  if (/\b(\d+)\b/.test(t) && (t.includes("shake") || t.includes("bar") || t.includes("yogurt") || t.includes("egg"))) {
    return true;
  }

  return false;
}


function pjLooksLikeFoodText(text) {
  const t = (text || "").toLowerCase();
  return (
    /\b(i\s*(ate|had)|ate|had|for\s+(breakfast|bfast|lunch|dinner|snack)|log (this|my) (meal|food))\b/.test(t) ||
    /\b(oz|ounce|ounces|tbsp|tsp|cup|cups|g|gram|grams|slice|slices|wrap|bar|shake)\b/.test(t) ||
    /\b(cal(orie|ories)|cals|protein|carb|carbs|fat|macros)\b/.test(t)
  );
}

function pjHasPortionsOrUnits(text) {
  const t = String(text || "").toLowerCase();
  return (
    /\b(\d+(\.\d+)?)\s*(oz|ounce|ounces|g|gram|grams|kg|lb|lbs|cup|cups|tbsp|tablespoon|tsp|teaspoon|slice|slices|serving|srv|piece|pcs)\b/i.test(t) ||
    /\b(one|two|three|half|quarter)\b\s*(cup|cups|tbsp|tablespoon|tsp|teaspoon|slice|slices|serving|piece)\b/i.test(t)
  );
}

function extractFoodLikeText(text) {
  if (!text) return null;

  const original = String(text).trim();
  if (!original) return null;

  const lower = original.toLowerCase();

  const convoPhrases = [
    "sounds good", "bad day", "yesterday", "stay under", "trying to", "i’m trying", "im trying",
    "can you help", "what should i", "do you think", "do you have", "question", "plan",
    "targets", "calories left", "how many calories left", "log it out", "log out for"
  ];
  const convoHit = convoPhrases.some((p) => lower.includes(p));

  const futureIntent =
    /\b(i(?:'|’)m|im)\s+going\s+to\s+have\b/i.test(original) ||
    /\b(i(?:'|’)ll|ill)\s+have\b/i.test(original) ||
    /\bi\s+will\s+have\b/i.test(original);

  const isLong = original.length > 180;
  const hasQuestionMark = original.includes("?");

  if (futureIntent) return null;
  if ((convoHit && isLong) || (hasQuestionMark && isLong)) return null;

  let candidate = original;

  const header = lower.match(/^\s*(meal|breakfast|bfast|lunch|dinner|supper|snack|snacks|dessert)\s*[:\-–]\s*(.+)$/i);
  if (header) {
    candidate = (header[2] || "").trim();
  } else {
    const ateHad = lower.match(/\b(i\s*(ate|had))\b/);
    if (ateHad && ateHad.index != null) candidate = original.slice(ateHad.index);
  }

  candidate = candidate
    .replace(/^\s*(hey|hi|coach|please|can you|could you)\b[:,]?\s*/i, "")
    .replace(/^\s*(log|track|add|save)\b\s*/i, "")
    .replace(/^\s*(for\s+)?(meal|breakfast|bfast|lunch|dinner|supper|snacks?)\b\s*(was)?\s*[:\-–,]?\s*/i, "")
    .trim();

  if (!candidate) return null;

  const foodWordsRe =
    /\b(egg|eggs|toast|bread|butter|cheese|chicken|beef|steak|rice|potato|fries|burger|sandwich|wrap|salad|pizza|pasta|taco|burrito|protein|shake|bar|yogurt|oat|oats|banana|apple|berries|granola|cereal|milk|coffee)\b/i;

  const unitsRe =
    /\b(\d+(\.\d+)?)\s*(oz|ounce|ounces|g|gram|grams|kg|lb|lbs|cup|cups|tbsp|tablespoon|tsp|teaspoon|slice|slices|serving|piece|pcs)\b/i;

  const brandRe = /\b(kirkland|premier|fairlife|quest|chipotle|mcdonalds|starbucks)\b/i;

  const hasFoodWord = foodWordsRe.test(candidate);
  const hasUnits = unitsRe.test(candidate);
  const hasBrand = brandRe.test(candidate);

  if (!hasFoodWord) return null;

  const isShort = candidate.length <= 80;
  if (!hasUnits && !hasBrand && !isShort) return null;

  if (candidate.length > 220) return null;

  candidate = candidate
    .replace(/\b(ok|okay|sounds good|thank you|thanks|yeah|yep|nope|nah|i think|probably|maybe)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return candidate || null;
}

function pjLooksLikeNonFoodMessage(text) {
  try {
    if (typeof extractFoodLikeText === "function") return !extractFoodLikeText(text);
  } catch (e) {}
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return true;
  const foodish = /(chicken|rice|steak|eggs?|shake|bar|yogurt|sandwich|pizza|burrito|wrap|bread|cheese|salad|pasta|burger|fries)/i;
  return !foodish.test(t);
}

/* ==========================================
   DAILY LOGS METAFIELD HELPERS
   ========================================== */
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
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
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
    throw new Error("Shopify userErrors when saving daily_logs: " + userErrors.map((e) => `${(e.field || []).join(".")}: ${e.message}`).join(" | "));
  }
}

// ✅ FIXED: use dateKey (client-local)
async function upsertDailyTotalCalories(customerGid, calories, dateKey) {
  if (!customerGid || !calories || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);
  const idx = logs.findIndex((entry) => entry && entry.date === dateKey);

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date: dateKey,
      calories,
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
      calories,
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

async function upsertDailyLog(customerGid, dailyLog, dateKey) {
  if (!customerGid || !dailyLog || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date = typeof dailyLog.date === "string" && dailyLog.date.trim() ? dailyLog.date.trim() : dateKey;
  const idx = logs.findIndex((entry) => entry && entry.date === date);

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
  const notes = typeof dailyLog.notes === "string" && dailyLog.notes.trim() ? dailyLog.notes.trim() : null;

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = {
      ...existing,
      date,
      weight: weight !== null ? weight : existing.weight ?? null,
      steps: steps !== null ? steps : existing.steps ?? null,
      calories: calories !== null ? calories : existing.calories ?? existing.total_calories ?? null,
      total_calories: calories !== null ? calories : existing.total_calories ?? existing.calories ?? null,
      total_protein: protein !== null ? protein : existing.total_protein ?? existing.protein ?? null,
      total_carbs: carbs !== null ? carbs : existing.total_carbs ?? existing.carbs ?? null,
      total_fat: fat !== null ? fat : existing.total_fat ?? existing.fat ?? null,
      meals: Array.isArray(existing.meals) ? existing.meals : [],
      mood: existing.mood ?? null,
      struggle: existing.struggle ?? null,
      coach_focus: existing.coach_focus || notes || existing.notes || "Daily check-in logged from chat.",
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

/* ==========================================
   MEAL OVERRIDE DETECTOR + NORMALIZE
   ========================================== */
function normalizeMealType(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (t === "bfast" || t === "breakfast") return "Breakfast";
  if (t === "lunch") return "Lunch";
  if (t === "dinner" || t === "supper") return "Dinner";
  if (t === "snack" || t === "snacks" || t === "snaks" || t === "dessert") return "Snacks";
  return null; // do NOT default
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
  if (!itemText) return null;

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
// ===============================
// WEEKLY SUMMARY HELPERS (last 7 days)
// ===============================

function pjYmdToUtcDate(ymd) {
  // ymd: "YYYY-MM-DD"
  if (!isYMD(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(n => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function pjUtcDateToYmd(d) {
  if (!(d instanceof Date)) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pjAddDaysYmd(ymd, deltaDays) {
  const dt = pjYmdToUtcDate(ymd);
  if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays || 0));
  return pjUtcDateToYmd(dt);
}

function pjNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pjGetPlanTargetsFromPlan(plan) {
  if (!plan || typeof plan !== "object") return {
    calories_target: null,
    protein_target: null,
    calories_zone: 150,
    protein_zone: 20
  };

  const calories_target = pjNumOrNull(plan.calories_target ?? plan.calories);
  const protein_target = pjNumOrNull(plan.protein_target ?? plan.protein);

  return {
    calories_target,
    protein_target,
    calories_zone: 150,
    protein_zone: 20
  };
}

function pjComputeWeeklySummary(logs, dateKey, plan) {
  const out = {
    ok: true,
    start: null,
    end: dateKey,
    days_with_any_log: 0,
    avg_calories: null,
    avg_protein: null,
    avg_steps: null,
    weight_delta_7d: null,
    weight_trend_note: "unknown",
    adherence_calories_pct: null,
    adherence_protein_pct: null
  };

  if (!Array.isArray(logs) || !isYMD(dateKey)) {
    out.ok = false;
    return out;
  }

  const targets = pjGetPlanTargetsFromPlan(plan);
  const startKey = pjAddDaysYmd(dateKey, -6);
  out.start = startKey;

  // Build a map for quick lookup
  const map = new Map();
  for (const e of logs) {
    if (e && typeof e.date === "string") map.set(e.date, e);
  }

  let calsSum = 0, calsCount = 0;
  let pSum = 0, pCount = 0;
  let stepsSum = 0, stepsCount = 0;

  let anyLogDays = 0;

  let adherCalOk = 0, adherCalCount = 0;
  let adherProtOk = 0, adherProtCount = 0;

  // Weight trend: first non-null and last non-null in window
  let firstW = null, lastW = null;

  for (let i = 0; i < 7; i++) {
    const dayKey = pjAddDaysYmd(startKey, i);
    const entry = map.get(dayKey);
    if (!entry) continue;

    const dayHasAny =
      entry.weight != null ||
      entry.steps != null ||
      entry.calories != null ||
      entry.total_calories != null ||
      (Array.isArray(entry.meals) && entry.meals.length);

    if (dayHasAny) anyLogDays++;

    const dayCals = pjNumOrNull(entry.total_calories ?? entry.calories);
    if (dayCals != null) {
      calsSum += dayCals;
      calsCount++;

      if (targets.calories_target != null) {
        adherCalCount++;
        if (Math.abs(dayCals - targets.calories_target) <= (targets.calories_zone || 150)) {
          adherCalOk++;
        }
      }
    }

    const dayProt = pjNumOrNull(entry.total_protein ?? entry.protein ?? entry.protein_g);
    if (dayProt != null) {
      pSum += dayProt;
      pCount++;

      if (targets.protein_target != null) {
        adherProtCount++;
        if (Math.abs(dayProt - targets.protein_target) <= (targets.protein_zone || 20)) {
          adherProtOk++;
        }
      }
    }

    const daySteps = pjNumOrNull(entry.steps);
    if (daySteps != null) {
      stepsSum += daySteps;
      stepsCount++;
    }

    const w = pjNumOrNull(entry.weight);
    if (w != null) {
      if (firstW == null) firstW = w;
      lastW = w;
    }
  }

  out.days_with_any_log = anyLogDays;

  out.avg_calories = calsCount ? Math.round(calsSum / calsCount) : null;
  out.avg_protein  = pCount ? Math.round(pSum / pCount) : null;
  out.avg_steps    = stepsCount ? Math.round(stepsSum / stepsCount) : null;

  if (firstW != null && lastW != null) {
    const delta = lastW - firstW;
    out.weight_delta_7d = Math.round(delta * 10) / 10;
    if (delta <= -0.3) out.weight_trend_note = "down";
    else if (delta >= 0.3) out.weight_trend_note = "up";
    else out.weight_trend_note = "flat";
  }

  out.adherence_calories_pct = adherCalCount ? Math.round((adherCalOk / adherCalCount) * 100) : null;
  out.adherence_protein_pct  = adherProtCount ? Math.round((adherProtOk / adherProtCount) * 100) : null;

  return out;
}

function pjWeeklySummaryToSystemText(sum, plan) {
  if (!sum || sum.ok !== true) return null;

  const targets = pjGetPlanTargetsFromPlan(plan);

  const lines = [];
  lines.push(`WEEKLY_CONTEXT (last 7 days, ${sum.start} to ${sum.end}):`);

  lines.push(`- Days with any log: ${sum.days_with_any_log}/7`);

  if (sum.avg_calories != null) {
    if (targets.calories_target != null) {
      lines.push(`- Avg calories: ${sum.avg_calories} (target ${targets.calories_target}, zone +/-${targets.calories_zone})`);
    } else {
      lines.push(`- Avg calories: ${sum.avg_calories}`);
    }
  } else {
    lines.push(`- Avg calories: unknown`);
  }

  if (sum.avg_protein != null) {
    if (targets.protein_target != null) {
      lines.push(`- Avg protein: ${sum.avg_protein}g (target ${targets.protein_target}g, zone +/-${targets.protein_zone}g)`);
    } else {
      lines.push(`- Avg protein: ${sum.avg_protein}g`);
    }
  } else {
    lines.push(`- Avg protein: unknown`);
  }

  if (sum.avg_steps != null) lines.push(`- Avg steps: ${sum.avg_steps}`);
  else lines.push(`- Avg steps: unknown`);

  if (sum.weight_delta_7d != null) {
    lines.push(`- Weight trend: ${sum.weight_trend_note} (${sum.weight_delta_7d} lb over 7d)`);
  } else {
    lines.push(`- Weight trend: unknown`);
  }

  if (sum.adherence_calories_pct != null) {
    lines.push(`- Calories adherence: ${sum.adherence_calories_pct}% days in zone`);
  }
  if (sum.adherence_protein_pct != null) {
    lines.push(`- Protein adherence: ${sum.adherence_protein_pct}% days in zone`);
  }

  // Make it actionable for the model
  lines.push(`Use this weekly context to give pattern-based coaching. Do NOT invent missing days.`);

  return lines.join("\n");
}

function localYMD() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

function pjGetHourInNY() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

function pjInferMealTypeFromClock() {
  const h = pjGetHourInNY();
  if (h === null) return "Snacks";
  if (h >= 5 && h < 11) return "Breakfast";
  if (h >= 11 && h < 16) return "Lunch";
  if (h >= 16 && h < 21) return "Dinner";
  return "Snacks";
}

function detectMealCorrection(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return false;
  const t = userMsg.toLowerCase();
  return /\b(wrong|incorrect|actually|should be|not right|label|nutrition label|it’s|its)\b/.test(t) || /\b(\d{1,4})\s*(cal|cals|calories|kcal)\b/.test(t);
}
function isExplicitMealAdjustment(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase();

  return (
    /\b(adjust|actually|correction|wrong|incorrect|should be|it was|its)\b/.test(t) &&
    /\b(\d{2,4})\s*(cal|cals|calories|kcal|protein|g)\b/.test(t)
  );
}

function getLastMealTypeFromLogs(logs, dateKey) {
  if (!Array.isArray(logs) || !dateKey) return null;
  const day = logs.find((x) => x && x.date === dateKey);
  const meals = Array.isArray(day?.meals) ? day.meals : [];
  if (!meals.length) return null;
  const last = meals[meals.length - 1];
  return normalizeMealType(last?.meal_type || null);
}

/* ==========================================
   MEAL UPSERT
   ========================================== */
async function upsertMealLog(customerGid, meal, dateKey, options = {}) {
  if (!customerGid || !meal) return;

  const cleanDate = isYMD(dateKey) ? dateKey : localYMD();
  const { logs } = await getDailyLogsMetafield(customerGid);
  const idx = logs.findIndex((entry) => entry && entry.date === cleanDate);

  const cals = Number(meal.calories) || 0;
  const protein = Number(meal.protein) || 0;
  const carbs = Number(meal.carbs) || 0;
  const fat = Number(meal.fat) || 0;

  const mealType = normalizeMealType(meal.meal_type) || null;
  const items = pjNormalizeMealItems(meal.items);
  if (!items.length) return;

  const replaceMealType = options.replaceMealType || null;
  const replaceLast = options.replaceLast === true;

  const desc = items.map((it) => it?.name).filter(Boolean).join(", ");

  const newMeal = {
    meal_type: mealType,
    items,
    description: desc,
    text: desc,
    calories: Math.round(cals),
    protein: pjRound1(protein),
    carbs: pjRound1(carbs),
    fat: pjRound1(fat)
  };

  if (idx >= 0) {
    const existing = logs[idx] || {};
    const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];
    let baseMeals = existingMeals;

    if (replaceLast && existingMeals.length) {
      baseMeals = existingMeals.slice(0, -1);
    } else if (replaceMealType) {
      const rt = normalizeMealType(replaceMealType) || replaceMealType;
      baseMeals = existingMeals.filter((m) => normalizeMealType(m?.meal_type) !== rt);
    }

    const updatedMeals = baseMeals.concat([newMeal]);

    let sumCals = 0,
      sumP = 0,
      sumC = 0,
      sumF = 0;
    updatedMeals.forEach((m) => {
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
    logs.push({
      date: cleanDate,
      weight: null,
      steps: null,
      meals: [newMeal],
      mood: null,
      struggle: null,
      coach_focus: "Meals logged from chat.",
      calories: newMeal.calories || null,
      total_calories: newMeal.calories || null,
      total_protein: newMeal.protein || null,
      total_carbs: newMeal.carbs || null,
      total_fat: newMeal.fat || null
    });
  }

  await saveDailyLogsMetafield(customerGid, logs);
}

/* ==========================================
   DAILY REVIEW / COACH REVIEW UPSERT
   ========================================== */
async function upsertDailyReview(customerGid, review, dateKey) {
  if (!customerGid || !review || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date = review.date && typeof review.date === "string" && review.date.trim() ? review.date.trim() : dateKey;

  const summary =
    typeof review.summary === "string" && review.summary.trim()
      ? review.summary.trim()
      : "Keep it simple: hit your calories as best you can, move a bit, and log it honestly.";

  const riskColor = review.risk_color || "green";
  const needsHumanReview = !!review.needs_human_review;

  const idx = logs.findIndex((entry) => entry && entry.date === date);

  if (idx >= 0) {
    const existing = logs[idx] || {};
    logs[idx] = { ...existing, date, coach_focus: summary, risk_color: riskColor, needs_human_review: needsHumanReview };
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

async function upsertCoachReview(customerGid, coachReview, dateKey) {
  if (!customerGid || !coachReview || !dateKey) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const date = typeof coachReview.date === "string" && coachReview.date.trim() ? coachReview.date.trim() : dateKey;
  const idx = logs.findIndex((entry) => entry && entry.date === date);

  const safeArr = (v) => (Array.isArray(v) ? v : []);
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
   PENDING MEAL (MEAL TYPE PICKER FLOW)
   ========================================== */
function isMealTypeOnly(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["breakfast", "bfast", "lunch", "dinner", "supper", "snack", "snacks", "dessert"].includes(t);
}

async function getPendingMeal(customerGid) {
  if (!customerGid) return null;
  const q = `
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"custom", key:"pending_meal") { value }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: customerGid });
  const v = data?.customer?.metafield?.value;
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function setPendingMeal(customerGid, payloadOrNull) {
  if (!customerGid) return;
  const mutation = `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }
  `;
  const value = payloadOrNull ? JSON.stringify(payloadOrNull) : "";

  const data = await shopifyGraphQL(mutation, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: "custom",
        key: "pending_meal",
        type: "json",
        value
      }
    ]
  });

  const userErrors = data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) console.error("metafieldsSet userErrors (pending_meal):", userErrors);
}
// ===============================
// COACH FALLBACK ESTIMATOR (stops portion loops)
// ===============================

function pjUserIsUnsure(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("not sure") ||
    t.includes("no idea") ||
    t.includes("dont know") ||
    t.includes("don't know") ||
    t.includes("idk") ||
    t.includes("guess") ||
    t.includes("rough") ||
    t.includes("approx") ||
    t.includes("approximately")
  );
}

function pjEstimateMealFallback(rawText, mealType, dateKey) {
  const t = String(rawText || "").toLowerCase();

  let calories = 0, protein = 0, carbs = 0, fat = 0;
  const items = [];

  // --- Pizza slices heuristic ---
  // NY slice often 280-350 cals. Default 320 unless "small/thin" mentioned.
  const sliceMatch = t.match(/(\d+)\s*(?:slice|slices)\s*(?:of\s*)?pizza/);
  if (sliceMatch) {
    const n = Math.max(1, parseInt(sliceMatch[1], 10) || 1);
    let per = 320;
    if (t.includes("thin")) per = 280;
    if (t.includes("deep dish")) per = 420;
    calories += n * per;
    protein += n * 12;
    carbs   += n * 36;
    fat     += n * 12;
    items.push(`${n} slice(s) pizza (estimated)`);
  } else if (t.includes("pizza")) {
    // If they said pizza but not slices, assume 2 slices
    calories += 640; protein += 24; carbs += 72; fat += 24;
    items.push("pizza (estimated ~2 slices)");
  }

  // --- Muscle Milk / RTD shake heuristic ---
  // If they say "muscle milk" assume 1 bottle unless they say "2" or "half"
  if (t.includes("muscle milk")) {
    let bottles = 1;
    const m = t.match(/(\d+)\s*(?:muscle milk|shake)/);
    if (m) bottles = Math.max(1, parseInt(m[1], 10) || 1);
    // Classic RTD varies by product; use a safe mid estimate:
    // ~160-200 cals, ~25g protein
    calories += bottles * 180;
    protein  += bottles * 25;
    carbs    += bottles * 10;
    fat      += bottles * 5;
    items.push(`${bottles} Muscle Milk shake (estimated)`);
  } else if (t.includes("protein shake") || t.includes("protein shake")) {
    calories += 200; protein += 25; carbs += 10; fat += 5;
    items.push("protein shake (estimated)");
  }

  // Safety minimums: if we couldn't parse anything, return null so caller can ask once
  if (!items.length) return null;

  return {
    date: dateKey,
    meal_type: mealType,
    items,
    calories: Math.round(calories),
    protein: pjRound1(protein),
    carbs: pjRound1(carbs),
    fat: pjRound1(fat)
  };
}

/* ==========================================================
   MAIN HANDLER
   ========================================================== */
async function handler(req, res) {

  // ===== CORS (SHOPIFY -> VERCEL) =====
  const origin = req.headers.origin || "";

  const ALLOWED_ORIGINS = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com",
    "https://pjifitness.myshopify.com"
  ]);

  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");

  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders
      ? String(reqHeaders)
      : "Content-Type, Authorization, X-Requested-With, Accept"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  // ===== END CORS =====

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error("Error parsing body", e);
    return res.status(400).json({
      error: "Invalid request body",
      debug: { parseError: String(e?.message || e) }
    });
  }

  const clientDate = body?.clientDate;
  const dateKey = isYMD(clientDate) ? clientDate : localYMD();

  const userMessage = body.message || "";
  const history = Array.isArray(body.history) ? body.history : [];
  const appendUserMessage = !!body.appendUserMessage;
  const email = body.email || null;

  if (!userMessage && !history.length) {
    return res.status(400).json({ error: "Missing 'message' in body" });
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
  let postPlanStage = null;
  let coachPlanObj = null;
  let weeklyContextText = null;

  if (customerGid) {
    try {
      shopifyMetafieldReadStatus = "fetching";
      const data = await shopifyGraphQL(
        `
        query GetCustomerFlags($id: ID!) {
          customer(id: $id) {
            onboarding: metafield(namespace: "custom", key: "onboarding_complete") { value }
            postStage: metafield(namespace: "custom", key: "post_plan_stage") { value }
          }
        }
        `,
        { id: customerGid }
      );

      const val = data?.customer?.onboarding?.value;
      const stageVal = data?.customer?.postStage?.value;

      if (typeof val === "string") onboardingComplete = val === "true";
      postPlanStage = typeof stageVal === "string" ? stageVal : null;

      shopifyMetafieldReadStatus = "success";
    } catch (e) {
      console.error("Error fetching customer metafields", e);
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
    post_plan_stage: postPlanStage || null,
    shopifyMetafieldReadStatus,
    dateKey,
    clientDate: clientDate || null,
    messagesCount: null,
    model: "gpt-4.1-mini"
  };

  // ============================================================
  // OVERLAY ONBOARDING SHORT-CIRCUIT (<ONBOARDING_JSON>)
  // ============================================================

  const onboardingJsonText = extractTagBlock(userMessage, "ONBOARDING_JSON");
  const hasOnboardingJson = !!onboardingJsonText;

  if (hasOnboardingJson) {
    if (!customerGid) {
      return res.status(200).json({
        reply: "Please sign in so I can save your plan to your account.",
        debug: { ...debug, onboardingOverlay: true, error: "no_customerGid" },
        free_chat_remaining: null
      });
    }

    let ob;
    try {
      ob = JSON.parse(onboardingJsonText);
    } catch (e) {
      return res.status(200).json({
        reply: "I couldn’t read those answers. Please click Generate Plan again.",
        debug: { ...debug, onboardingOverlay: true, onboarding_parse_failed: true },
        free_chat_remaining: null
      });
    }

    const plan = computePlanFromOverlayOnboarding(ob, dateKey);

    try {
      await saveCoachPlanForCustomer(customerGid, plan);

      try {
        await setPostPlanStage(customerGid, "plan_questions");
        postPlanStage = "plan_questions";
      } catch (e) {
        console.warn("Failed to set post_plan_stage:", e?.message || e);
      }

      if (plan.current_weight_lbs != null) {
        const w = Number(plan.current_weight_lbs);
        if (Number.isFinite(w) && w > 0) {
          try {
            await upsertDailyLog(
              customerGid,
              {
                date: dateKey,
                weight: w,
                calories: null,
                protein_g: null,
                carbs_g: null,
                fat_g: null,
                steps: null,
                notes: "Initial weight from onboarding."
              },
              dateKey
            );
          } catch (e) {
            console.warn("Failed to write initial daily weight:", e?.message || e);
          }
        }
      }
    } catch (e) {
      console.error("Overlay onboarding save failed:", e);
      return res.status(200).json({
        reply: "I had trouble saving your plan. Please try again.",
        debug: { ...debug, onboardingOverlay: true, save_failed: true, save_error: String(e?.message || e) },
        free_chat_remaining: null
      });
    }

    const firstName = (String(plan.user_name || "").trim().split(" ")[0]) || "there";

    const reply =
      `Hey ${firstName} — I’m your PJiFitness coach 👋\n\n` +
      `✅ Your plan is saved.\n\n` +
      `Daily targets:\n` +
      `• ${plan.calories_target} calories/day\n` +
      `• ${plan.protein_target}g protein • ${plan.carbs}g carbs • ${plan.fat_target}g fat\n\n` +
      `One next action: log today’s weight + one meal so we start your streak.\n\n` +
      `Any questions about your plan?`;

    let remainingNow = null;
    try {
      let r = await getFreeChatRemaining(customerGid);
      if (r === null) {
        r = 30;
        await setFreeChatRemaining(customerGid, r);
      }
      remainingNow = r;
    } catch (e) {}

    return res.status(200).json({
      reply,
      plan_json: plan,
      coach_plan: plan,
      free_chat_remaining: remainingNow,
      debug: { ...debug, onboardingOverlay: true, planSavedToShopify: true, plan_json: plan }
    });
  }

  // ============================================================
  // FREE PREVIEW MESSAGE GATE
  // ============================================================
  let remainingAfter = null;
  const FREE_START = 30;
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
            debug: { ...debug, free_chat_remaining: 0, isSubscriber }
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
// ===============================
// WEEKLY CONTEXT (pull plan + last 7 days summary)
// ===============================
if (customerGid) {
  try {
    // 1) Get coach_plan
    const planData = await shopifyGraphQL(
      `
      query GetCoachPlan($id: ID!) {
        customer(id: $id) {
          plan: metafield(namespace:"custom", key:"coach_plan") { value }
        }
      }
      `,
      { id: customerGid }
    );

    const pv = planData?.customer?.plan?.value;
    if (pv) {
      try { coachPlanObj = JSON.parse(pv); } catch { coachPlanObj = null; }
    }

    // 2) Get daily logs array (already used elsewhere)
    const dl = await getDailyLogsMetafield(customerGid);
    const logs = Array.isArray(dl?.logs) ? dl.logs : [];

    const weekly = pjComputeWeeklySummary(logs, dateKey, coachPlanObj);
    weeklyContextText = pjWeeklySummaryToSystemText(weekly, coachPlanObj);

    debug.weeklyContextBuilt = !!weeklyContextText;
    debug.weeklyContextSample = weekly;
  } catch (e) {
    debug.weeklyContextBuilt = false;
    debug.weeklyContextError = String(e?.message || e);
  }
}

  // ============================================================
  // PENDING MEAL RESOLUTION (runtime)
  // ============================================================
  if (customerGid) {
    try {
      const pending = await getPendingMeal(customerGid);
      const hasPending = pending && typeof pending.raw_text === "string" && pending.raw_text.trim();

      if (hasPending && pjLooksLikeNonFoodMessage(userMessage)) {
        await setPendingMeal(customerGid, null);
        debug.pendingMealCleared = true;
      }

      // If they picked meal type only
      if (hasPending && isMealTypeOnly(userMessage)) {
        const mtRaw = String(userMessage || "").trim().toLowerCase();
        const mt =
          mtRaw === "bfast" || mtRaw === "breakfast"
            ? "Breakfast"
            : mtRaw === "lunch"
              ? "Lunch"
              : mtRaw === "dinner" || mtRaw === "supper"
                ? "Dinner"
                : mtRaw === "snack" || mtRaw === "snacks" || mtRaw === "dessert"
                  ? "Snacks"
                  : null;

        if (!mt) {
          await setPendingMeal(customerGid, null);
          return res.status(200).json({
            reply: "Got it — can you pick one: breakfast, lunch, dinner, or snacks?",
            debug: { ...debug, pendingMealResolved: false, pendingMealResolvedReason: "invalid_meal_type" },
            free_chat_remaining: remainingAfter
          });
        }

        const base = pjInternalUrl("");
        const nutRes = await fetch(`${base}/api/nutrition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: String(pending.raw_text || "").trim(), customerId: customerNumericId || customerGid })
        });

        const nut = nutRes.ok ? await nutRes.json().catch(() => null) : null;
        const items = Array.isArray(nut?.items) ? nut.items : [];
        const totals = nut?.totals && typeof nut.totals === "object" ? nut.totals : null;
        const needs = Array.isArray(nut?.needs_clarification) ? nut.needs_clarification : [];
        const incomplete = nut?.incomplete === true || needs.length > 0 || !totals;
        const unitBased = pjIsUnitBasedFood(pending.raw_text);

       if (!nut || nut.ok !== true || incomplete) {
 const est = pjEstimateMealFallback(
  String(pending.raw_text || "").trim(),
  mt,
  dateKey
);

if (!est) {
  await setPendingMeal(customerGid, null);
  return res.status(200).json({
    reply: "I couldn’t confidently estimate that — can you add a bit more detail?",
    free_chat_remaining: remainingAfter,
    debug
  });
}

await setPendingMeal(customerGid, null);
await upsertMealLog(customerGid, est, dateKey);


  return res.status(200).json({
    reply:
      `Logged your ${mt.toLowerCase()} (estimated):\n` +
      items.map(i => `• ${i.name || i}`).join("\n") +
      `\n\nEstimated: ${est.calories} calories — ${est.protein}g P, ${est.carbs}g C, ${est.fat}g F.\n\n` +
      `If you want this tighter later, you can say things like “burger 6oz” or “medium fries”.`,
    debug: { portionFallbackUsed: true },
    free_chat_remaining: remainingAfter
  });
}

        // unit-based fallback if totals missing
        if ((!totals || !items.length) && unitBased) {
          const fallbackMeal = { date: dateKey, meal_type: mt, items: [String(pending.raw_text || "Item")], calories: 200, protein: 20, carbs: 10, fat: 5 };
          await setPendingMeal(customerGid, null);
          await upsertMealLog(customerGid, fallbackMeal, dateKey);

          return res.status(200).json({
            reply:
              `Logged your ${mt.toLowerCase()}:\n• ${fallbackMeal.items[0]}\n\n` +
              `Estimated: ${fallbackMeal.calories} calories — ${fallbackMeal.protein}g protein, ${fallbackMeal.carbs}g carbs, ${fallbackMeal.fat}g fat.`,
            debug,
            free_chat_remaining: remainingAfter
          });
        }

        await setPendingMeal(customerGid, null);

        const meal = {
          date: dateKey,
          meal_type: mt,
          items: items.map((it) => ({
            name: String(it?.name || it?.matched_to || it?.text || "Food").trim(),
            calories: Math.round(Number(it?.calories) || 0),
            protein: pjRound1(Number(it?.protein) || 0),
            carbs: pjRound1(Number(it?.carbs) || 0),
            fat: pjRound1(Number(it?.fat) || 0)
          })),
          calories: Math.round(Number(totals?.calories) || 0),
          protein: pjRound1(Number(totals?.protein) || 0),
          carbs: pjRound1(Number(totals?.carbs) || 0),
          fat: pjRound1(Number(totals?.fat) || 0)
        };

        await upsertMealLog(customerGid, meal, dateKey);

        const itemsList = (meal.items || [])
          .map((it) => `• ${it.name} — ${it.calories} cal (${it.protein}P / ${it.carbs}C / ${it.fat}F)`)
          .join("\n");

        return res.status(200).json({
          reply: `Logged your ${mt.toLowerCase()}:\n${itemsList}\n\nEstimated: ${meal.calories} calories — ${meal.protein}g protein, ${meal.carbs}g carbs, ${meal.fat}g fat.`,
          debug: { ...debug, pendingMealResolved: true, pendingMealResolvedType: mt },
          free_chat_remaining: remainingAfter
        });
      }

      // If pending already has meal_type and user adds more details (combine for nutrition only)
      if (hasPending && pending.meal_type && !isMealTypeOnly(userMessage)) {
        const mt = normalizeMealType(pending.meal_type) || pending.meal_type;
        const base = pjInternalUrl("");
        const combinedText = `${String(pending.raw_text || "").trim()}, ${String(userMessage || "").trim()}`.trim();

        const nutRes = await fetch(`${base}/api/nutrition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: combinedText, customerId: customerNumericId || customerGid })
        });

        const nut = nutRes.ok ? await nutRes.json().catch(() => null) : null;
        const items = Array.isArray(nut?.items) ? nut.items : [];
        const totals = nut?.totals && typeof nut.totals === "object" ? nut.totals : null;
        const needs = Array.isArray(nut?.needs_clarification) ? nut.needs_clarification : [];
        const incomplete = nut?.incomplete === true || needs.length > 0 || !totals;

        const unitBased = pjIsUnitBasedFood(pending.raw_text);

        if (!nut || nut.ok !== true || incomplete) {
  // ✅ If user is unsure, STOP asking and estimate like ChatGPT
  const userUnsure = pjUserIsUnsure(userMessage);

  if (userUnsure) {
    const est = pjEstimateMealFallback(
      `${String(pending.raw_text || "").trim()} ${String(userMessage || "").trim()}`,
      mt,
      dateKey
    );

    if (est) {
      await setPendingMeal(customerGid, null);
      await upsertMealLog(customerGid, est, dateKey);

      return res.status(200).json({
        reply:
          `No worries — I’ll estimate this.\n\n` +
          `Logged your ${mt.toLowerCase()}:\n` +
          est.items.map(x => `• ${x}`).join("\n") + `\n\n` +
          `Estimated: ${est.calories} calories — ${est.protein}g P, ${est.carbs}g C, ${est.fat}g F.\n\n` +
          `If you ever want it tighter, just tell me “3 slices” or “thin crust”.`,
        debug: { ...debug, portionFallbackUsed: true },
        free_chat_remaining: remainingAfter
      });
    }
  }

        if ((!totals || !items.length) && unitBased) {
          const fallbackMeal = { date: dateKey, meal_type: mt, items: [String(pending.raw_text || "Item")], calories: 200, protein: 20, carbs: 10, fat: 5 };
          await setPendingMeal(customerGid, null);
          await upsertMealLog(customerGid, fallbackMeal, dateKey);

          return res.status(200).json({
            reply:
              `Logged your ${mt.toLowerCase()}:\n• ${fallbackMeal.items[0]}\n\n` +
              `Estimated: ${fallbackMeal.calories} calories — ${fallbackMeal.protein}g protein, ${fallbackMeal.carbs}g carbs, ${fallbackMeal.fat}g fat.`,
            debug,
            free_chat_remaining: remainingAfter
          });
        }

        await setPendingMeal(customerGid, null);

        const meal = {
          date: dateKey,
          meal_type: mt,
          items: items.map((it) => ({
            name: String(it?.name || it?.matched_to || it?.text || "Food").trim(),
            calories: Math.round(Number(it?.calories) || 0),
            protein: pjRound1(Number(it?.protein) || 0),
            carbs: pjRound1(Number(it?.carbs) || 0),
            fat: pjRound1(Number(it?.fat) || 0)
          })),
          calories: Math.round(Number(totals?.calories) || 0),
          protein: pjRound1(Number(totals?.protein) || 0),
          carbs: pjRound1(Number(totals?.carbs) || 0),
          fat: pjRound1(Number(totals?.fat) || 0)
        };

        await upsertMealLog(customerGid, meal, dateKey);

        const itemsList = (meal.items || [])
          .map((it) => `• ${it.name} — ${it.calories} cal (${it.protein}P / ${it.carbs}C / ${it.fat}F)`)
          .join("\n");

        try {
  return res.status(200).json({
    reply: `Logged your ${mt.toLowerCase()}:\n${itemsList}\n\nEstimated: ${meal.calories} calories`,
    debug: { ...debug, pendingMealResolved: true, pendingMealResolvedType: mt },
    free_chat_remaining: remainingAfter
  });
} catch (e) {
  debug.pendingMealResolveError = String(e?.message || e);
}

  // ============================================================
// AUTO MEAL LOG FROM NATURAL CHAT (simple + reliable)
// ============================================================
if (customerGid && userMessage && !isExplicitMealAdjustment(userMessage)) {

  // SAFETY: do NOT auto-log if a pending meal flow exists
  const pendingExisting = await getPendingMeal(customerGid);

  if (!pendingExisting) {
    try {
      const foodText = extractFoodLikeText(userMessage);
      if (!foodText) {
        debug.autoMealSkipped = "no_food_text";
      } else {

        let guessed = pjGuessMealTypeFromUserText(userMessage);
        if (!guessed && /^\s*meal\s*[:\-–]/i.test(String(userMessage || ""))) {
          guessed = pjInferMealTypeFromClock();
        }

        // Ask for meal type if missing
        if (!guessed) {
          await setPendingMeal(customerGid, {
            date: dateKey,
            raw_text: String(foodText || "").trim()
          });

          return res.status(200).json({
            reply: "Got it — what meal was this? (breakfast, lunch, dinner, or snacks)",
            free_chat_remaining: remainingAfter,
            debug: { ...debug, pendingMealSaved: true, ui_pending_reason: "missing_meal_type" }
          });
        }

        const mealType = normalizeMealType(guessed);
        if (!mealType) {
          debug.autoMealSkipped = "invalid_meal_type";
        } else {

          const base = pjInternalUrl("");
          const nutRes = await fetch(`${base}/api/nutrition`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: String(foodText || "").trim(),
              customerId: customerNumericId || customerGid
            })
          });

          const nut = nutRes.ok ? await nutRes.json().catch(() => null) : null;
          const items = Array.isArray(nut?.items) ? nut.items : [];
          const totals = nut?.totals && typeof nut.totals === "object" ? nut.totals : null;
          const needs = Array.isArray(nut?.needs_clarification) ? nut.needs_clarification : [];
          const incomplete = nut?.incomplete === true || needs.length > 0 || !totals;
          const unitBased = pjIsUnitBasedFood(foodText);

          // -------------------------------
          // Nutrition failed
          // -------------------------------
          if (!nut || nut.ok !== true || incomplete) {

            // Unit-based fallback
            if (unitBased) {
              const fallbackMeal = {
                date: dateKey,
                meal_type: mealType,
                items: [String(foodText || "Item")],
                calories: 200,
                protein: 20,
                carbs: 10,
                fat: 5
              };

              await upsertMealLog(customerGid, fallbackMeal, dateKey);

              return res.status(200).json({
                reply:
                  `Logged your ${mealType.toLowerCase()}:\n• ${fallbackMeal.items[0]}\n\n` +
                  `Estimated: ${fallbackMeal.calories} calories — ${fallbackMeal.protein}g protein, ${fallbackMeal.carbs}g carbs, ${fallbackMeal.fat}g fat.`,
                debug,
                free_chat_remaining: remainingAfter
              });
            }

            // User explicitly unsure → estimate
            if (pjUserIsUnsure(userMessage)) {
              const est = pjEstimateMealFallback(foodText, mealType, dateKey);
              if (est) {
                await upsertMealLog(customerGid, est, dateKey);

                return res.status(200).json({
                  reply:
                    `No worries — I’ll estimate this.\n\n` +
                    `Logged your ${mealType.toLowerCase()}:\n` +
                    est.items.map(x => `• ${x}`).join("\n") + `\n\n` +
                    `Estimated: ${est.calories} calories — ${est.protein}g P, ${est.carbs}g C, ${est.fat}g F.\n\n` +
                    `If you ever want it tighter, just tell me “3 slices” or “thin crust”.`,
                  debug: { ...debug, portionFallbackUsed: true },
                  free_chat_remaining: remainingAfter
                });
              }
            }

            // Ask once for clarification
            await setPendingMeal(customerGid, {
              date: dateKey,
              meal_type: mealType,
              raw_text: String(foodText || "").trim()
            });

            const qText = needs.length
              ? needs.map(q => `- ${q.question}`).join("\n")
              : "- Rough estimate is fine: how much / how many? (or say “not sure” and I’ll estimate)";

            return res.status(200).json({
              reply:
                "Quick question so I can be closer (or say “not sure” and I’ll estimate):\n\n" +
                qText,
              debug: {
                ...debug,
                pendingMealResolved: false,
                pendingMealResolvedReason: needs.length ? "needs_clarification" : "nutrition_incomplete"
              },
              free_chat_remaining: remainingAfter
            });
          }

          // -------------------------------
          // Normal successful nutrition path
          // -------------------------------
          if (items.length && totals) {
            const meal = {
              date: dateKey,
              meal_type: mealType,
              items: items.map(it => ({
                name: String(it?.name || it?.matched_to || it?.text || "Food").trim(),
                calories: Math.round(Number(it?.calories) || 0),
                protein: pjRound1(Number(it?.protein) || 0),
                carbs: pjRound1(Number(it?.carbs) || 0),
                fat: pjRound1(Number(it?.fat) || 0)
              })),
              calories: Math.round(Number(totals.calories) || 0),
              protein: pjRound1(Number(totals.protein) || 0),
              carbs: pjRound1(Number(totals.carbs) || 0),
              fat: pjRound1(Number(totals.fat) || 0)
            };

            const hasPortions = pjHasPortionsOrUnits(foodText);
            if (!hasPortions) {
              const cap =
                mealType === "Breakfast" ? 750 :
                mealType === "Lunch" ? 950 :
                mealType === "Dinner" ? 1100 :
                500;

              if (meal.calories > cap) {
                const scale = cap / meal.calories;
                meal.calories = cap;
                meal.protein = pjRound1(meal.protein * scale);
                meal.carbs = pjRound1(meal.carbs * scale);
                meal.fat = pjRound1(meal.fat * scale);
                debug.autoMealLog = { ...(debug.autoMealLog || {}), capped: true, capApplied: cap };
              }
            }

            await upsertMealLog(customerGid, meal, dateKey);

            const itemsList = meal.items
              .map(it => `• ${it.name} — ${it.calories} cal (${it.protein}P / ${it.carbs}C / ${it.fat}F)`)
              .join("\n");

            return res.status(200).json({
              reply:
                `Logged your ${mealType.toLowerCase()}:\n${itemsList}\n\n` +
                `Estimated: ${meal.calories} calories — ${meal.protein}g protein, ${meal.carbs}g carbs, ${meal.fat}g fat.`,
              debug: {
                ...debug,
                autoMealLog: { ok: true, meal_type: mealType, calories: meal.calories, itemsCount: meal.items.length }
              },
              free_chat_remaining: remainingAfter
            });
          }
        }
      }
    } catch (e) {
      debug.autoMealLog = { ok: false, error: String(e?.message || e) };
    }
  }
}

// ============================================================
// DAILY TOTAL CALORIES FROM USER MESSAGE
// ============================================================
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

// ============================================================
// MEAL OVERRIDE / AUTO CORRECTION
// ============================================================
let overrideMeal = detectMealOverride(userMessage);
if (overrideMeal) {
  debug.mealOverrideDetected = overrideMeal;
} else if (customerGid && detectMealCorrection(userMessage)) {
  try {
    const { logs } = await getDailyLogsMetafield(customerGid);
    const lastType = getLastMealTypeFromLogs(logs, dateKey);
    if (lastType) {
      overrideMeal = { meal_type: lastType, __replaceLast: true };
      debug.mealAutoCorrectionDetected = true;
      debug.mealAutoReplaceMealType = lastType;
    }
  } catch (e) {
    debug.mealAutoCorrectionError = String(e?.message || e);
  }
}

// ============================================================
// INTRO ALREADY SENT DETECTOR
// ============================================================
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

// ============================================================
// BUILD MESSAGES FOR OPENAI
// ============================================================
const messages = [{ role: "system", content: SYSTEM_PROMPT }];

messages.push({
  role: "system",
  content:
    `TODAY_DATE: ${dateKey}. ` +
    `Use this exact date in all JSON blocks: DAILY_LOG_JSON, MEAL_LOG_JSON, DAILY_REVIEW_JSON, COACH_REVIEW_JSON. ` +
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
      "SYSTEM_FLAG: INTRO_ALREADY_SENT = true. You have already sent your onboarding intro earlier in this conversation."
  });
}

if (overrideMeal) {
  messages.push({ role: "system", content: `USER_REQUEST_OVERRIDE_MEAL: ${JSON.stringify(overrideMeal)}` });
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

    const role = m.role === "user" ? "user" : "assistant";
    messages.push({ role, content: text });
  }
}

if (appendUserMessage && userMessage) {
  messages.push({ role: "user", content: userMessage });
}

if (weeklyContextText) {
  messages.push({ role: "system", content: weeklyContextText });
}

messages.push({
  role: "system",
  content:
    "CRITICAL: You MUST end your response with exactly one [[COACH_REVIEW_JSON {..} ]] block."
});

debug.messagesCount = messages.length;

// ============================================================
// CALL OPENAI
// ============================================================
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
    return res.status(500).json({ error: "OpenAI API error", debug });
  }

  const data = await openaiRes.json();
  const rawReply = data.choices?.[0]?.message?.content || "Sorry, I’m not sure what to say to that.";

  // (rest of your existing save logic continues unchanged)

  const cleanedReply = pjSanitizeForUser(rawReply);

  return res.status(200).json({
    reply: cleanedReply,
    debug,
    free_chat_remaining: remainingAfter
  });
} catch (e) {
  console.error("Chat handler error", e);
  return res.status(500).json({
    error: "Server error",
    debug: { ...debug, serverError: String(e?.message || e) }
  });
}

module.exports = handler;
