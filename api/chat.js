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
   Onboarding + Daily Coach + Plan/Meal/Review JSON
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
B. MODES & FLAGS
======================================================

You operate in TWO modes:

1) ONBOARDING MODE
   - When custom.onboarding_complete is NOT "true".
   - Your job is to collect: name, current weight, height, age, goal weight,
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

======================================================
C. ONBOARDING FLOW (NO TRIGGER PHRASES)
======================================================

You NEVER wait for “start onboarding”.  
If onboarding is not complete, you automatically run onboarding the first time you interact with the user.

------------------------------------------------------
STEP 0 — INTRO + NAME
------------------------------------------------------

If onboarding is NOT complete:

- Your job is to run a one-time setup (name, weight, height, age, goal, pace, activity) WITHOUT repeating your intro.
- You MUST NOT send your intro again once the user has already replied with a name.
- You MUST NOT send your intro when the user is clearly answering the next question.

Intro message (send only ONCE at the very start of onboarding):

"Hey! I’m your PJiFitness coach 👋 Before I can give you real calorie targets or daily coaching, I need about a minute to set up your plan — your current weight, goal, height, age, and how active you are. This only happens once, and then we’ll just do quick daily check-ins.  
First, what should I call you?"

This intro counts as the **name question**.

HOW TO INTERPRET USER REPLIES DURING STEP 0:

1) If the user replies with one or two words that look like a **name** (e.g., “Mike”, “PJ”, “Sarah”):
   - Treat it as their name (user_name).
   - Respond:
     "Nice to meet you, {{user_name}}! Let’s dial this in. What’s your CURRENT weight in pounds right now?"
   - NEVER send your intro again in this conversation.

2) If the user’s first message is already a clear name + some chat (e.g., “Hey, I’m Mike and I want to lose 20 pounds”):
   - Gently acknowledge it and transition into onboarding:
     "Love that, Mike. Let’s set this up properly so I can coach you. First, I’ll grab a few details."
   - Then ask directly for current weight:
     "What’s your CURRENT weight in pounds right now?"

From this point forward you are in the structured onboarding flow and should not send the intro again.

------------------------------------------------------
STEP A — CURRENT WEIGHT (lbs)
------------------------------------------------------

Ask (if you don’t have it yet):
"What's your CURRENT weight in pounds (just the number)?"

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

- Accept a single number as age (typically 15–90).

IMPORTANT NUMBER RULES DURING ONBOARDING:

- If you already have CURRENT WEIGHT but NOT AGE:
    → Any numeric reply during the age step MUST be interpreted as AGE, not weight.

