// /api/chat.js
// Chat endpoint using OpenAI REST API.
// Expects: { message, email, customerId, threadId, history, appendUserMessage } in JSON body.
// Returns: { reply, debug }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Shopify Admin API (for reading + writing onboarding/metafields)
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "your-store.myshopify.com"
const SHOPIFY_ADMIN_API_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

/* ============================================================
   SYSTEM PROMPT — PJiFitness AI Coach
   Human-first onboarding + Daily Coach + Plan/Meal/Review JSON
   ============================================================ */

const SYSTEM_PROMPT = `
You are the PJiFitness AI Coach.

Your job (in this order):
1) Build trust fast (human, 1-on-1) and guide the user.
2) Onboard new users ONE TIME and set up their plan.
3) Guide simple DAILY check-ins (weight, calories, steps, notes, meals).
4) Make fat loss feel normal, slow, and sustainable — not a crash diet.
5) Be the user’s all-in-one support: encouragement, clarity, troubleshooting, and simple next steps.

======================================================
PRE-ONBOARDING: HUMAN CONNECTION FIRST (MANDATORY)
======================================================

If onboarding is NOT complete (custom.onboarding_complete is NOT "true"):

Your FIRST priority is to create trust and a real 1-on-1 coach feeling BEFORE onboarding.

RULES:
- Do NOT ask onboarding questions (sex/weight/height/age/goal/pace/activity) immediately.
- Do NOT give deep education or “studies” yet.
- Ask ONE question at a time.
- Keep it warm, short, and human.

You must follow this exact sequence:

STEP 1 — GREETING + NAME (FIRST MESSAGE ONLY)
Send ONLY this:
"Hey — I’m your PJiFitness coach 👋 What’s your name?"

STEP 2 — LEARN ABOUT THE USER (AFTER THEY GIVE A NAME)
Acknowledge the name, then ask ONE open-ended question:
"Nice to meet you, {{user_name}}. What made you want to start working on this right now?"

STEP 3 — LIGHT PHILOSOPHY (AFTER THEY ANSWER STEP 2)
Send ONE short message like this (you can paraphrase):
"Got you. One thing to know up front: we don’t do crash dieting here.
I care more about results that last, not quick drops that come back.
Now I’ll set up your plan — it takes about a minute and we only do this once."

ONBOARDING START TRIGGER (CRITICAL):
You may begin onboarding questions ONLY when:
1) user_name is known AND
2) the user answered the open-ended question in STEP 2 AND
3) custom.onboarding_complete is NOT "true".

If the user tries to skip ahead (“just give me calories”):
- Say: "I can — I just want it accurate. I’ll grab a few quick details first (takes a minute)."
- Then begin onboarding anyway.

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

Support behavior:
- If they’re confused: simplify and give ONE next step.
- If they’re frustrated: validate briefly + give a practical move.
- If they ask how the app works: explain simply (Chat / Today / Progress).
- If they’re over calories: no shame — give 1–3 easy swaps.

======================================================
B. MODES & FLAGS
======================================================

You operate in TWO modes:

1) ONBOARDING MODE
   - When custom.onboarding_complete is NOT "true".
   - Your job is to collect: name, sex assigned at birth (male/female), current weight, height, age, goal weight,
     desired pace, and activity level.
   - This is a ONE-TIME setup.

2) NORMAL COACHING MODE
   - When custom.onboarding_complete is "true".
   - Your job is daily check-ins, troubleshooting, encouragement, and adjustments.
   - DO NOT re-run onboarding unless the user clearly asks to redo their plan.

You may see system flags:
- \`custom.onboarding_complete: true/false\`
- \`SYSTEM_FLAG: INTRO_ALREADY_SENT = true\`
- \`USER_REQUEST_OVERRIDE_MEAL: {...}\`

Respect these flags:
- If \`custom.onboarding_complete: true\` → do NOT do onboarding.
- If \`SYSTEM_FLAG: INTRO_ALREADY_SENT = true\` → never send your intro again in this conversation.

MEAL CORRECTION MODE (CRITICAL):
// If USER_REQUEST_OVERRIDE_MEAL is present OR the user is correcting calories/macros for a recently logged meal
- You MUST output exactly ONE [[MEAL_LOG_JSON {...}]] block reflecting the corrected meal.
- This block represents a REPLACEMENT, not a new meal.
- Do NOT skip MEAL_LOG_JSON on corrections, even if the user message is short.
- The backend will handle replacing the prior meal entry.


======================================================
C. ONBOARDING FLOW (NO TRIGGER PHRASES)
======================================================

You NEVER wait for “start onboarding”.
If onboarding is not complete, you automatically run onboarding the first time you interact with the user.

CRITICAL FLOW RULE:
- Do NOT begin onboarding questions until the PRE-ONBOARDING sequence is satisfied:
  (name collected + “why now” answered + light philosophy delivered).
- If onboarding is not complete and you have NOT yet asked the name question, you MUST start at STEP 1 (name).

------------------------------------------------------
STEP 0 — INTRO + NAME (HUMAN VERSION)
------------------------------------------------------

If onboarding is NOT complete and you have not collected user_name:
Send ONLY this (and nothing else):
"Hey — I’m your PJiFitness coach 👋 What’s your name?"

HOW TO INTERPRET USER REPLIES DURING STEP 0:
1) If the user replies with one or two words that look like a name:
   - Treat it as user_name.
   - Then run STEP 1 (why now).

2) If the user’s first message includes a name + goal:
   - Acknowledge briefly and still run STEP 1:
     "Nice to meet you, Mike. What made you want to start working on this right now?"

------------------------------------------------------
STEP 1 — WHY NOW (CONNECTION QUESTION)
------------------------------------------------------

If user_name exists but you have not collected their “why now” answer:
Ask ONLY:
"Nice to meet you, {{user_name}}. What made you want to start working on this right now?"

- Accept any answer; keep it supportive.
- After they answer, you MUST send STEP 2 (light philosophy) before asking onboarding questions.

------------------------------------------------------
STEP 2 — LIGHT PHILOSOPHY (NO STUDIES YET)
------------------------------------------------------

After they answer WHY NOW:
Send a short message like:
"Got you. One thing to know up front: we don’t do crash dieting here.
I care more about results that last, not quick drops that come back.
Now I’ll set up your plan — it takes about a minute and we only do this once."

Then proceed to SEX.

------------------------------------------------------
STEP A0 — SEX (REQUIRED)
------------------------------------------------------

Ask (if you don’t have it yet):
"Quick one for accuracy — what sex were you assigned at birth? (male or female)"

Rules:
- Accept: "male", "female" (case-insensitive).
- If unclear, ask again simply:
  "For calorie accuracy I just need: male or female."

After sex is known, move to CURRENT WEIGHT.

------------------------------------------------------
STEP A — CURRENT WEIGHT (lbs)
------------------------------------------------------

Ask (if you don’t have it yet):
"Perfect. What’s your CURRENT weight in pounds (just the number)?"

- Accept a single number as weight when this is the active step.
- If the number is clearly unrealistic (<80 or >600), gently confirm.

------------------------------------------------------
STEP B — HEIGHT
------------------------------------------------------

After current weight is known:
Ask:
"Got it — we’ll use {{weight}} lbs as your current weight. What’s your height? You can give it as 5'9\\" or in cm."

- Accept formats like 5'9", 5’9, 69 inches, or centimeters.
- Do NOT interpret height as weight.

------------------------------------------------------
STEP C — AGE
------------------------------------------------------

After height is known:
Ask:
"Got it. Next up, how old are you?"

IMPORTANT NUMBER RULES DURING ONBOARDING:
- If CURRENT WEIGHT is already known and the current step is AGE:
  → Any numeric reply MUST be interpreted as AGE (even if it looks like a weight).

- Never treat height as weight.
- Numbers only count as weight when:
  - They are between 80–600 lbs AND
  - The CURRENT step is the weight question.

------------------------------------------------------
STEP D — GOAL WEIGHT
------------------------------------------------------

After age is known:
Ask:
"What’s your GOAL weight in pounds? If you’re not sure, just give your best guess."

- If goal > current weight and they’ve said they want to lose fat:
  - Briefly confirm that this is intended.

------------------------------------------------------
STEP E — DESIRED PACE / TIMEFRAME
------------------------------------------------------

Ask:
"How fast do you want to lose? More steady and sustainable, a bit more aggressive, or do you have a target date in mind?"

Map:
- “steady”, “slow and steady”, “sustainable” → ~0.5–1.0 lb/week
- “aggressive”, “faster” → ~1.0–1.5 lb/week (maybe up to 2.0 if appropriate)
- If they give a date, interpret it into a rough lb/week pace if possible.

Store as weekly_loss_target_lbs.

------------------------------------------------------
STEP F — ACTIVITY LEVEL
------------------------------------------------------

Ask:
"Last one: how active are you in a typical week? Mostly sitting, some walking, or on your feet / training most days?"

Map to:
- "low"
- "moderate"
- "high"

------------------------------------------------------
LOOP GUARD — NEVER RESTART ONBOARDING MID-CONVERSATION
------------------------------------------------------

Before you decide what to reply, quickly scan the prior conversation messages you can see.

If you find ANY of the following earlier in this same conversation:
- You already asked WHY NOW
- You already asked sex, CURRENT weight, height, age, goal weight, pace, or activity
- You already summarized their plan
- You already output a [[COACH_PLAN_JSON ...]] block

THEN:
- Treat onboarding as already in progress or complete.
- Do NOT jump back to earlier steps.
- Continue from the NEXT missing step.

If you have already output a [[COACH_PLAN_JSON ...]] block at any point in this conversation, onboarding is DONE for this conversation.

------------------------------------------------------
COMPLETE THE PLAN (SHORT + ONE QUESTION ONLY)
------------------------------------------------------

When all onboarding data is collected:

1) Summarize their plan in a SHORT, clean format (max ~8–10 lines total):
   - Daily calories target + green zone
   - Protein target + green zone
   - Simple fats + carbs
   - Step goal
   - Weekly pace

2) Then ask ONLY this question and STOP:
"✅ Onboarding complete. Do you have any questions about your plan before we start logging meals?"

3) Output ONE hidden block exactly like this:

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
D. PLAN CALCULATION RULES
======================================================

MAINTENANCE CALORIES (rough):
- Low activity: 11–12 × bodyweight (lb)
- Moderate: 12–13 × bodyweight (lb)
- High: 13–14 × bodyweight (lb)

FAT-LOSS CALORIE TARGET:
- maintenance − 300 to 500 kcal
- Round to nearest 50 kcal

CALORIE GREEN ZONE:
- target ± 150

PROTEIN:
- 0.8–1.0 g per pound of CURRENT bodyweight
- Give a green zone of ±15–20g

FATS:
- Roughly 0.3–0.4 g per pound bodyweight

CARBS:
- Fill the remaining calories after protein + fats

STEPS:
- Very low: 6000–7000 minimum
- 4000–8000: 8000–10000
- 8000+: 10000+

======================================================
E. SCALE & MINDSET — ONE-TIME EDUCATION
======================================================

After the user confirms they understand the plan (no questions), you may send ONE educational message:
- Weigh daily: morning, after bathroom, before food/drink, same scale, flat surface
- Expect daily weight swings
- Weekly averages matter
- Spikes are often water/salt/carbs/soreness/digestion, not sudden fat gain

======================================================
CRITICAL WEIGHT RULE (DO NOT BREAK)
======================================================

- The user's CURRENT weight (today’s scale weight) is ONLY ever saved to: DAILY_LOG_JSON.weight
- The user's GOAL weight MUST NEVER be saved to DAILY_LOG_JSON.weight
- If unsure of today's weight, set DAILY_LOG_JSON.weight = null (do NOT guess)

======================================================
F. DAILY LOGGING (DAILY_LOG_JSON)
======================================================

Whenever the USER gives you ANY daily check-in data, you MUST append a hidden DAILY_LOG_JSON block
AFTER your visible reply.

Daily check-in data includes: today's weight, calories, steps, macros, or a daily summary.

FORMAT:

[[DAILY_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "weight": 172.0,
  "calories": 2050,
  "protein_g": 150,
  "carbs_g": 200,
  "fat_g": 60,
  "steps": 8000,
  "notes": "Short 1–2 sentence note about the day (or empty string)."
}
]]

RULES:
- date = TODAY in the user’s local time, format "YYYY-MM-DD"
- If unknown, use null (NOT 0)
- If user only gives weight: other fields null, notes mention weight
- If user gives multiple items: fill what you can
- IMPORTANT ORDERING RULE:
  - DAILY_LOG_JSON goes after the visible reply,
  - but the FINAL block of every message must be COACH_REVIEW_JSON.

======================================================
F. MEAL LOGGING (MEAL_LOG_JSON)
======================================================

When the user describes food and clearly wants it logged:

1) VISIBLE REPLY:
- Confirm the meal and type
- Give a short estimate with calories/macros
- If it’s high-calorie, offer 1–3 simple swaps (only if helpful)

2) HIDDEN BLOCK:

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
- date = TODAY (YYYY-MM-DD)
- meal_type must be: "Breakfast" | "Lunch" | "Dinner" | "Snacks"
- Always include items + calories + protein + carbs + fat
- If USER_REQUEST_OVERRIDE_MEAL exists, still output MEAL_LOG_JSON; backend handles replacement.
- IMPORTANT ORDERING RULE:
  - MEAL_LOG_JSON goes after the visible reply (and after DAILY_LOG_JSON if both exist),
  - but the FINAL block of every message must be COACH_REVIEW_JSON.

======================================================
F2. REVIEW MY MEALS (MEAL REVIEW + SWAPS)
======================================================

TRIGGERS:
If user says: "Review my meals", "Review meals", "Meal review", or taps Review Meals.

OUTPUT STRUCTURE:
1) Meals logged today (group by Breakfast/Lunch/Dinner/Snacks)
2) Totals vs targets:
   - Calories: total vs target
   - Protein/Carbs/Fat: totals vs targets (if available)
3) Coaching feedback:
   - Wins (1–3 bullets)
   - Swaps ONLY if needed (rules below)
4) ONE best next move (simple)

CALORIE RANGE RULE:
- Treat targets as a RANGE
- Within ±200 is “on plan” (do NOT call it “over”)

WHEN TO SUGGEST SWAPS (ONLY IF TRUE):
A) Calories > ~200 over target
B) Protein clearly low vs target
C) Meals are very calorie-dense / low volume AND user mentions hunger
D) User explicitly asks for swaps

SWAP STYLE:
- 1–3 swaps max
- Practical and tasty
- Higher protein / higher volume / lower calorie density
- Explain briefly why

======================================================
G. DAILY REVIEW (DAILY_REVIEW_JSON)
======================================================

Sometimes you can send a quick daily focus.

[[DAILY_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "Short 1–3 sentence coach focus for today or tomorrow.",
  "risk_color": "green",
  "needs_human_review": false
}
]]

IMPORTANT ORDERING RULE:
- DAILY_REVIEW_JSON can appear after visible reply,
- but the FINAL block of every message must be COACH_REVIEW_JSON.

======================================================
I. COACH DAILY REVIEW (COACH_REVIEW_JSON) — ALWAYS UPDATE (MUST BE FINAL)
======================================================

After EVERY assistant reply, append ONE COACH_REVIEW_JSON block at the VERY END (last thing in the message).

[[COACH_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "4–6 sentences describing how the day is going so far. Be practical and specific. Reference behaviors, patterns, or trends when possible.",
  "wins": ["Concrete positive actions, habits, or decisions (1–4 items)"],
  "opportunities": ["Specific adjustments or improvements that could meaningfully help progress (1–3 items)"],
  "struggles": ["Adherence issues, mindset challenges, or friction points if present"],
  "next_focus": "ONE clear, actionable behavior to prioritize in the next 24 hours.",
  "food_pattern": "Short paragraph describing food timing, portions, balance, or consistency patterns noticed today.",
  "mindset_pattern": "Short paragraph describing motivation, confidence, stress, or thought patterns if evident."
}
]]

Rules:
- date = TODAY
- Do NOT invent data
- Keep it coach-like, not generic
- This block MUST be the FINAL block in the response (after any DAILY_LOG_JSON / MEAL_LOG_JSON / DAILY_REVIEW_JSON).

======================================================
H. CRITICAL LOGGING BEHAVIOR — DAILY_LOG_JSON
======================================================

1) If user is just chatting (questions about diet/workouts/mindset), answer normally.
2) If user reports ANY daily data, you MUST also emit DAILY_LOG_JSON.

If you skip DAILY_LOG_JSON when daily data is given, you are BREAKING THE APP. Do not skip it.

FINAL OUTPUT ORDER (DO NOT VIOLATE):
Visible reply
→ optional [[DAILY_LOG_JSON]]
→ optional [[MEAL_LOG_JSON]] (can be multiple)
→ optional [[DAILY_REVIEW_JSON]]
→ ALWAYS LAST: [[COACH_REVIEW_JSON]]
`;

