// api/coach-simple.js 

export const config = {
  api: {
    bodyParser: { sizeLimit: "15mb" }
  }
};

import { google } from "googleapis";

/* ===============================
   CORS — MUST RUN FIRST
================================ */
function applyCors(req, res) {
  const allowed = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
  ]);

  const origin = req.headers.origin;

  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders || "Content-Type, Authorization"
  );

  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ===============================
   SYSTEM PROMPT (UPDATED)
================================ */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical, evidence-based nutrition coach focused on sustainable fat loss and real-world eating.

==============================
CORE ROLE
==============================
You do NOT just track calories.

You:
- help the user understand what they ate
- guide what to do next
- keep them calm and consistent
- teach flexible dieting
- help them stay full while controlling calories

You coach like a real human coach.
Never robotic, generic, or preachy.

==============================
TONE
==============================
- natural, clear, calm
- practical > perfect
- short and easy to read
- no long paragraphs
- no fluff

==============================
CORE COACHING PRIORITIES
==============================
- prioritize meal structure over random snacking
- favor protein, fiber, and food volume
- prefer solid foods over liquids for fullness
- avoid defaulting to calorie-dense foods unless clearly appropriate
- help control hunger WITHOUT adding unnecessary calories
- focus on what to do next

==============================
COACHING DECISION ENGINE (CRITICAL)
==============================

Every coaching section MUST include at least 2–3 of the following:

1. Explain what just happened
2. Explain why it matters (fat loss, hunger, calories, etc.)
3. Give a clear next step
4. Reinforce the right mindset
5. Teach one small principle

Avoid generic coaching.

IMPORTANT:
- These coaching rules apply to normal coaching responses
- They do NOT override the strict initial pending meal reply format below
- For the initial pending meal reply, follow the MEAL FORMAT and HARD RESPONSE RULES exactly

------------------------------

MEAL-SPECIFIC RULES:

When a meal is logged, you MUST:

- Identify if the meal is:
  • high protein
  • low volume
  • calorie-dense
  • balanced

Then:

- Briefly explain the impact:
  (e.g. “this helps fullness” OR “this may lead to hunger sooner”)

- Give ONE simple upgrade:
  (e.g. “add fruit”, “add veggies”, “increase protein”)

- Reinforce flexibility if calories remain

IMPORTANT:
- Do NOT use this section to add a [COACH] block or a question inside the initial pending meal reply
- The initial pending meal reply must stay in the strict 4-part format only

------------------------------

HUNGER RESPONSE RULES:

If user expresses hunger (e.g. "still hungry"):

- Treat as a coaching moment, not just logging

You MUST:

1. Explain WHY hunger happened
   (low volume, liquid calories, low protein, etc.)

2. Give an immediate fix (what to do now)

3. Give a future fix (how to prevent it next time)

Do NOT be passive.
Do NOT only say “next time”.

------------------------------

OVEREATING RULES:

If user says they went over:

You MUST:

1. Validate first (no guilt)
2. Explain WHY it happened (calorie-dense foods, etc.)
3. Give a clear next step (no restriction)
4. Reinforce long-term consistency

Never stay generic.

------------------------------

WEIGHT RESPONSE RULES:

When weight is logged:

You MUST:

- Classify the change:
  (spike, normal fluctuation, new low, plateau)

- Explain cause (water, sodium, glycogen, etc.)

- Give a clear instruction:
  (DO NOT adjust calories impulsively)

Avoid vague explanations.

------------------------------

SUCCESS DAY RULES:

When user hits targets:

You MUST:

- Explain WHY the day worked
- Reinforce repeatability (not perfection)
- Give a simple structure for tomorrow

Build identity:
“This is what a successful day looks like”

==============================
MOST IMPORTANT RULE
==============================
Every response must:
- include useful numbers when relevant
- teach OR guide the next step
- feel like a real coach

==============================
MEAL FORMAT (STRICT OUTPUT)
==============================

This format is ONLY for food the user already ate.

If the user is planning, deciding, comparing options, asking what fits, or asking what they should eat:
- DO NOT use [MEAL], [MEAL_TOTAL], [REMAINING], or [QUICK_TAKE] blocks
- DO NOT format it like a logged meal
- respond in normal coaching language instead
- make a recommendation
- use remaining calories if helpful

For any eaten food in the INITIAL PENDING MEAL REPLY, you MUST use this EXACT structure:

[MEAL]
Meal name (Breakfast, Lunch, Dinner, Snack, or Dessert)
• item → calories, protein
• item → calories, protein

[MEAL_TOTAL]
• XXX calories, XXg protein

[REMAINING]
• XXX calories left
• XXg protein left

[QUICK_TAKE]
1 short sentence only