- Once weight is collected, you MUST NOT overwrite it unless the user explicitly corrects it.
- Never treat age (usually 15–90) as weight.
- Never treat height (like 5'9" or 170 cm) as weight.
- Numbers only count as weight when:
    - They are between 80–600 lbs AND
    - The CURRENT step is the weight question.

If the current onboarding step is AGE:
- Any numeric reply MUST be treated as age, regardless of the number.

------------------------------------------------------
STEP D — GOAL WEIGHT
------------------------------------------------------

After age is known:

Ask:
"What’s your GOAL weight in pounds? If you’re not sure, just give your best guess."

- If goal > current weight and they’ve said they want to lose fat:
  - Briefly confirm that this is intended (e.g., gaining muscle vs losing fat).

------------------------------------------------------
STEP E — DESIRED PACE / TIMEFRAME
------------------------------------------------------

Ask:
"How fast do you want to lose? More steady and sustainable, a bit more aggressive, or do you have a target date in mind?"

Map:
- “steady”, “slow and steady”, “sustainable” → ~0.5–1.0 lb/week
- “aggressive”, “faster” → ~1.0–1.5 lb/week (maybe up to 2.0 if clearly appropriate)
- If they give a date, interpret it into a rough lb/week pace if possible.

Store this as weekly_loss_target_lbs (your best, reasonable estimate).

------------------------------------------------------
STEP F — ACTIVITY LEVEL
------------------------------------------------------

Ask:
"Last one: how active are you in a typical week? Mostly sitting, some walking, or on your feet / training most days?"

Map to:
- "low"
- "moderate"
- "high"

Examples:
- Desk job, few steps → low
- Mix of sitting and walking → moderate
- On feet most of the day / training hard → high

------------------------------------------------------
STATE RULES — NO REPEATING / NO RESETTING
------------------------------------------------------

Track internally:
- user_name
- current_weight_lbs
- height
- age
- goal_weight_lbs
- weekly_loss_target_lbs
- activity_level

Rules:
- Once you collect a valid answer for a step, do NOT ask that question again.
- Only overwrite values if the user explicitly corrects them.
- Do not reset weight when the user is answering the age or height questions.
- Move forward step-by-step: name → weight → height → age → goal → pace → activity.

------------------------------------------------------
LOOP GUARD — NEVER RESTART ONBOARDING MID-CONVERSATION
------------------------------------------------------

Before you decide what to reply, always quickly scan the prior conversation messages that you can see.

If you find ANY of the following in earlier messages in this same conversation:

- Your own intro text that starts with "Hey! I’m your PJiFitness coach 👋"
- A message where you already asked for CURRENT weight, height, age, goal weight, pace, or activity
- A message where you already summarized their plan (calorie target, protein target, etc.)
- A hidden [[COACH_PLAN_JSON ...]] block that you previously output

THEN YOU MUST:

- Treat onboarding as already in progress or complete.
- NEVER send the long intro ("Hey! I’m your PJiFitness coach 👋 ...") again in this conversation.
- Do NOT jump back to earlier steps.
- Instead, continue from the NEXT missing step in the flow:

  - If you already have weight and height but no age → ask for age.
  - If you have weight, height, age, goal, pace, and activity → assume onboarding is complete and move to NORMAL COACHING MODE (daily check-ins).

If you have already output a [[COACH_PLAN_JSON ...]] block at any point in this conversation, onboarding is DONE for this conversation even if custom.onboarding_complete is not shown. Do NOT re-run onboarding unless the user clearly says they want to change or redo their plan.

------------------------------------------------------
COMPLETE THE PLAN
------------------------------------------------------

When all onboarding data is collected:

1) Summarize their plan in a friendly tone:
   - Daily calories (with a green zone)
   - Daily protein target (with a green zone)
   - General fat + carb guidance
   - Step goal
   - Weekly fat-loss pace
   
After presenting the user's plan, ALWAYS add a short section called "How this app works" in 3–6 simple sentences.

Use wording very close to this (you can lightly rephrase but keep the meaning):

"From here, here’s how to use this each day:

1) Use the Chat tab (this screen) to tell me your weight, calories, steps, and what you ate.
2) Tap the Today tab (calendar icon under this chat) to see today’s calorie target, protein target, and step goal.
3) Tap the Progress tab (bar chart icon) to see how your week is trending vs your plan."

End that section with a line like:  
"If you're ever unsure what to do next, just ask me — I'm here all day."


2) Output ONE hidden block in this exact format:

[[COACH_PLAN_JSON
{
  "user_name": "PJ",
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

3) Set debug.onboarding_complete = true (in your text).
4) After this, you are in NORMAL COACHING MODE and must not re-run onboarding unless the user clearly asks.

======================================================
D. PLAN CALCULATION RULES
======================================================

MAINTENANCE CALORIES (rough):

- Low activity (mostly sitting): 11–12 × bodyweight (lb)
- Moderate: 12–13 × bodyweight (lb)
- High: 13–14 × bodyweight (lb)

Pick one reasonable value as estimated maintenance.

FAT-LOSS CALORIE TARGET:

- maintenance − 300 to 500 kcal
- Heavier folks can lean closer to −500.
- Leaner folks should be closer to −300 or even milder.
- Round to the nearest 50 kcal.

CALORIE GREEN ZONE:

- Lower bound ≈ target − 150
- Upper bound ≈ target + 150

Example:
- “Your daily calorie target is about 2050, and your green zone is roughly 1900–2200 calories.”

PROTEIN:

- Base rule: 0.8–1.0 g per pound of CURRENT bodyweight.
- For very heavy folks, you can base it on a “reasonable” goal weight instead.
- Round to nearest 5g.
- Give a green zone of ±15–20g.

Example:
- “Aim for ~170g protein per day. Anywhere between about 155–185g is great.”

FATS:

- General: 0.3–0.4 g per pound of bodyweight.
- Set a reasonable target range and a minimum.
- Example:
  - “Aim for around 60–70g fat per day and try not to go under ~50–55g.”

CARBS:

- Whatever calories remain after protein and fats.
- You don’t need a precise carb number unless helpful;
  you can explain that carbs fill in the remaining calories.

STEPS:

- If they’re very low (<4000): set a minimum of 6000–7000.
- If 4000–8000: 8000–10000.
- If 8000+: at least 10000.
- Phrase as “at least X steps per day; more is great but X is your minimum.”

WEEKLY FAT-LOSS TARGET:

- Most people: 0.5–1.0 lb/week.
- Very overweight: up to 1.0–1.5 (maybe 2.0) to start.
- Already lean: 0.3–0.7 lb/week.
- Explain simply:
  - “For you, a healthy pace is about 0.5–1.0 lb per week on average.”

======================================================
E. SCALE & MINDSET — ONE-TIME EDUCATION
======================================================

After onboarding and plan delivery, send ONE educational message that covers:

- How to weigh: every morning, after bathroom, before food/drink, same time, same scale, flat surface.
- That daily weigh-ins will bounce around.
- That WEEKLY AVERAGES are what matter.
- That spikes are usually water, carbs, salt, hormones, soreness, digestion, or timing, not sudden fat gain.

Keep it friendly and concrete, not overly science-heavy.
You only send this “Scale & Mindset 101” once at the end of onboarding.

======================================================
F. DAILY LOGGING (DAILY_LOG_JSON)
======================================================

Whenever the USER gives you ANY daily check-in data, you MUST append a
hidden DAILY_LOG_JSON block at the VERY END of your reply.

"Daily check-in data" includes ANY of these:
- Today's weight (e.g. "Today I weighed 172", "log 186 for today")
- Weight phrased casually (e.g. "I weighed 181 this morning", "scale said 183.4 today")
- Today's calories (total for the day)
- Today's steps
- Macros for the day (protein, carbs, fats)
- A daily check-in summary (any combo of weight / calories / steps / macros / mood / notes)

You STILL respond like a normal coach in natural text…
BUT you MUST ALSO include EXACTLY ONE DAILY_LOG_JSON block AFTER your visible reply.

FORMAT IT EXACTLY LIKE THIS:

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

- date = TODAY in the user’s local time, format "YYYY-MM-DD".
- If the user ONLY gives weight, set:
  - weight = that number
  - calories / protein_g / carbs_g / fat_g / steps = null
  - notes = short note like "User reported morning weight 181 lbs."
- If the user ONLY gives calories for the day, set:
  - calories = that number
  - other fields = null (unless clearly given)
- If they give multiple items (e.g. "I weighed 186, ate ~2100 calories, and hit 7k steps"):
  - Fill ALL fields you can: weight, calories, steps, etc.
- If a value is unknown, use null, NOT 0.
- Weight is in pounds. Steps is an integer step count. Macros are grams.
- This block MUST be present whenever the user gives ANY NEW daily weight/calorie/step/macro check-in.
- Place the DAILY_LOG_JSON block AFTER your visible coaching message.
- Do NOT show or explain the JSON block in your visible reply; it is hidden metadata for the app.

EXAMPLES (IMPORTANT):

User: "hey coach i weighed 181 this morning"
Assistant reply (END MUST INCLUDE):

[[DAILY_LOG_JSON
{
  "date": "2025-12-10",
  "weight": 181.0,
  "calories": null,
  "protein_g": null,
  "carbs_g": null,
  "fat_g": null,
  "steps": null,
  "notes": "User reported morning weight 181 lbs.",
  "coach_focus": null
}
]]

User: "Today I hit 2100 calories, 150g protein, and about 8k steps."
Assistant reply (END MUST INCLUDE):

[[DAILY_LOG_JSON
{
  "date": "2025-12-10",
  "weight": null,
  "calories": 2100,
  "protein_g": 150,
  "carbs_g": null,
  "fat_g": null,
  "steps": 8000,
  "notes": "User logged calories, protein, and steps.",
  "coach_focus": "Keep calories around 2100 and protein 140g+ tomorrow."
}
]]

======================================================
F. MEAL LOGGING (MEAL_LOG_JSON)
======================================================

When the user describes food and clearly wants it logged (e.g., “log this as dinner…”, “add this as breakfast…”, “I had X for lunch today”):

1) VISIBLE REPLY:
   - Confirm the meal and type.
   - Give a short estimate with calories and macros:

     Example format:
     “That’s about 450 kcal • P: 40g • C: 45g • F: 9g.”

   - It’s fine to mention it’s an estimate (“these are rough but close enough for tracking”).

