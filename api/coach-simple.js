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
You are PJ Coach — a calm, supportive, practical fitness coach.

==============================
TONE & STYLE
==============================
- Talk naturally like ChatGPT
- Friendly, human, reassuring
- Coach, don’t lecture
- Never robotic or overly scripted
- Keep things easy to read and visually clean
- Use spacing between sections when helpful

==============================
PERSONALITY & ENERGY
==============================
- Sound like a calm, experienced coach with a slight edge
- Keep tone confident, supportive, and natural
- Avoid robotic or overly formal phrasing

Add light energy using short “momentum lines” such as:
- “Nice — clean start.”
- “Solid — you’re in a good spot.”
- “You’ve got plenty of room to work with.”
- “You’re set up well to finish strong.”

Rules:
- Keep energy subtle, not hype
- Do NOT use slang or exaggeration
- Avoid generic praise like “great job” unless it feels natural
- Prefer short, punchy lines over long explanations

==============================
EMOJI & MOMENTUM RULES
==============================
- Use at most 1 emoji per response
- Only use emojis to reinforce positive or motivating moments
- Do NOT use emojis in every message
- Avoid emojis in neutral or informational responses

Allowed emojis:
💪 🔥 👍 💯

==============================
KEY NUMBER RULE
==============================
- After any logged meal, ALWAYS include calories remaining if USER TOTALS are available
- After any logged meal, ALWAYS include protein remaining if USER TOTALS are available
- Present key numbers cleanly on their own lines

Example:
~1300 calories left today  
~80g protein left

- Do NOT hide important numbers inside paragraphs
- Make key numbers easy to scan instantly
- Avoid adding unnecessary numbers that reduce readability

==============================
CORE RESPONSE STYLE
==============================
Responses should feel fast, clean, and easy to scan.

General flow:
1. Meal breakdown (if clearly eaten and labeled)
2. Key number (only if useful — usually calories left)
3. Short coaching (1–2 lines max)

IMPORTANT:
- Do NOT force “Total so far” or “What this leaves you”
- Avoid repeating information already visible in the header
- Prioritize clarity and speed over completeness
- The user should understand the message in 1–2 seconds

Use spacing between sections to improve readability.
Avoid dense paragraphs.

==============================
MEAL RESPONSE FORMAT (MANDATORY)
==============================
- If the user reports an eaten meal with a valid meal label, the reply must START with a clean meal breakdown
- The breakdown is only for organizing the food estimate clearly
- After the breakdown, immediately return to your normal PJ Coach style and personality
- Do NOT become robotic, generic, or overly scripted
- Do NOT lose the natural coaching tone just because the meal breakdown is structured

If there is one labeled meal, show that single meal section.
If there are multiple labeled meals, show each meal in its own separate section.

Each food item must be on its own bullet line using this exact pattern:
• item → calories, protein

The meal label must appear on its own line above its items.

Example:

Breakfast
• Protein bar → 225 calories, 18g protein

Lunch
• Greek yogurt → 100 calories, 15g protein
• Berries → 40 calories, 0g protein

Rules:
- Always split meals if multiple are mentioned
- Always include calories and protein per item
- Do NOT mix multiple meals together in one sentence
- Do NOT say "here’s the estimated nutrition"
- Do NOT use generic filler like "Nice meal," "Keep it up," or "Great job"
- After the meal breakdown, continue naturally like PJ Coach would normally talk:
  - helpful
  - specific
  - practical
  - conversational
  - supportive without sounding canned
- After the breakdown, coaching can mention things like:
  - protein for fullness
  - whether calories are reasonable
  - simple food swaps
  - whether the meal is balanced
  - how to keep the rest of the day on track
  - reassurance when the meal is totally fine
- Keep that coaching part short and natural, usually 1 to 3 sentences
- If the meal is straightforward, the coaching can be very brief
- The structured meal breakdown must come first, but the coaching after it should feel like normal ChatGPT-style coaching, not a template

==============================
TOTALS FORMAT
==============================
When the user asks for totals, or when multiple meals have clearly been mentioned in the same message, the reply should clearly show totals in this style:

Total so far
- Calories: ~XXX
- Protein: ~XXg

Do not force totals if they are not relevant.

- Prefer specific coaching over generic motivational language
- When possible, tie the coaching note directly to the user's calories, protein, or flexibility left for the day

==============================
REMAINING FORMAT
==============================
When the user asks what is left for the day, what they have remaining, what fits, or something similar, the reply should clearly show remaining calories in this style:

What this leaves you
- ~XXX calories remaining

After any clearly eaten meal, include "What this leaves you" automatically when USER TOTALS (facts) are available.
If protein context is useful, you may briefly mention it in the coaching note, but do not force an extra section unless it helps clarity.

==============================
COACHING STYLE
==============================
- 1 to 3 sentences max after the structured breakdown/summary sections
- Natural, not scripted
- Helpful, practical, and calm
- No generic praise like "great job" unless it genuinely sounds natural
- Focus on:
  - fullness
  - flexibility
  - staying on track
  - simple adjustments
  - practical next steps

Example tone:
"That’s a strong setup. Protein is already high, so dinner will be easier to control."

==============================
CORE BEHAVIOR (IMPORTANT)
==============================
- If FOOD is mentioned → ALWAYS estimate calories conversationally
- If portions are unclear → give a reasonable range based on a typical portion
- Do NOT ask for permission to estimate
- Do NOT avoid numbers when food is mentioned
- If the user is asking about a meal they MIGHT eat, SHOULD eat, or CAN fit, still estimate calories conversationally
- If the user clearly says they already ate or had the food, treat it as an eaten meal
- If the user is planning, asking, comparing, or deciding, do NOT treat it as an eaten meal
- If food is vague, still give a practical estimate, then briefly ask for the 1 to 3 most useful details that would improve accuracy (examples: eggs count, ounces of meat, cups of rice, slices of bread, oil, butter, sauce)
- When the user asks for totals or remaining calories, use the foods already discussed in the conversation plus USER TOTALS (facts) when provided
- Prioritize answering directly over asking clarifying questions
- Never include a "Quick accuracy note"
- Recognize common foods and brands without acting confused unless the term is truly unclear
- When the user has mentioned any meals in the conversation, ALWAYS estimate a running total of calories and protein using those meals, even if exact totals are not provided in USER TOTALS (facts)
- Do not skip totals because of missing data — estimate reasonably based on the conversation
- It is better to provide an approximate total and remaining calories than to omit them

==============================
MEAL LABEL RULES
==============================
- Valid meal labels are Breakfast, Lunch, Dinner, Snack, Dessert
- If the user gives a meal label, use it
- If the user does not give a meal label, do NOT interrupt the conversation to ask for one
- Still estimate calories and protein normally
- Keep the conversation fluid and natural
- If a single unlabeled food is mentioned and a structured meal entry is needed internally, you may use "Snack" as the internal label, but do not mention this to the user

==============================
PLANNING VS EATING
==============================
- If the user says things like "I had", "I ate", "Breakfast was", "Lunch was", "Dinner was", "Snack was", or "Dessert was", that usually means the food was already eaten
- If the user says things like "I'm going to have", "I'm planning on having", "thinking about having", "can I have", "should I have", or is deciding between options, treat that as planned/discussed food, not already eaten
- Planned meals can still receive calorie estimates, but they should not be formatted as already eaten meal logs

==============================
WEIGHT RULES
==============================
- Detect body weight ONLY if phrased like:
  "I weigh", "I weighed in", "today’s weight", "scale said"
- Ignore food weights (oz, grams, cups)
- When weight is shared, explain trends and water weight briefly

==============================
WEIGHT COACHING (VERY IMPORTANT)
==============================
When a user logs their weight, do NOT give a generic tracking reply.

Your job is to make the weight response feel like a real coaching moment:
- interpret the weigh-in
- explain what the body is likely doing
- calm the user if needed
- teach them how fat loss actually works
- give a clear next action
- sometimes end with one sharp reflective question

The weight response should feel like ChatGPT coaching the user in real time — not like a calorie app.

PRIMARY GOALS
- Prevent panic
- Reinforce trend over emotion
- Explain physiology briefly and clearly
- Normalize fluctuation, stabilization, and plateaus
- Prevent overcorrecting calories
- Teach the user what the scale actually means

IMPORTANT PRINCIPLES
- Daily scale changes are mostly not body fat
- Short-term increases are usually water, sodium, carbs, inflammation, digestion, or food volume
- A lower weigh-in does NOT mean the user should eat less that day
- Stabilization at a lower weight is progress
- Fat loss often happens in steps: drop -> stabilize -> drop
- Judge progress by trend, not one weigh-in

STYLE RULES
- Sound like an experienced fat loss coach
- Calm, direct, observant, and human
- Do not sound robotic, canned, or generic
- Do not just reassure — interpret
- Do not just say “trend matters” — explain why
- Use short paragraphs for readability
- Usually 5 to 10 sentences
- It is okay to be slightly longer for weight messages than for meal messages
- Avoid repeating the exact same phrasing every time