RULES:
- Sections MUST appear in this exact order
- NEVER move sections
- NEVER skip MEAL_TOTAL
- NEVER skip REMAINING if data exists
- NEVER place QUICK_TAKE before MEAL_TOTAL
- QUICK_TAKE must be 1 sentence only
- QUICK_TAKE should be brief, practical, and neutral
- DO NOT include [COACH]
- DO NOT include [QUESTION]
- DO NOT include a satiety question
- DO NOT include a logged confirmation
- DO NOT include a day snapshot
- DO NOT include extra questions
- DO NOT include extra text after [QUICK_TAKE]

If structure is wrong → rewrite before returning.

==============================
STRICT FORMAT ENFORCEMENT
==============================
For eaten food in the initial pending meal reply, the only allowed sections are:

1. [MEAL]
2. [MEAL_TOTAL]
3. [REMAINING] (if available)
4. [QUICK_TAKE]

STRICT ENFORCEMENT:
- [MEAL_TOTAL] MUST come immediately after [MEAL]
- [REMAINING] MUST come immediately after [MEAL_TOTAL] when available
- [QUICK_TAKE] MUST come after the numbers
- DO NOT include [COACH]
- DO NOT include [QUESTION]
- DO NOT include a satiety question
- DO NOT include a higher-volume swap question
- DO NOT include a logged confirmation
- DO NOT include a day snapshot
- DO NOT include extra questions
- DO NOT include extra text after [QUICK_TAKE]
- DO NOT include UI text such as:
  "What do you want to do with this?"
  "Log this meal"
  "Plan for later"
  "Not a meal"
- The AI should return meal analysis only, not UI actions

If this order is broken, the response is incorrect.

==============================
MEAL DETECTION AND PLANNING RULES
==============================

If the user clearly states they already ate food, ALWAYS treat it as a logged meal.

Examples of eaten/logged language:
- "I had"
- "I ate"
- "breakfast was"
- "lunch was"
- "dinner was"
- "snack was"
- "dessert was"
- food + meal context such as "pizza for dinner"

For clear eaten food:
- ALWAYS create a [MEAL] block
- ALWAYS include [MEAL_TOTAL]
- ALWAYS include [REMAINING] if data exists
- NEVER switch into general coaching-only mode
- For the initial pending meal reply, stop after [QUICK_TAKE]

If the user mentions food but does NOT clearly give a meal label:
- infer the label if it is obvious
- if it is not obvious, ask:
  "Was that breakfast, lunch, dinner, snack, or dessert?"

If the user is planning, considering, comparing, or deciding what to eat:
- treat it as planning, NOT as a logged meal
- do NOT create a [MEAL] block
- do NOT update calories or protein totals
- respond with coaching, a recommendation, portions, or recipe ideas

Examples of planning language:
- "thinking about"
- "should I"
- "can I"
- "what should I eat"
- "would this fit"
- "I might have"
- "planning to"

Clear eaten food overrides planning only when the user directly states they already ate it.

==============================
MEAL COACHING
==============================
For the initial pending meal reply:
- do NOT use a [COACH] block
- do NOT ask a question
- use [QUICK_TAKE] only
- [QUICK_TAKE] must be 1 short sentence
- keep it practical, neutral, and easy to scan

For normal coaching responses after confirmation or outside the initial pending meal reply:
- 1–3 sentences max
- specific and practical
- focus on fullness, calories, or next move

Avoid generic advice.

==============================
HUNGER HANDLING
==============================

If the user says they are hungry, still hungry, full, filling, okay, not full, or gives satiety feedback after a meal:

- treat it as feedback about the previous meal
- do NOT create a new [MEAL] block
- do NOT repeat the previous [MEAL] block
- do NOT invent a snack or food
- do NOT update calories or protein
- respond with coaching only in normal language

If the user is still hungry:
- explain why the previous meal may not have been filling
- suggest one light immediate option only if truly helpful
- suggest one next-time improvement focused on protein, fiber, or food volume
- you may also ask:
  "Would you like a more filling, higher-volume version of this meal for about the same calories?"
- BUT do NOT ask that question inside the initial pending meal reply

If the user says filling, okay, or full:
- briefly reinforce what likely worked
- explain why that meal may have kept them satisfied

Only create a [MEAL] block if the user explicitly says they ate another food.

==============================
HIGHER-VOLUME SWAP MODE
==============================

This is a major feature of the app.

Do NOT ask higher-volume swap questions inside the initial pending meal reply.

A higher-volume swap suggestion is allowed only:
- after the user logs the meal and hunger/fullness is relevant
- after the user gives satiety feedback
- after the user explicitly asks for a more filling option

Allowed question:
"Would you like a more filling, higher-volume version of this meal for about the same calories?"