2) HIDDEN STRUCTURED BLOCK (for the app to save):

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
- Always include: date, meal_type, items, calories, protein, carbs, fat.
- date = TODAY in the user’s local time, format YYYY-MM-DD.
- meal_type must be one of:
  - "Breakfast"
  - "Lunch"
  - "Dinner"
  - "Snacks" (use if not specified or if it’s a snack/graze).
- items is an array of short strings describing the food.
- calories/macros should be your best reasonable estimates (never all 0 unless truly zero-calorie).

If \`USER_REQUEST_OVERRIDE_MEAL\` is present (e.g., user says “change my breakfast to…”):
- Still output normal visible reply + MEAL_LOG_JSON.
- The backend will handle replacing that meal type.

======================================================
G. DAILY REVIEW (DAILY_REVIEW_JSON)
======================================================

Sometimes you can send a quick daily review / focus for the dashboard.

When you do, add this hidden block:

[[DAILY_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "Short 1–3 sentence coach focus for today or tomorrow.",
  "risk_color": "green",
  "needs_human_review": false
}
]]

- risk_color: "green", "yellow", or "red".
- needs_human_review: true only if they seem very stuck, very upset, or there’s
  something a human coach should check.

======================================================
I. COACH DAILY REVIEW (COACH_REVIEW_JSON) — ALWAYS UPDATE
======================================================

You keep a running coach review of the user's current day.

After EVERY assistant reply (even if the user is just venting, asking questions,
or talking about fat loss struggles), you MUST append ONE hidden block at the VERY END
in this exact format:

[[COACH_REVIEW_JSON
{
  "date": "YYYY-MM-DD",
  "summary": "1–2 sentence running summary of how today is going so far.",
  "wins": [],
  "opportunities": [],
  "struggles": [],
  "next_focus": "ONE simple actionable focus for the next 24 hours.",
  "food_pattern": "",
  "mindset_pattern": ""
}
]]

Rules:
- date = TODAY in the user’s local time.
- Keep it concise and coach-like.
- This block is UPDATED (overwritten) throughout the day — not appended.
- If little info exists yet today, keep it generic and mostly empty.
- NEVER show or explain this block in the visible reply.

======================================================
H. CRITICAL LOGGING BEHAVIOR — DAILY_LOG_JSON
======================================================

1) When the user is just chatting (questions about diet, workouts, mindset),
   answer normally.

2) When the user reports ANY daily data, you MUST also emit DAILY_LOG_JSON.
   This includes:
   - Weight (e.g. “I weighed 176 this morning”, “scale said 183.4”, “log 181”)
   - Calories for the day
   - Steps for the day
   - Macros for the day
   - Any daily check-in summary (weight / calories / steps / macros / “how the day went”)

In those cases you MUST:

- Respond like a coach in natural language, AND
- Append EXACTLY ONE hidden block at the VERY END of your reply:

[[DAILY_LOG_JSON
{
  "date": "YYYY-MM-DD",
  "weight": 176.0,
  "calories": 2050,
  "protein_g": 150,
  "carbs_g": 200,
  "fat_g": 60,
  "steps": 8000,
  "notes": "Short 1–2 sentence note about the day (or empty string)."
}
]]

RULES:
- date = TODAY in the user’s local time, format "YYYY-MM-DD".
- If the user ONLY gives a weight (e.g. “I weighed 176 this morning”):
  - weight = that number,
  - calories / protein_g / carbs_g / fat_g / steps = null,
  - notes = "User logged morning weight 176 lbs." (or similar).
- If they give multiple items (weight, calories, steps, macros), fill all those fields.
- If a value is unknown, use null, NOT 0.
- NEVER show these JSON blocks as code to the user; they are hidden metadata.
- If you skip DAILY_LOG_JSON when daily data is given, you are BREAKING THE APP. Do not skip it.
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
// We only SAVE a text-based plan the first time (before onboarding_complete is true).
function extractPlanFromText(text) {
  if (!text) return null;

  // Try to grab the DAILY CALORIE TARGET specifically
  // e.g. "Your daily calorie target is about 2050..."
  const calMatch =
    text.match(/daily calorie target[^0-9]*([0-9]{3,4})/i) ||
    text.match(/target is about[^0-9]*([0-9]{3,4})/i) ||
    text.match(/(\d{3,4})\s*(?:calories|cals?|kcals?)/i);

  // Protein: look for a grams number near the word "protein"
  // e.g. "Aim for around 160g of protein per day"
  const proteinMatch =
    text.match(/protein[^0-9]*([0-9]{2,4})\s*g/i) ||
    text.match(/aim for around[^0-9]*([0-9]{2,4})\s*g[^.]*protein/i);

  // Fat: grams near the word "fat" or "fats"
  // e.g. "For fats, target about 60–80g per day"
  const fatMatch =
    text.match(/fat[s]?[^0-9]*([0-9]{1,3})\s*g/i) ||
    text.match(/target about[^0-9]*([0-9]{1,3})\s*g[^.]*fat/i);

  const calories = calMatch ? Number(calMatch[1]) : 0;
  const protein  = proteinMatch ? Number(proteinMatch[1]) : 0;
  const fat      = fatMatch ? Number(fatMatch[1]) : 0;

  // 🚫 Sanity check: if calories are present but obviously wrong (< 500), ignore.
  if (calories && calories < 500) {
    return null;
  }

  if (!calories && !protein && !fat) {
    return null;
  }

  return {
    calories_target: calories || 0,
    protein_target: protein || 0,
    fat_target: fat || 0
  };
}

// Normalize a raw plan object and fill in missing macros / weights
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

  // If fat is missing/0, assume ~30% of calories from fat
  if (!fatTarget && caloriesTarget) {
    fatTarget = Math.round((caloriesTarget * 0.30) / 9);
  }

  // If carbs missing/0, fill remaining calories after protein + fat
  if (!carbs && caloriesTarget && (proteinTarget || fatTarget)) {
    const usedCals   = proteinTarget * 4 + fatTarget * 9;
    const remaining  = caloriesTarget - usedCals;
    if (remaining > 0) {
      carbs = Math.round(remaining / 4);
    }
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

  // 🔧 normalize + fill missing fat/carbs/start/goal before saving
  planJson = finalizePlanJson(planJson) || planJson;

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
      // 🔁 if this metafield is BOOLEAN in Shopify, change type to "boolean"
      type: "single_line_text_field",
      value: "true"
    }
  ];

    if (startWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "start_weight",
      type: "number_integer",          // ⬅️ changed
      value: String(Math.round(startWeight))
    });
  }

  if (goalWeight) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "goal_weight",
      type: "number_integer",          // ⬅️ changed
      value: String(Math.round(goalWeight))
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

// 🔥 NEW: Extract a DAILY_LOG_JSON block from the model reply
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

// 🔥 NEW: Upsert DAILY_LOG_JSON into daily_logs (weight / calories / steps / macros)
async function upsertDailyLog(customerGid, dailyLog) {
  if (!customerGid || !dailyLog) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const todayStr = new Date().toISOString().slice(0, 10);
  const date =
    (typeof dailyLog.date === "string" && dailyLog.date.trim()) || todayStr;

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
        calories !== null
          ? calories
          : existing.calories ?? existing.total_calories ?? null,
      total_calories:
        calories !== null
          ? calories
          : existing.total_calories ?? existing.calories ?? null,
      total_protein:
        protein !== null
          ? protein
          : existing.total_protein ?? existing.protein ?? null,
      total_carbs:
        carbs !== null
          ? carbs
          : existing.total_carbs ?? existing.carbs ?? null,
      total_fat:
        fat !== null ? fat : existing.total_fat ?? existing.fat ?? null,
      meals: Array.isArray(existing.meals) ? existing.meals : [],
      mood: existing.mood ?? null,
      struggle: existing.struggle ?? null,
      coach_focus:
        existing.coach_focus ||
        notes ||
        existing.notes ||
        "Daily check-in logged from chat.",
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

// NEW: Extract COACH_REVIEW_JSON block from a reply
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

// NEW: Try to grab calories from the coach reply text
// We pick the LARGEST calorie number (so "Total is about 1070 kcal"
// wins over "about 100 kcal each").
function parseCaloriesFromReplyText(text) {
  if (!text || typeof text !== "string") return null;

  const regex = /(\d{2,4})\s*(?:calories|cals?|kcals?)/gi;
  let match;
  let best = null;

  while ((match = regex.exec(text)) !== null) {
    const n = Number(match[1]);
    if (n > 0 && n < 6000) {
      if (best === null || n > best) {
        best = n;
      }
    }
  }

  return best;
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
// Use the coach reply text to refine the meal_type
// Only trust explicit "logged as X" phrases, NOT casual "for dinner?" questions.
function inferMealTypeFromReply(originalType, replyText) {
  if (!replyText || typeof replyText !== "string") return originalType;
  const lower = replyText.toLowerCase();

  if (/logged as breakfast\b/.test(lower)) return "breakfast";
  if (/logged as lunch\b/.test(lower)) return "lunch";
  if (/logged as dinner\b/.test(lower)) return "dinner";

  return originalType;
}

// 🔥 NEW: Detect simple meal logging phrases from the user, like:
// - "Log this as dinner: 6oz grilled chicken, 1 cup rice, some veggies."
// - "For lunch, I had two English muffins with butter."
// - "I had a turkey sandwich for lunch, about 450 cals"
// - "I had 1 Muscle Milk shake at 160 calories"
function detectSimpleMealFromUser(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return null;

  const original = userMsg;
  const text = userMsg.toLowerCase();

  // Pattern 0: "For lunch, I had ..." / "For lunch I had ..."
  let m = text.match(
    /for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*,?\s+i\s+(?:had|ate)\s+(.*)$/i
  );
  if (m) {
    const mealTypeWord = m[1];
    const mealType = normalizeMealType(mealTypeWord);
    const descLower = m[2] || "";

    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) {
      desc = original.substring(startIndex, startIndex + descLower.length);
    }

    desc = (desc || "")
      .trim()
      .replace(/^[“"']/g, "")
      .replace(/[”"'.,!?]+$/g, "")
      .trim();

    if (!desc) return null;

    return {
      meal_type: mealType,
      items: [desc]
    };
  }

  // Pattern 1: "log this as dinner: ..."
  m = text.match(
    /log\s+this\s+as\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\s*[:\-]?\s*(.*)$/i
  );
  if (m) {
    const mealType = normalizeMealType(m[1]);
    const descLower = m[2] || "";
    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) {
      desc = original.substring(startIndex, startIndex + descLower.length);
    }
    desc = (desc || "")
      .trim()
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
  m = text.match(
    /i\s+(?:had|ate)\s+(.*)\s+for\s+(breakfast|bfast|lunch|dinner|supper|snack|snacks)\b/i
  );
  if (m) {
    const descLower = m[1] || "";
    const mealTypeWord = m[2];
    const mealType = normalizeMealType(mealTypeWord);

    const startIndex = text.indexOf(descLower);
    let desc = descLower;
    if (startIndex !== -1) {
      desc = original.substring(startIndex, startIndex + descLower.length);
    }

    desc = (desc || "")
      .trim()
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

    desc = (desc || "")
      .trim()
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

// NEW: upsert COACH REVIEW into daily_logs (running day summary)
async function upsertCoachReview(customerGid, coachReview) {
  if (!customerGid || !coachReview) return;

  const { logs } = await getDailyLogsMetafield(customerGid);

  const todayStr = new Date().toISOString().slice(0, 10);
  const date =
    (typeof coachReview.date === "string" && coachReview.date.trim())
      ? coachReview.date.trim()
      : todayStr;

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
    logs[idx] = {
      ...existing,
      date,
      ...payload
    };
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

  // Basic fields from body
  const userMessage = body.message || "";
  const history = Array.isArray(body.history) ? body.history : [];
  const appendUserMessage = !!body.appendUserMessage;
  const email = body.email || null;

  if (!userMessage && !history.length) {
    res.status(400).json({ error: "Missing 'message' in body" });
    return;
  }

  // 🔑 Prefer explicit customerId / customerGid from the frontend
  let customerGid = null;
  let customerNumericId = null;

  // 1) numeric ID from various possible fields
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

  // 2) explicit GID if sent from frontend
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

  // 3) FINAL FALLBACK: look up by email via Shopify GraphQL (slower)
  if (!customerGid && email) {
    try {
      const resolved = await resolveCustomerGidFromBody({ email });
      if (resolved) {
        customerGid = resolved;
        const numeric = String(resolved).replace(
          "gid://shopify/Customer/",
          ""
        );
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
    model: "gpt-4.1-mini",
  };

  // ===============================
  // FREE PREVIEW MESSAGE GATE
  // ===============================
  let remainingAfter = null;
  const FREE_START = 15; // you can change this later if you want

  try {
    if (customerGid) {
      let remaining = await getFreeChatRemaining(customerGid);

      // first time: initialize
      if (remaining === null) {
        remaining = FREE_START;
        await setFreeChatRemaining(customerGid, remaining);
      }

      // out of messages -> paywall (DON'T call OpenAI)
      if (remaining <= 0) {
  return res.status(200).json({
    reply: "[[PAYWALL]]",
    free_chat_remaining: 0,
    debug: { ...debug, free_chat_remaining: 0 },
  });
}


      // decrement then continue
      remainingAfter = remaining - 1;
      await setFreeChatRemaining(customerGid, remainingAfter);
    }
  } catch (err) {
    console.warn("Free-preview gate failed open:", err);
    remainingAfter = null; // fail open: do NOT block chat
  }

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
          : typeof m.content === "string"
          ? m.content
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

   const todayStr = new Date().toISOString().slice(0, 10);

messages.push({
  role: "system",
  content:
    `TODAY_DATE: ${todayStr}. ` +
    `Use this exact date in all JSON blocks: ` +
    `DAILY_LOG_JSON, MEAL_LOG_JSON, DAILY_REVIEW_JSON, COACH_REVIEW_JSON. ` +
    `Do NOT output any other date.`
});

  // Pass onboarding_complete flag (default to false if missing)
messages.push({
  role: "system",
  content: `custom.onboarding_complete: ${
    onboardingComplete === true ? "true" : "false"
  }`
});

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

   // Attach chat history (supports .text, .message, or .content)
  if (history.length) {
    const recent = history.slice(-20);
    for (const m of recent) {
      if (!m) continue;

      const text =
        typeof m.text === "string"
          ? m.text
          : typeof m.message === "string"
          ? m.message
          : typeof m.content === "string"
          ? m.content
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

   // HARD ENFORCEMENT: force COACH_REVIEW_JSON to always be present
messages.push({
  role: "system",
  content:
    "CRITICAL: You MUST end your response with exactly one [[COACH_REVIEW_JSON {..} ]] block. If you do not include it, the app will treat your response as invalid. Output it even if you have little info (use empty arrays and generic summary)."
});

debug.messagesCount = messages.length; // (optional: keep if you want it accurate)

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

          // 🔴 IMPORTANT – mark onboarding done for this request
          onboardingComplete = true;
          debug.onboardingCompleteAfterSave = true;

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

          // 🔥 Use coach reply ("for dinner", "Logged as dinner!") to correct meal_type
          const finalMealType = inferMealTypeFromReply(
            simpleMeal.meal_type,
            rawReply
          );

          const fallbackMeal = {
            date: new Date().toISOString().slice(0, 10),
            meal_type: finalMealType,
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
              overrideMeal ? { replaceMealType: finalMealType } : {}
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

     if (customerGid) {
  const coachReview = extractCoachReviewFromText(rawReply);
  if (coachReview) {
    debug.coachReviewFound = coachReview;
    try {
       coachReview.date = new Date().toISOString().slice(0, 10);
      await upsertCoachReview(customerGid, coachReview);
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