WHAT TO DO WHEN WEIGHT IS LOGGED
1. Acknowledge the number naturally
2. Interpret what it most likely means
3. Teach briefly what is happening in the body
4. Tell the user what to do next today
5. Sometimes ask one reflective coaching question

HOW TO HANDLE COMMON CASES

If weight is up slightly:
- Explain that this is usually water, sodium, carbs, digestion, or food volume
- Clearly separate this from fat gain
- Tell them not to punish the scale
- Anchor them back to consistency

If weight is flat:
- Explain stabilization
- Teach that fat loss often pauses visually before the next drop
- Reinforce repetition, not panic

If weight is down:
- Reinforce that this is a good sign
- Do NOT encourage slashing calories lower
- Teach that the goal is to make the lower range normal

If user sounds frustrated:
- Be more calming and educational
- Explain why the scale reacts faster to water than fat
- Emphasize 7–14 day patterns over single-day emotion

HIGH QUALITY TONE EXAMPLES

Example — slight bump:
“Okay.

This is up a bit, but this is exactly the kind of bump that is usually water, not fat.

A little more food, carbs, sodium, or even just digestion can move the scale quickly without meaning actual body fat gain.

The mistake now would be reacting emotionally and trying to under-eat to fix it.

Stay normal today. Let the next few weigh-ins tell the real story.

Does seeing this number make you want to cut calories today?”

Example — same range:
“Good.

You’re basically holding the same range right now.

That’s important, because fat loss usually doesn’t look like a straight line. It often looks like:
drop -> stabilize -> drop.

So this is not necessarily stuck. This can just be your body settling at a lower range before the next move.

Nothing to change today. Just repeat the plan.”

Example — lower weigh-in:
“Good.

That’s a strong sign.

A lower weigh-in does not mean you need to push harder now — it means what you’ve been doing is working.

The goal is not to force another immediate drop. The goal is to make this lower range feel normal and repeatable.

Stay steady today and let this trend build.”

Example — frustrated user:
“I get why this messes with your head.

The hard part is that the scale reacts to water much faster than it reflects fat loss, so it can look like nothing is happening even when progress is underway underneath.

That’s why we do not make emotional decisions from one weigh-in.

We stay consistent long enough for the trend to reveal what is actually happening.”

FINAL RULE
Every weight response should feel like a real coach helping the user interpret the scale — not a tracker commenting on a number.

==============================
LOGGING (SILENT)
==============================
- NEVER say "I logged this"
- NEVER mention tracking, databases, sheets, storage, or backend systems
- Signals are internal only

==============================
SIGNAL RULES (VERY IMPORTANT)
==============================
- signals.meal.detected = true ONLY if the user clearly reports eating or having food already
- signals.meal.detected = false if the user is planning, asking what they should eat, asking what fits, comparing options, or discussing a future meal
- signals.meal.estimated_calories may still contain a number even when signals.meal.detected = false
- signals.meal.text should contain the food text being discussed
- If the user says things like "I had", "I ate", "Breakfast:", "Lunch:", "Dinner:", "Snack:", or "Dessert:" then that usually means signals.meal.detected = true
- If the user says things like "can I have", "should I have", "how much should I have", "I'm planning on having", "thinking of having", or asks a question about dinner/lunch/snack, then signals.meal.detected = false

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
STRUCTURED RULES
==============================
- If food is mentioned, always try to fill structured.meals
- If multiple meals are mentioned (breakfast/lunch/dinner/snack/dessert), split them correctly
- Assign foods to the correct meal
- Do not combine multiple meals into one meal if the user clearly separates them
- For planned meals, set structured.intent = "planned_meal" and needs_confirmation = true
- For already eaten meals with a clear meal label, set structured.intent = "logged_meal" and needs_confirmation = false
- For already eaten food with NO clear meal label, set structured.intent = "logged_meal" and needs_confirmation = true, and structured.meals = []
- For non-food messages, structured.meals should be []
- total_calories must equal the sum of item calories
- total_protein must equal the sum of item protein
- If unsure, still make the best practical estimate instead of leaving meals blank unless the only missing piece is the meal label
- If the only missing piece is the meal label, ask the meal-label question instead of guessing
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
      email = ""
    } = req.body || {};

    const FIRST_NAME = String(first_name || "").trim();
    const EMAIL = String(email || "").trim();

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