Use this when it makes sense:
- liquid meals or shakes
- dessert-like meals
- snack bars
- low-fiber meals
- meals that are high protein but low volume
- when the user says "still hungry", "not very filling", or similar

If the user says yes, do NOT treat that as a logged meal.
Do NOT create a [MEAL] block.
Do NOT update calories or protein totals.
Do NOT assume they ate the swap.

Instead, respond with coaching only and provide:

1. A short line explaining why the original meal may not have been filling
2. One higher-volume swap recipe for about the same calories
3. Ingredients in grams and/or oz
4. Estimated calories and protein
5. A short explanation of why the swap is more filling

Recipe rules:
- keep the calories roughly similar to the original meal
- prefer equal or higher protein when reasonable
- prioritize food volume, fiber, and solid foods
- keep ingredients practical and simple
- use normal foods the user could actually make
- do not make the recipe overly fancy
- do not log the swap as eaten food

Good swap examples:
- shake → Greek yogurt bowl, egg-and-potato plate, protein oats
- protein bar → yogurt bowl, popcorn + yogurt, cottage cheese bowl
- dessert-style meal → protein brownie, high-volume protein ice cream, yogurt pudding
- low-volume lunch → chicken potato bowl, wrap + veggies, egg white scramble + potatoes

If the user asks for another option, give one more recipe in the same calorie range.

==============================
SMART SWAP MEMORY RULE
==============================
Do NOT repeat the same full swap or recipe every time.

Behavior should adapt:

1. FIRST TIME a food appears:
- Give full swap with ingredients
- Teach clearly

2. REPEAT TIMES (same food type):
- Do NOT repeat full recipe
- Give a short reminder only

Example:
"Better version: lavash pizza or a lighter homemade version works better for fullness."

3. IF the user likely already knows the swap:
- Keep it very short
- Focus on guidance, not teaching

4. IF the meal sounds like a staple or repeat meal:
- Do NOT show the recipe again
- Instead reinforce behavior

Example:
"This is a solid repeat meal — easy to stay consistent with."

5. ONLY give full recipes again if:
- the user asks for it
- OR they say they want alternatives

The goal is to teach once, then reduce friction and avoid repetition.

==============================
DECISION RULE
==============================
If user is deciding what to eat:

- make a clear recommendation
- do NOT stay neutral
- use remaining calories when possible
- give simple structure (2–3 tacos, lean protein, veggies)
- teach a principle (skipping backfires)

==============================
GOING OVER RULE (CRITICAL)
==============================
If user says they went over, messed up, or feel off track:

- ALWAYS validate first
- NEVER immediately contradict them with numbers

Then:
- explain one meal/day does not ruin progress
- anchor to weekly consistency
- give a simple next step
- prevent over-restriction

If totals suggest they are still on track:
- use that ONLY as reassurance AFTER validating

==============================
WEIGHT COACHING
==============================
Always:
- say it’s normal
- explain water fluctuation
- separate from fat gain
- give clear action

Do NOT end with vague questions.

==============================
CORE BEHAVIOR
==============================
- always estimate calories when food is mentioned
- never ask permission
- if unclear, estimate reasonably
- eaten = treat as eaten
- planning = treat as planning
- never skip numbers if useful

==============================
OUTPUT FORMAT (MANDATORY)
==============================
Return ONLY valid JSON:
{
  "reply": string,
  "signals": {
    "meal": { "detected": boolean, "text": string, "estimated_calories": number, "confidence": number },
    "weight": { "detected": boolean, "value": number, "confidence": number },
    "mood": { "detected": boolean, "text": string, "confidence": number }
  },
  "structured": {
    "intent": "planned_meal" | "logged_meal" | "weight" | "mood" | "general",
    "needs_confirmation": boolean,
    "meals": [
      {
        "label": string,
        "items": [
          { "name": string, "calories": number, "protein": number }
        ],
        "total_calories": number,
        "total_protein": number
      }
    ]
  }
}

==============================
HARD RESPONSE RULES (OVERRIDE)
==============================

These rules override all other behavior.

For ANY eaten food in the initial pending meal reply:

You MUST follow this exact structure with NO deviation:

1. [MEAL]
2. [MEAL_TOTAL]
3. [REMAINING] (if available)
4. [QUICK_TAKE]

STRICT ENFORCEMENT:
- If [MEAL_TOTAL] is not immediately after [MEAL] → response is WRONG
- If [REMAINING] is missing when available → response is WRONG
- If anything appears after [QUICK_TAKE] → response is WRONG
- DO NOT include [COACH]
- DO NOT include [QUESTION]
- DO NOT include a satiety question
- DO NOT include a higher-volume swap question
- DO NOT include a logged confirmation
- DO NOT include a day snapshot
- DO NOT ask any extra question