/* ============================
   POST-PLAN (after refresh) MESSAGES
   ============================ */
const PJ_POST_PLAN_EDU =
  "Quick coaching note so you don’t overthink this:\n\n" +
  "✅ **This is flexible dieting (a numbers game).** You can still eat foods you love — we just fit them into your calorie + protein targets.\n" +
  "✅ **Volume eating = stay full on fewer calories.** Think: lean protein + big servings of veggies/fruit + potatoes/rice in smart portions.\n" +
  "✅ **Food swaps (not food bans):** same flavor, fewer calories. Example: grilled vs fried, leaner cuts, Greek-yogurt sauces, air-fryer versions.\n\n" +
  "Why people fail: most crash diets are too aggressive → hunger ramps up, energy drops, adherence breaks, then the weight comes back. The goal here is **steady + repeatable**, not perfect.\n\n" +
  "Tell me 2–3 foods you love (pizza, burgers, sweets, etc.) and I’ll show you how to keep them in — the smart way.";

const PJ_POST_PLAN_MEAL_PROMPT =
  "✅ Now let’s add your **first meal**.\n\n" +
  "1) Tap the **Today** tab (first tab at the bottom)\n" +
  "2) **Refresh** once if your dashboard didn’t load\n" +
  "3) Tap **Add** next to the meal you want to log\n" +
  "4) Tell me what you ate — I’ll give you calories + macros and log it.";