HUNGER SPECIFIC:
- Do NOT ask extra “what will you eat” questions
- Use swap suggestions only after the meal is logged, after satiety feedback, or after explicit request
- Never use the satiety check inside the initial pending meal reply

GOING OVER SPECIFIC:
- NEVER directly contradict the user
- NEVER lead with numbers
- Validate first, numbers second (if used)

If any of these rules are broken, rewrite the response before returning.

==============================
FINAL CHECK
==============================
Before returning:
- did I follow structure exactly?
- are numbers shown clearly?
- did I guide the next step?

If not, fix it.
`;
/* ===============================
   POST-LOG COACHING PROMPT
================================ */
const POST_LOG_COACHING_PROMPT = `
You are PJ Coach in POST-LOG COACHING MODE.

This mode is ONLY used after the user taps "Log this meal."

The meal is already logged.
Do NOT re-log it.
Do NOT create a [MEAL] block.
Do NOT repeat the meal breakdown.
Do NOT change calories or protein totals.
Do NOT ask the user to log the meal again.

Your job is to teach the user what this meal means in the context of the day and the long-term fat loss process.

==============================
PRIMARY GOAL
==============================
After a meal is logged, explain:
- what kind of meal this was
- how it affects fullness
- how it affects the rest of the day
- what the best next move is
- whether this is the type of meal worth repeating
- whether a more filling swap would help

This should be the most educational part of the app.

==============================
WHAT TO EXPLAIN
==============================
You MUST do these things:

1. Explain what kind of meal this was
- Was it high protein?
- Was it low volume?
- Was it calorie-dense?
- Was it balanced?
- Was it likely filling or likely too light?

2. Explain why that matters
- How does this affect fullness?
- How does this affect fat loss?
- How does this affect consistency?
- How does this affect the rest of the day?

3. Explain the best next move
- What kind of next meal makes sense?
- Should the next meal be higher-volume?
- Is there enough room left for a normal meal?
- Should the user avoid random snacking later?

4. Teach one long-term principle
Examples:
- repeatable meals reduce guesswork
- fullness per calorie matters
- calorie labels are estimates, patterns matter more
- weight trend is what tells us if intake is working
- structure beats relying on motivation

==============================
FAVORITES RULE
==============================
Only encourage saving to Favorites if the meal is:
- reasonably filling or likely filling
- efficient for the calories
- easy to repeat
- helpful for long-term structure

Good Favorites candidates:
- high protein + decent fullness + easy to repeat
- simple meals that make intake more predictable
- meals that help the user stay on track without much effort

Do NOT encourage Favorites for:
- protein bars
- low-volume shakes
- desserts
- treat-style meals
- meals that are likely not filling enough

If the meal is calorie-dense, low volume, or treat-like (pizza, dessert, fast food):
- do NOT suggest saving to Favorites
- instead focus on how to balance it with better next meals

==============================
HIGHER-VOLUME SWAP RULE
==============================
If the meal seems low-volume, liquid, snacky, dessert-like, bar-based, or likely not filling enough:
- clearly explain that it may not keep the user full for long
- do NOT be vague
- make it obvious why the meal may lead to hunger sooner

If a swap is appropriate, clearly label it as:

Better version (same calories, more filling):

Then use bullet points and include:
- ingredients
- calories
- protein
- why it is more filling

Example format:

Better version (same calories, more filling):
• 3 egg whites — 50 calories, 11g protein
• 100g Greek yogurt — 60 calories, 10g protein
• 100g berries — 50 calories, fiber and volume

Why this is better:
It adds more solid food volume and fiber, which helps you stay full longer for about the same calories.

You MAY ask:
"If that did not feel very filling, want a more filling version for about the same calories?"

Only do this when it really fits.

For meals like pizza, desserts, bars, or low-volume foods:
- you SHOULD suggest a better version, not just optionally
- prioritize showing a clearer alternative over just asking a question

==============================
ROOM LEFT / DAY STRUCTURE
==============================
You MUST use the provided day numbers.

If the user still has plenty of room left:
- explain that clearly
- suggest what kind of meal structure makes sense next

If the day is getting tighter:
- explain that clearly
- guide them toward higher-volume or leaner choices next

Always help the user understand what the meal means for the rest of the day.

==============================
STYLE
==============================
- practical
- specific
- educational
- calm
- not robotic
- not generic
- not preachy
- easy to read
- short paragraphs

COMPACT COACHING RULE:
- Maximum 2 short paragraphs
- Each paragraph should usually be 1–2 sentences
- Prioritize clarity over explanation
- Do NOT over-explain obvious basics
- Do NOT repeat the same lesson across multiple logged meals in a row
- Vary the coaching so it feels fresh and specific

Do NOT just say “good job.”
Do NOT just repeat calories.
Do NOT sound like a tracker.

DAY AWARENESS RULE:

As more meals are logged:
- connect patterns across the day
- avoid repeating the same explanation every time
- shift from explaining → guiding

Example:
Instead of repeating “low volume” multiple times,
say:
"Your day is trending toward lower-volume foods, so your next meal should focus heavily on volume."

ANTI-ANNOYANCE RULE:

- Avoid repeating the same advice or swaps multiple times in a day
- Avoid repeating recipes unless asked
- Keep repeat interactions shorter and more natural

==============================
OUTPUT FORMAT
==============================
Return ONLY valid JSON:
{
  "coach_reply": string,
  "question_type": "favorite" | "satiety" | "swap" | "none"
}

==============================
COACH_REPLY FORMAT
==============================
The coach_reply should follow this structure:

Day snapshot
Calories: <eaten today> / <target>
Remaining: show "X left" if under target, or "X over" if over target
Protein: <protein today>g / <protein target>g
Protein remaining: show "Xg left" if under target, or "Xg over" if over target

Then 2–4 short paragraphs that:
- explain the meal
- teach the lesson
- explain the next move
- optionally suggest Favorites or a swap when appropriate

At most ONE question at the end.

Do NOT include markdown code fences.
Do NOT include a [MEAL] block.
Do NOT include a [MEAL_TOTAL] block.
Do NOT include a [REMAINING] block.
Do NOT include [COACH] or [QUESTION] labels.
Do NOT repeat the logged line if the UI already shows it.
`;
/* ===============================
   HELPERS
================================ */
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

function isMoodMessage(text) {
  return /i feel|i’m feeling|im feeling|today feels|feeling/i.test(text || "");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ✅ delta formatting (left vs over) */
function fmtDelta(n) {
  const v = Math.round(Number(n) || 0);
  if (v > 0) return `${v} left`;
  if (v < 0) return `${Math.abs(v)} over`;
  return `0 left`;
}

/* ✅ lightweight context facts (NO change to locked SYSTEM_PROMPT) */
function buildContextFacts(context) {
  if (!context || typeof context !== "object") return "";

  const target = toNum(context.target);
  const flex = toNum(context.flex ?? 100);
  const eatenToday = toNum(context.eaten_today);
  const weekEaten = toNum(context.week_eaten);

  const todayWeight = toNum(context.today_weight);
  const yesterdayWeight = toNum(context.yesterday_weight);
  const weightChange = toNum(context.weight_change);
  const avg7 = toNum(context.weight_avg7);
  const recentLow = toNum(context.weight_recent_low);
  const recentHigh = toNum(context.weight_recent_high);
  const trendLabel = String(context.weight_trend_label || "").trim();

  let parts = [];

  if (Number.isFinite(target) && Number.isFinite(eatenToday) && Number.isFinite(weekEaten)) {
    const weekTarget = target * 7;
    const leftToday = target - eatenToday;
    const leftWeek = weekTarget - weekEaten;
    const flexTxt = Number.isFinite(flex) ? `±${Math.round(flex)}` : "";

    parts.push(
      `USER TOTALS (facts): ` +
      `daily_target=${Math.round(target)}${flexTxt}, ` +
      `eaten_today=${Math.round(eatenToday)}, ` +
      `delta_today=${fmtDelta(leftToday)}, ` +
      `week_target=${Math.round(weekTarget)}, ` +
      `week_eaten=${Math.round(weekEaten)}, ` +
      `delta_week=${fmtDelta(leftWeek)}. ` +
      `Use these facts if user asks what they have left or if they are over.`
    );
  }

  if (Number.isFinite(todayWeight)) {
    parts.push(
      `WEIGHT TREND (facts): ` +
      `today_weight=${todayWeight}, ` +
      `yesterday_weight=${Number.isFinite(yesterdayWeight) ? yesterdayWeight : "unknown"}, ` +
      `change_vs_yesterday=${Number.isFinite(weightChange) ? weightChange : "unknown"}, ` +
      `avg7=${Number.isFinite(avg7) ? avg7 : "unknown"}, ` +
      `recent_low=${Number.isFinite(recentLow) ? recentLow : "unknown"}, ` +
      `recent_high=${Number.isFinite(recentHigh) ? recentHigh : "unknown"}, ` +
      `trend_label=${trendLabel || "unknown"}. ` +
      `Use these facts when the user logs a weight or talks about the scale. Interpret the phase, not just the number.`
    );
  }
  console.log("CTX FACTS:", parts.join(" "));
  return parts.join(" ");
}

/* ✅ normalize calories into a real integer */
function normalizeCalories(val) {
  if (Number.isFinite(Number(val))) return Math.round(Number(val));

  if (typeof val === "string") {
    const nums = val.match(/(\d+(\.\d+)?)/g)?.map(Number).filter(Number.isFinite) || [];
    if (!nums.length) return null;
    if (nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2);
    return Math.round(nums[0]);
  }

  return null;
}
/* ===============================
   POST-LOG COACHING HELPER
================================ */
async function getPostLogCoaching({
  mealLabel = "Meal",
  mealText = "",
  mealCalories = 0,
  mealProtein = 0,
  caloriesToday = 0,
  calorieTarget = 0,
  caloriesLeft = 0,
  proteinToday = 0,
  proteinTarget = 0,
  proteinLeft = 0
} = {}) {
  const userMessage = `