const PJ_POST_PLAN_REFRESH =
  "🔄 One quick step:\n" +
  "Please refresh the page once so your plan loads correctly.\n\n" +
  "After the refresh, you’ll see your daily calories, macros, and tabs.\n" +
  "I’ll be right here when you’re back.";

// ===============================
// SAFETY: sanitize model output so internal blocks never leak into chat
// Handles [[...]] and also broken single-bracket variants like [COACH_REVIEW_JSON ...]
// ===============================
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

// ===============================
// POST-PLAN STAGE (one-time post-refresh education + first meal prompt)
// ===============================
async function getPostPlanStage(customerGid) {
  if (!customerGid) return null;
  const q = `
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"custom", key:"post_plan_stage") { value }
      }
    }
  `;
  const data = await shopifyGraphQL(q, { id: customerGid });
  return data?.customer?.metafield?.value || null;
}

async function setPostPlanStage(customerGid, value) {
  if (!customerGid) return;
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
      key: "post_plan_stage",
      type: "single_line_text_field",
      value: String(value)
    }
  });
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

function computePlanFromOverlayOnboarding(ob, dateKey) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  const name = String(ob?.name || "").trim();
  const sex = String(ob?.gender || ob?.sex || "male").toLowerCase() === "female" ? "female" : "male";

  const startW = n(ob?.start_weight) ?? n(ob?.current_weight) ?? n(ob?.weight) ?? null;
  const goalW  = n(ob?.goal_weight) ?? n(ob?.goal) ?? null;

  const activity = String(ob?.activity || "moderate").toLowerCase();
  const pace = String(ob?.pace || "moderate").toLowerCase();

  const bw = startW ?? 180;

  // Maintenance multipliers per your prompt rules
  const mult =
    activity === "low" ? 11.5 :
    activity === "high" ? 13.5 :
    12.5; // moderate

  const maintenance = Math.round(bw * mult);

  // Pace -> deficit (simple + stable)
  const weeklyLoss =
    pace === "conservative" ? 0.75 :
    pace === "aggressive" ? 1.5 :
    1.0;

  const deficit =
    weeklyLoss <= 0.8 ? 300 :
    weeklyLoss >= 1.4 ? 500 :
    400;

  let calories = Math.round((maintenance - deficit) / 50) * 50;
  calories = clamp(calories, 1400, 2600);

  // Protein 0.8–1.0 g/lb (use 0.9)
  let protein = Math.round(clamp(bw * 0.9, 120, 220));

  // Fats 0.3–0.4 g/lb (use 0.35)
  let fat = Math.round(clamp(bw * 0.35, 45, 90));

  // Carbs fill remainder
  let carbs = Math.round((calories - (protein * 4) - (fat * 9)) / 4);
  if (!Number.isFinite(carbs) || carbs < 50) carbs = 50;

  return {
    user_name: name || null,
    sex,
    current_weight_lbs: startW || null,
    goal_weight_lbs: goalW || null,
    age: n(ob?.age) || null,
    activity_level: (activity === "low" || activity === "high") ? activity : "moderate",
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
  // ✅ END LOCK

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
function pjGuessMealTypeFromUserText(text){
  const t = String(text || "").toLowerCase();

  if (/\b(breakfast|bfast)\b/.test(t)) return "breakfast";
  if (/\blunch\b/.test(t)) return "lunch";
  if (/\b(dinner|supper)\b/.test(t)) return "dinner";
  if (/\b(snack|snacks|dessert)\b/.test(t)) return "snack";

  // ✅ CRITICAL: do NOT default to snack here
  return null;
}


function pjLooksLikeFoodText(text){
  const t = (text || "").toLowerCase();
  return (
    /\b(i\s*(ate|had)|ate|had|for\s+(breakfast|bfast|lunch|dinner|snack)|log (this|my) (meal|food))\b/.test(t) ||
    /\b(oz|ounce|ounces|tbsp|tsp|cup|cups|g|gram|grams|slice|slices|wrap|bar|shake)\b/.test(t) ||
    /\b(cal(orie|ories)|cals|protein|carb|carbs|fat|macros)\b/.test(t)
  );
}
function pjSplitMealsFromUserMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  // Split by newlines OR common separators like "Lunch:" inline, etc.
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const sections = [];
  let current = { label: null, text: "" };

  // Detect headings like:
  // "Breakfast: ...", "Lunch - ...", "Dinner ...", "Snack: ..."
  const headingRe = /^(breakfast|bfast|lunch|dinner|supper|snack|snacks|snaks|dessert)\b\s*[:\-–]?\s*(.*)$/i;

  function pushCurrent() {
    const txt = (current.text || "").trim();
    if (!txt) return;

    // ✅ If no explicit heading, leave meal_type null so caller can decide (or keep as one block)
    sections.push({
      meal_type: current.label ? normalizeMealType(current.label) : null,
      text: txt
    });
  }

  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      pushCurrent();
      current = { label: m[1], text: (m[2] || "").trim() };
    } else {
      current.text += (current.text ? " " : "") + line;
    }
  }

  pushCurrent();

  // ✅ If they never used headings, return ONE chunk only (no forced snack)
  if (sections.length === 1 && sections[0].meal_type === null) {
    return [{ meal_type: null, text: raw }];
  }

  // ✅ If multiple chunks exist, keep them (meal_type might still be null for some)
  return sections;
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

  const cleanDesc = (descLower) => {
    if (!descLower) return "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) desc = original.substring(startIndex, startIndex + descLower.length);

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    return desc;
  };

  let m = text.match(
    /for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*,?\s*i\s+(?:had|ate)\s+(.*)$/i
  );
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const desc = cleanDesc(m[2] || "");
    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(
    /log\s+this\s+as\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*[:\-]?\s*(.*)$/i
  );
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const desc = cleanDesc(m[2] || "");
    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(
    /^(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*[:\-]\s*(.+)$/i
  );
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const desc = cleanDesc(m[2] || "");
    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(
    /i\s+(?:had|ate)\s+(.*)\s+for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\b/i
  );
  if (m) {
    const desc = cleanDesc(m[1] || "");
    const mealType = normalizeMealType(m[2]);
    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(
    /^(.*)\s+for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\b/i
  );
  if (m) {
    const mealType = normalizeMealType(m[2]);
    let desc = (m[1] || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;
    return { meal_type: mealType, items: [desc] };
  }

  m = text.match(/i\s+(?:had|ate)\s+(.*)$/i);
  if (m) {
    const desc = cleanDesc(m[1] || "");
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

  const mealType = normalizeMealType(meal.meal_type);
if (!mealType) return; // ✅ if no known type, don't save it into the wrong bucket


  let items = meal.items;
  if (!Array.isArray(items)) {
    if (typeof items === "string" && items.trim()) items = [items.trim()];
    else items = [];
  }

  const replaceMealType = options.replaceMealType || null;
const replaceLast = options.replaceLast === true;


  if (idx >= 0) {
    const existing = logs[idx] || {};
    const existingMeals = Array.isArray(existing.meals) ? existing.meals : [];

    let baseMeals = existingMeals;

if (replaceLast && existingMeals.length) {
  // ✅ correction mode: replace the LAST logged meal (no duplicates)
  baseMeals = existingMeals.slice(0, -1);
} else if (replaceMealType) {
  // ✅ replace all meals of that type (manual "replace my lunch" etc)
  const rt = normalizeMealType(replaceMealType) || replaceMealType;
  baseMeals = existingMeals.filter(m => normalizeMealType(m?.meal_type) !== rt);
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
  const t = String(raw || "").toLowerCase().trim();

  if (t === "bfast" || t === "breakfast") return "Breakfast";
  if (t === "lunch") return "Lunch";
  if (t === "dinner" || t === "supper") return "Dinner";

  // Always store snacks as "Snacks"
  if (t === "snack" || t === "snacks" || t === "snaks" || t === "dessert") return "Snacks";

  return null; // ✅ key: don't silently default here
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

function detectMealCorrection(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return false;
  const t = userMsg.toLowerCase();

  // Common correction language + calorie numbers
  return (
    /\b(wrong|incorrect|actually|should be|not right|label|nutrition label|it’s|its)\b/.test(t) ||
    /\b(\d{1,4})\s*(cal|cals|calories|kcal)\b/.test(t)
  );
}

function getLastMealTypeFromLogs(logs, dateKey) {
  if (!Array.isArray(logs) || !dateKey) return null;
  const day = logs.find(x => x && x.date === dateKey);
  const meals = Array.isArray(day?.meals) ? day.meals : [];
  if (!meals.length) return null;
  const last = meals[meals.length - 1];
  return normalizeMealType(last?.meal_type || null);
}

export default async function handler(req, res) {
  // ===== CORS (SHOPIFY -> VERCEL) =====
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

  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders ? String(reqHeaders) : "Content-Type, Authorization, X-Requested-With, Accept"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
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

  // ✅ PJ DATE SOURCE OF TRUTH (CLIENT LOCAL DATE)
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
  let postPlanStage = null;

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

      if (typeof val === "string") onboardingComplete = (val === "true");
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
    model: "gpt-4.1-mini",
  };
  // ============================================================
  // ✅ OVERLAY ONBOARDING SHORT-CIRCUIT
  // If <ONBOARDING_JSON> is present, generate + SAVE plan now.
  // This bypasses OpenAI onboarding "ask name" behavior.
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
      // Save plan (uses your existing saver)
      await saveCoachPlanForCustomer(customerGid, plan);

      // Mark post-plan stage (your existing flow)
      try {
        await setPostPlanStage(customerGid, "plan_questions");
        postPlanStage = "plan_questions";
      } catch (e) {
        console.warn("Failed to set post_plan_stage:", e?.message || e);
      }

      // Write initial weight as today's weight log (your existing rule)
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

    // (Optional) return remaining without decrement so plan creation never gets blocked
    let remainingNow = null;
    try {
      let r = await getFreeChatRemaining(customerGid);
      if (r === null) {
        r = 30;
        await setFreeChatRemaining(customerGid, r);
      }
      remainingNow = r; // don't decrement for plan generation
    } catch(e) {}

    return res.status(200).json({
      reply,
      plan_json: plan,          // ✅ overlay reads this
      coach_plan: plan,         // ✅ backup
      free_chat_remaining: remainingNow,
      debug: { ...debug, onboardingOverlay: true, planSavedToShopify: true, plan_json: plan }
    });
  }

  // FREE PREVIEW MESSAGE GATE
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

   let overrideMeal = detectMealOverride(userMessage);
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
   if (overrideMeal) {
  debug.mealOverrideDetected = overrideMeal;
} else if (customerGid && detectMealCorrection(userMessage)) {
  // ✅ Auto-replace last logged meal for today when user is correcting
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

// ===============================
// AUTO MEAL LOG FROM NATURAL CHAT (MULTI-MEAL SAFE)
// Logs even without MEAL_LOG_JSON
// ===============================
if (customerGid && userMessage && pjLooksLikeFoodText(userMessage)) {
  try {
    const proto =
      (req.headers["x-forwarded-proto"] && String(req.headers["x-forwarded-proto"]).split(",")[0]) ||
      "https";

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const base = host ? `${proto}://${host}` : "https://www.pjifitness.com";

    // ✅ Split message into multiple meal chunks when user types "breakfast ... lunch ... dinner ..."
    const chunks = pjSplitMealsFromUserMessage(userMessage);
    const partsToLog = (chunks && chunks.length)
      ? chunks
      : [{ text: userMessage, meal_type: pjGuessMealTypeFromUserText(userMessage) }];

    debug.autoMealLog = { ok: false, reason: "not_run" };

    // If they are overriding a meal type, we should only log ONE chunk (the full message) and replace that meal type
    if (overrideMeal && overrideMeal.meal_type) {
      partsToLog.length = 0;
      partsToLog.push({ text: userMessage, meal_type: overrideMeal.meal_type });
    } else {
      // ✅ IMPORTANT: If the user didn't specify a meal type anywhere, skip auto-log
      // so we don't default everything to "snack".
      const anyKnownMealType = partsToLog.some(p => !!p?.meal_type);
      if (!anyKnownMealType) {
        debug.autoMealLog = { ok: false, reason: "unknown_meal_type_skip_auto_log" };
        // Do not return; we just skip auto meal logging and let OpenAI handle the message.
      }
    }

    // If we decided to skip, bail out of this block cleanly
    if (debug.autoMealLog?.reason === "unknown_meal_type_skip_auto_log") {
      // nothing
    } else {
      const results = [];

      for (const part of partsToLog) {
        const partText = (part?.text || "").trim();
        if (!partText) continue;

        // ✅ Enforce: must have a meal type unless we're overriding
        // Force meal type from the full user message first
let mt =
  part?.meal_type ||
  pjGuessMealTypeFromUserText(partText) ||
  pjGuessMealTypeFromUserText(userMessage);

        if (!mt && !(overrideMeal && overrideMeal.meal_type)) {
          results.push({ ok: false, reason: "unknown_meal_type_part_skipped" });
          continue;
        }

        const nutRes = await fetch(`${base}/api/nutrition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: partText })
        });

        if (!nutRes.ok) {
          results.push({ ok: false, reason: "nutrition_http_not_ok" });
          continue;
        }

        const nut = await nutRes.json().catch(() => null);
        const items = Array.isArray(nut?.items) ? nut.items : [];
        const totals = nut?.totals && typeof nut.totals === "object" ? nut.totals : null;

        // Only log if nutrition actually found foods
        if (!items.length || !totals) {
          results.push({ ok: false, reason: "nutrition_no_items" });
          continue;
        }

        const mealType = normalizeMealType(mt);

        const meal = {
          date: dateKey,
          meal_type: mealType,
          items: items.map(it => {
            const name = it?.name || it?.matched_to || "Food";
            const qty = it?.qty ? String(it.qty) : "";
            const unit = it?.unit ? String(it.unit) : "";
            return (qty || unit) ? `${qty} ${unit} ${name}`.trim() : String(name);
          }),
          calories: Number(totals.calories) || 0,
          protein: Number(totals.protein) || 0,
          carbs: Number(totals.carbs) || 0,
          fat: Number(totals.fat) || 0
        };

        await upsertMealLog(
          customerGid,
          meal,
          dateKey,
          overrideMeal ? { replaceMealType: overrideMeal.meal_type } : {}
        );

        results.push({
          ok: true,
          meal_type: mealType,
          calories: meal.calories,
          itemsCount: meal.items.length
        });
      }

      debug.autoMealLog = {
        ok: results.some(r => r.ok),
        results
      };
    }

  } catch (e) {
    debug.autoMealLog = { ok: false, error: String(e?.message || e) };
  }
}

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

          // ✅ Post-plan stage marker: user should ask questions first
try {
  await setPostPlanStage(customerGid, "plan_questions");
  postPlanStage = "plan_questions";
  debug.postPlanStageSet = "plan_questions";
  debug.planJustSaved = true;
} catch (e) {
  console.warn("Failed to set post_plan_stage:", e?.message || e);
}


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
  // ✅ FIRST FIX: if we're replacing a meal, force the meal_type to match
  if (overrideMeal && overrideMeal.meal_type) {
    meal.meal_type = overrideMeal.meal_type;
  }

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
      } else if (!debug.autoMealLog?.ok && detectSimpleMealFromUser(userMessage)) {
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
            overrideMeal ? { replaceMealType: overrideMeal.meal_type } : {}
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

    // ✅ FINAL USER REPLY (sanitized)
    let cleanedReply = pjSanitizeForUser(rawReply);

   // ✅ Post-plan flow (only after user says "no questions / ok")
try {
  if (customerGid && onboardingComplete === true) {
    const stage = postPlanStage || await getPostPlanStage(customerGid);

    const userSaidNoQuestions =
  typeof userMessage === "string" &&
  /(?:^|\b)(no questions?|nope|nah|all good|i(?:'|’)m good|im good|sounds good|got it|makes sense|ok(?:ay)?)(?:\b|$)/i.test(
    userMessage.trim()
  );

    if (stage === "plan_questions") {
      // Only move to tour/meal AFTER user confirms no questions
      if (userSaidNoQuestions) {
        cleanedReply =
          `${cleanedReply}\n\n` +
          `${PJ_POST_PLAN_REFRESH}\n\n` +
          `${PJ_POST_PLAN_EDU}\n\n` +
          `${PJ_POST_PLAN_MEAL_PROMPT}`;

        await setPostPlanStage(customerGid, "done");
        debug.postPlanStageAdvanced = "done";
      } else {
        // Keep them in Q&A mode; don't inject tour/meal yet
        debug.postPlanStageAdvanced = "plan_questions_still";
      }
    }
  }
} catch (e) {
  console.log("Post-plan stage injection error:", e);
}


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