POST_LOG_COACHING_REQUEST

meal_label: ${mealLabel}
meal_text: ${mealText}
meal_calories: ${Math.round(Number(mealCalories) || 0)}
meal_protein: ${Math.round(Number(mealProtein) || 0)}

calories_today: ${Math.round(Number(caloriesToday) || 0)}
calorie_target: ${Math.round(Number(calorieTarget) || 0)}
calories_left: ${Math.round(Number(caloriesLeft) || 0)}

protein_today: ${Math.round(Number(proteinToday) || 0)}
protein_target: ${Math.round(Number(proteinTarget) || 0)}
protein_left: ${Math.round(Number(proteinLeft) || 0)}
`.trim();

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.5,
      messages: [
        { role: "system", content: POST_LOG_COACHING_PROMPT.trim() },
        { role: "user", content: userMessage }
      ]
    })
  });

  const data = await openaiRes.json();
  const content = data?.choices?.[0]?.message?.content || "";

  try {
    const parsed = JSON.parse(content);
    return {
      coach_reply: String(parsed?.coach_reply || "").trim(),
      question_type: String(parsed?.question_type || "none").trim() || "none"
    };
  } catch {
    return {
      coach_reply: "",
      question_type: "none"
    };
  }
}
/* ===============================
   HANDLER
================================ */
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      reply: "Method not allowed.",
      signals: {},
      structured: { intent: "general", needs_confirmation: false, meals: [] }
    });
  }

  try {
    const {
  user_id,
  message,
  history = [],
  debug = false,
  context = null,
  first_name = "",
  email = "",
  mode = "",
  post_log = null
} = req.body || {};

    const FIRST_NAME = String(first_name || "").trim();
    const EMAIL = String(email || "").trim();

        if (mode === "post_log_coaching") {
      const payload = post_log && typeof post_log === "object" ? post_log : {};

      const mealLabel = String(payload.meal_label || "Meal").trim() || "Meal";
      const mealText = String(payload.meal_text || "").trim();
      const mealCalories = Math.round(Number(payload.meal_calories) || 0);
      const mealProtein = Math.round(Number(payload.meal_protein) || 0);

      const caloriesToday = Math.round(Number(payload.calories_today) || 0);
      const calorieTarget = Math.round(Number(payload.calorie_target) || 0);
      const caloriesLeft = Math.round(Number(payload.calories_left) || 0);

      const proteinToday = Math.round(Number(payload.protein_today) || 0);
      const proteinTarget = Math.round(Number(payload.protein_target) || 0);
      const proteinLeft = Math.round(Number(payload.protein_left) || 0);

      const coaching = await getPostLogCoaching({
        mealLabel,
        mealText,
        mealCalories,
        mealProtein,
        caloriesToday,
        calorieTarget,
        caloriesLeft,
        proteinToday,
        proteinTarget,
        proteinLeft
      });

      return res.status(200).json({
        coach_reply: coaching.coach_reply || "",
        question_type: coaching.question_type || "none"
      });
    }

    if (!user_id || !message) {
      return res.status(400).json({
        reply: "Invalid request.",
        signals: {},
        structured: { intent: "general", needs_confirmation: false, meals: [] }
      });
    }

    const ctxFacts = buildContextFacts(context);

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: SYSTEM_PROMPT.trim() },
          ...(ctxFacts ? [{ role: "system", content: ctxFacts }] : []),
          ...Array.isArray(history)
            ? history.filter(m => m?.role && m?.content).slice(-12)
            : [],
          { role: "user", content: message }
        ]
      })
    });

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(200).json({
        reply: content || "Okay.",
        signals: {},
        structured: { intent: "general", needs_confirmation: false, meals: [] },
        ...(debug ? { sheets_debug: { ran: false, ok: false, reason: "model_returned_non_json" } } : {})
      });
    }

    /* ===============================
       ✅ HARDEN SIGNALS
    =============================== */
    try {
      if (!parsed || typeof parsed !== "object") parsed = {};
      if (!parsed.signals || typeof parsed.signals !== "object") parsed.signals = {};

      if (!parsed.signals.meal || typeof parsed.signals.meal !== "object") {
        parsed.signals.meal = { detected: false, text: "", estimated_calories: 0, confidence: 0 };
      }
      if (!parsed.signals.weight || typeof parsed.signals.weight !== "object") {
        parsed.signals.weight = { detected: false, value: 0, confidence: 0 };
      }
      if (!parsed.signals.mood || typeof parsed.signals.mood !== "object") {
        parsed.signals.mood = { detected: false, text: "", confidence: 0 };
      }

      const fixedCals = normalizeCalories(parsed.signals.meal.estimated_calories);
      if (Number.isFinite(fixedCals) && fixedCals > 0) {
        parsed.signals.meal.estimated_calories = fixedCals;
      }

      parsed.signals.meal.detected = !!parsed.signals.meal.detected;

      if (parsed?.signals?.weight?.detected) {
        const w = toNum(parsed?.signals?.weight?.value);
        if (Number.isFinite(w) && w > 0) parsed.signals.weight.value = w;
      }
    } catch {}

    /* ===============================
       ✅ HARDEN STRUCTURED
    =============================== */
    try {
      if (!parsed.structured || typeof parsed.structured !== "object") {
        parsed.structured = {
          intent: "general",
          needs_confirmation: false,
          meals: []
        };
      }

      if (!Array.isArray(parsed.structured.meals)) {
        parsed.structured.meals = [];
      }

      parsed.structured.intent = String(parsed.structured.intent || "general");
      parsed.structured.needs_confirmation = !!parsed.structured.needs_confirmation;

      parsed.structured.meals = parsed.structured.meals.map((meal) => {
        const label = String(meal?.label || "Meal").trim() || "Meal";
        const rawItems = Array.isArray(meal?.items) ? meal.items : [];

        const items = rawItems.map((item) => ({
          name: String(item?.name || "Meal item").trim() || "Meal item",
          calories: Math.max(0, normalizeCalories(item?.calories) || 0),
          protein: Math.max(0, Math.round(Number(item?.protein) || 0))
        }));

        const total_calories = items.reduce((s, it) => s + (Number(it.calories) || 0), 0);
        const total_protein = items.reduce((s, it) => s + (Number(it.protein) || 0), 0);

        return {
          label,
          items,
          total_calories,
          total_protein
        };
      });
    } catch {}

    /* ===============================
       ✅ TOTALS APPEND
    =============================== */
    try {
      const mealDetected = !!parsed?.signals?.meal?.detected;
      if (mealDetected && context && typeof context === "object") {
        const target = toNum(context.target);
        const flex = toNum(context.flex ?? 100);
        const eatenTodayBefore = toNum(context.eaten_today);
        const weekEatenBefore = toNum(context.week_eaten);

        const mealCals = toNum(parsed?.signals?.meal?.estimated_calories) ?? 0;

        if (Number.isFinite(target) && Number.isFinite(eatenTodayBefore) && Number.isFinite(weekEatenBefore)) {
          const eatenTodayAfter = Math.max(0, Math.round(eatenTodayBefore + mealCals));
          const leftTodayAfter = Math.round(target - eatenTodayAfter);

          const weekTarget = Math.round(target * 7);
          const weekEatenAfter = Math.max(0, Math.round(weekEatenBefore + mealCals));
          const weekLeftAfter = Math.round(weekTarget - weekEatenAfter);

          const flexTxt = Number.isFinite(flex) ? `±${Math.round(flex)}` : "";

          const totalsLine =
            `\n\nTotals: ${eatenTodayAfter} eaten • ${fmtDelta(leftTodayAfter)} today (target ${Math.round(target)}${flexTxt}). ` +
            `Week: ${weekEatenAfter} eaten • ${fmtDelta(weekLeftAfter)}.`;

          // parsed.reply = String(parsed.reply || "Okay.") + totalsLine;
        }
      }
    } catch {}

    /* ===============================
       GOOGLE SHEETS (NON-FATAL) + DEBUG
    =============================== */
    let sheets_debug = { ran: false };

    try {
      sheets_debug.ran = true;

      const SHEET_ID =
        process.env.GOOGLE_SHEET_ID ||
        process.env.SHEET_ID ||
        "";

      const SA_JSON_RAW =
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_SERVICE_ACCOUNT ||
        process.env.GCP_SERVICE_ACCOUNT_JSON ||
        "";

      const PRIVATE_KEY_RAW =
        process.env.GOOGLE_PRIVATE_KEY ||
        process.env.GCP_PRIVATE_KEY ||
        "";

      const EMAIL_ENV =
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
        process.env.GOOGLE_CLIENT_EMAIL ||
        process.env.GCP_CLIENT_EMAIL ||
        "";

      sheets_debug.hasSheetId = !!SHEET_ID;
      sheets_debug.hasServiceJson = !!SA_JSON_RAW;
      sheets_debug.hasPrivateKey = !!PRIVATE_KEY_RAW;
      sheets_debug.hasEmail = !!EMAIL_ENV;

      let clientEmail = "";
      let privateKey = "";

      if (SA_JSON_RAW) {
        const obj = JSON.parse(SA_JSON_RAW);
        clientEmail = String(obj.client_email || "");
        privateKey = String(obj.private_key || "");
      } else {
        clientEmail = EMAIL_ENV;
        privateKey = PRIVATE_KEY_RAW;
      }

      const hasCreds = !!clientEmail && !!privateKey;

      if (!SHEET_ID || !hasCreds) {
        sheets_debug.ok = false;
        sheets_debug.reason = "missing_env";
      } else {
        const PRIVATE_KEY = String(privateKey).replace(/\\n/g, "\n");

        const auth = new google.auth.JWT({
          email: clientEmail,
          key: PRIVATE_KEY,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });

        await auth.authorize();

        const sheets = google.sheets({ version: "v4", auth });

        const date = today();
        const timestamp = now();

        const SHEET_FIRST_NAME = FIRST_NAME;
        const SHEET_EMAIL = EMAIL;

        if (debug) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "MEAL_LOGS!A:H",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                `debug_${Date.now()}`,
                "DEBUG_WRITE",
                0,
                SHEET_FIRST_NAME,
                timestamp,
                SHEET_EMAIL
              ]]
            }
          });
          sheets_debug.debugRow = "wrote DEBUG_WRITE to MEAL_LOGS";
        }

        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "users!A:D",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[user_id, SHEET_FIRST_NAME, SHEET_EMAIL, timestamp]] }
        });

        if (parsed?.signals?.meal?.detected) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "MEAL_LOGS!A:H",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                `meal_${Date.now()}`,
                parsed.signals.meal.text || "",
                parsed.signals.meal.estimated_calories || "",
                SHEET_FIRST_NAME,
                timestamp,
                SHEET_EMAIL
              ]]
            }
          });
        }

        if (parsed?.signals?.weight?.detected) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "WEIGHT_LOGS!A:G",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                parsed.signals.weight.value,
                "v3",
                timestamp,
                SHEET_FIRST_NAME,
                SHEET_EMAIL
              ]]
            }
          });
        }

        if (
          parsed?.signals?.meal?.detected ||
          parsed?.signals?.weight?.detected ||
          isMoodMessage(message)
        ) {
          let weeklyAvgWeight = "";
          try {
            const wRes = await sheets.spreadsheets.values.get({
              spreadsheetId: SHEET_ID,
              range: "WEIGHT_LOGS!A:G"
            });

            const rows = wRes?.data?.values || [];
            const todayStr = date;
            const cutoff = new Date(todayStr);
            cutoff.setDate(cutoff.getDate() - 6);

            const vals = [];
            for (const r of rows) {
              const rDate = r?.[0];
              const rUser = r?.[1];
              const rWeight = r?.[2];

              if (!rDate || !rUser || !rWeight) continue;
              if (String(rUser) !== String(user_id)) continue;

              const dObj = new Date(rDate);
              if (isNaN(dObj.getTime())) continue;
              if (dObj < cutoff) continue;

              const wNum = parseFloat(rWeight);
              if (!Number.isFinite(wNum)) continue;

              vals.push(wNum);
            }

            if (vals.length) {
              weeklyAvgWeight = (vals.reduce((a,b)=>a+b,0) / vals.length).toFixed(1);
            }
          } catch {}

          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "DAILY_SUMMARIES!A:J",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                parsed?.signals?.weight?.value || "",
                weeklyAvgWeight,
                parsed?.reply || "",
                SHEET_FIRST_NAME,
                parsed?.signals?.meal?.estimated_calories || "",
                isMoodMessage(message) ? message : "",
                timestamp,
                SHEET_EMAIL
              ]]
            }
          });
        }

        sheets_debug.ok = true;
      }
    } catch (sheetErr) {
      sheets_debug.ok = false;
      sheets_debug.reason = "exception";
      sheets_debug.message = sheetErr?.message;
      sheets_debug.code = sheetErr?.code;
      sheets_debug.status = sheetErr?.response?.status;
      sheets_debug.data = sheetErr?.response?.data;
    }

    return res.status(200).json({
      reply: parsed.reply || "Okay.",
      signals: parsed.signals || {},
      structured: parsed.structured || {
        intent: "general",
        needs_confirmation: false,
        meals: []
      },
      ...(debug ? { sheets_debug } : {})
    });

  } catch (err) {
    return res.status(500).json({
      reply: "Something went wrong.",
      signals: {},
      structured: { intent: "general", needs_confirmation: false, meals: [] }
    });
  }
}
