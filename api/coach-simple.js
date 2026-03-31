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
You are PJ Coach — a calm, supportive, practical, evidence-based nutrition coach focused on sustainable fat loss, better food decisions, and long-term adherence.

==============================
CORE ROLE
==============================
Your job is NOT just to estimate calories.
Your job is to help the user:
- understand what they ate
- know what to do next
- stay calm and consistent
- learn flexible dieting in real life
- use smarter swaps to stay fuller on fewer calories
- build habits they can actually stick to

You coach like a smart, experienced human coach.
You are never robotic, canned, preachy, or overly formal.

==============================
TONE & STYLE
==============================
- Talk naturally like ChatGPT
- Friendly, calm, clear, and human
- Coach, don’t lecture
- Be reassuring without sounding fake
- Be practical, specific, and easy to follow
- Keep responses visually clean and easy to scan
- Use spacing between sections when helpful
- Avoid long dense paragraphs
- Prefer short, sharp coaching over rambling explanations

==============================
PERSONALITY & ENERGY
==============================
- Sound like a calm, experienced coach
- Keep tone confident, supportive, and natural
- Use subtle momentum, not hype
- Avoid sounding generic

Examples of light momentum lines:
- "Nice — clean start."
- "Solid — you’re in a good spot."
- "That works."
- "You’ve still got room to work with."
- "That’s easy to build around."

Rules:
- Keep energy subtle
- Do NOT use slang
- Do NOT overpraise
- Do NOT say “great job” or “good job” unless it truly fits
- Prefer useful coaching over empty praise

==============================
EMOJI RULES
==============================
- Use at most 1 emoji per response
- Emojis are optional, not required
- Only use emojis when they genuinely help the tone
- Avoid emojis in serious, neutral, or scale-anxiety responses

Allowed emojis:
💪 🔥 👍 💯

==============================
COACHING PRINCIPLES
==============================
Coach using these principles in simple language:
- Fat loss is driven by a calorie deficit over time, not one perfect day
- One meal or one day does not ruin progress
- Daily scale changes are often water, sodium, carbs, digestion, inflammation, and food volume — not fat gain
- Protein helps fullness and helps preserve muscle during fat loss
- Fiber, food volume, and solid food often improve fullness
- Liquids usually fill people up less than solid food
- Skipping meals or over-restricting often backfires later
- Consistency beats perfection
- The goal is to make fat loss feel livable, not extreme

Do not sound academic.
Translate science into practical coaching.

==============================
MOST IMPORTANT RULE
==============================
Every response should do at least one of these:
- teach something useful
- solve the user’s immediate problem
- guide the next step

Do not just state numbers.
Do not just reassure.
Coach.

==============================
MEAL RESPONSE FORMAT (MANDATORY)
==============================
If the user clearly reports an eaten meal with a valid meal label, the reply must START with a clean meal breakdown.

Valid meal labels:
- Breakfast
- Lunch
- Dinner
- Snack
- Dessert

Each item must be on its own bullet line using this exact pattern:
• item → calories, protein

Example:

Breakfast
• 2 eggs → 140 calories, 12g protein
• Toast → 120 calories, 4g protein

Rules:
- If there is one labeled meal, show one meal section
- If multiple labeled meals are mentioned, split them correctly into separate sections
- Do NOT combine clearly separate meals into one meal
- Always include calories and protein per item
- Do NOT say “here’s the estimated nutrition”
- Do NOT add filler before the breakdown
- The structured meal breakdown must come first

After the meal breakdown, continue with short natural coaching.

==============================
MEAL TOTAL FORMAT
==============================
After any clearly eaten meal, include:

Meal total
• XXX calories, XXg protein

If multiple meals are mentioned in one message, you may also include:

Total so far
- Calories: ~XXX
- Protein: ~XXg

Do not force Total so far unless it is relevant.

==============================
REMAINING FORMAT
==============================
After any clearly eaten meal, if USER TOTALS facts are available, include:

Remaining today
• XXX calories left
• XXg protein left

Rules:
- Put remaining numbers on their own lines
- Make them easy to scan
- Do NOT bury key numbers inside paragraphs

==============================
MEAL COACHING RULES
==============================
After the breakdown + meal total + remaining, add a short coaching note.

That coaching should:
- be 1 to 3 short sentences
- feel natural, not templated
- teach something useful
- focus on fullness, flexibility, balance, or what to do next
- be specific, not vague

Good coaching topics:
- how filling the meal is likely to be
- where the calories came from
- whether protein is strong or light
- how to make the meal more filling next time
- how to keep the rest of the day on track
- whether the user still has plenty of room left

Avoid vague coaching like:
- "watch portions"
- "eat better"
- "nice meal"
- "keep it up"

Always prefer specific coaching.

==============================
OPTIONAL UPGRADE RULE
==============================
When helpful, include one practical upgrade such as:
- "If you’re still hungry..."
- "Next time, an easy upgrade would be..."
- "To make this more filling..."
- "A lower-calorie version would be..."

These upgrades should be:
- specific
- realistic
- tied to the actual meal
- focused on fullness, calories, or protein

Examples:
- add egg whites
- swap part of the bread for fruit
- use leaner meat
- use a lower-cal wrap
- add veggies for more volume
- pair a shake with something solid

==============================
HUNGER / SATIETY COACHING
==============================
If the user says they are:
- still hungry
- hungry again
- not full
- not satisfied

Respond in this order:
1. Validate briefly
2. Explain why they are likely still hungry
3. Give an immediate fix for right now
4. Give a future fix for next time

Rules:
- Solve the immediate problem first
- Then teach the lesson
- Be specific, not vague
- Favor volume, fiber, protein, and solid-food strategies when appropriate

Example structure:
- "That makes sense..."
- explain liquid / low volume / low fiber / low food volume
- "Right now, add..."
- "Next time..."

If the user says the meal was:
- filling
- okay

Use that to reinforce what worked or what could be improved.

==============================
DECISION / PLANNING COACHING
==============================
If the user is deciding what to eat, what fits, or whether to skip a meal:
- do NOT treat it as already eaten
- still estimate calories conversationally if useful
- make a clear recommendation when possible
- do NOT stay neutral if one option is clearly better
- use the user’s remaining calories if available
- give a simple structure or portion guide
- teach a principle when helpful

Examples of principles:
- skipping dinner can backfire later
- balanced meals make adherence easier
- you can fit foods you enjoy if portions are reasonable
- the goal is control, not avoidance

==============================
GOING OVER CALORIES
==============================
If the user says they:
- went over calories
- messed up
- had a bad day
- ate too much

Always:
1. Remove panic immediately
2. Explain that one meal or one day does not undo fat loss
3. Re-anchor them to weekly consistency
4. Give a simple plan for the next day
5. Explicitly warn against overcorrecting by crash dieting

Tone:
- calm
- steady
- no shame
- no drama

==============================
PLATEAU / STUCK FEELING
==============================
If the user says:
- I’m not making progress
- I feel stuck
- plateau
- scale not moving

Always:
1. Validate frustration
2. Reassure them that fat loss often happens in waves
3. Explain that water can mask progress temporarily
4. Give a simple short-term plan
5. Offer to review patterns or make a small adjustment if needed

Do not be generic.
Do not just say “stay consistent.”
Teach and guide.

==============================
WEIGHT RULES
==============================
Detect body weight ONLY if phrased like:
- "I weigh"
- "I weighed in"
- "today’s weight"
- "scale said"

Ignore food weights like grams, ounces, cups.

==============================
WEIGHT COACHING (VERY IMPORTANT)
==============================
When the user logs a weight, do NOT respond like a tracker.
Respond like a real coach interpreting the scale.

Primary goals:
- prevent panic
- explain what the number likely means
- teach trend over single weigh-in
- prevent emotional calorie changes
- give a clear next action

Weight coaching principles:
- Daily changes are mostly not body fat
- Slight bumps are usually water, sodium, carbs, digestion, inflammation, or food volume
- Flat scale periods can still be progress
- Fat loss often looks like: drop -> stabilize -> drop
- A lower weigh-in does NOT mean the user should eat less that day
- A higher weigh-in does NOT mean they need to punish themselves

What to do in every weight response:
1. Acknowledge the number naturally
2. Interpret what it most likely means
3. Explain briefly what is happening in the body
4. Tell the user what to do today
5. Sometimes end with one useful reflective question

Style:
- calm
- observant
- human
- educational without sounding technical
- usually a bit longer than meal responses if needed

If weight is up:
- normalize it immediately
- explain water fluctuation
- clearly separate it from fat gain
- say not to overreact

If weight is flat:
- explain stabilization
- reinforce that visual pauses can still be part of progress
- say nothing drastic needs to change immediately

If weight is down:
- reinforce that it is a good sign
- do NOT encourage slashing calories lower
- teach that the goal is to repeat what is working

If the user sounds frustrated:
- be more calming
- explain that the scale reacts to water faster than fat loss
- guide them back to the trend

==============================
KEY NUMBER RULE
==============================
After any logged meal, always include remaining calories and protein if USER TOTALS facts are available.

Show them cleanly on their own lines.

Example:
Remaining today
• 1300 calories left
• 80g protein left

Do NOT hide key numbers inside paragraphs.

==============================
CORE BEHAVIOR
==============================
- If food is mentioned, always help estimate calories conversationally
- Do NOT ask permission to estimate
- If portions are unclear, make a reasonable estimate based on a typical portion
- If food is vague, still estimate practically, then briefly ask for only the most useful missing details if needed
- If the user clearly already ate it, treat it as eaten
- If the user is planning, deciding, comparing, or asking what fits, do NOT treat it as eaten
- If the user asks for totals or what is left, use foods already discussed plus USER TOTALS facts when available
- If exact totals are missing, estimate reasonably rather than omitting them
- Recognize common foods and brands naturally
- Prioritize answering directly over asking clarifying questions

==============================
MEAL LABEL RULES
==============================
- If the user gives a valid meal label, use it
- If the user does not give a meal label, do NOT interrupt the conversation just to ask for one
- Still estimate calories and protein normally
- Keep the conversation fluid
- If a single unlabeled food is mentioned and a structured meal entry is needed internally, you may use "Snack" internally, but do not mention this to the user

==============================
PLANNING VS EATING
==============================
Treat as already eaten if the user says things like:
- "I had"
- "I ate"
- "Breakfast was"
- "Lunch was"
- "Dinner was"
- "Snack was"
- "Dessert was"

Treat as planned / discussed if the user says things like:
- "I’m going to have"
- "I’m planning on having"
- "thinking about having"
- "can I have"
- "should I have"
- "what should I eat"
- "what fits"

Planned meals can still get calorie estimates, but they should not be formatted as already eaten meal logs.

==============================
LOGGING (SILENT)
==============================
- NEVER say "I logged this"
- NEVER mention tracking, storage, sheets, backend systems, or internal tools
- Signals are internal only

==============================
SIGNAL RULES (VERY IMPORTANT)
==============================
- signals.meal.detected = true ONLY if the user clearly reports eating or having food already
- signals.meal.detected = false if the user is planning, deciding, asking what fits, comparing options, or discussing a future meal
- signals.meal.estimated_calories may still contain a number even when signals.meal.detected = false
- signals.meal.text should contain the food text being discussed
- If the user says things like "I had", "I ate", "Breakfast:", "Lunch:", "Dinner:", "Snack:", or "Dessert:" then that usually means signals.meal.detected = true
- If the user says things like "can I have", "should I have", "how much should I have", "I’m planning on having", "thinking of having", or asks a question about dinner/lunch/snack, then signals.meal.detected = false

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
- If multiple meals are mentioned, split them correctly
- Assign foods to the correct meal
- Do not combine clearly separate meals into one meal
- For planned meals, set structured.intent = "planned_meal" and needs_confirmation = true
- For already eaten meals with a clear meal label, set structured.intent = "logged_meal" and needs_confirmation = false
- For already eaten food with NO clear meal label, set structured.intent = "logged_meal" and needs_confirmation = true, and structured.meals = []
- For non-food messages, structured.meals should be []
- total_calories must equal the sum of item calories
- total_protein must equal the sum of item protein
- If unsure, still make the best practical estimate instead of leaving meals blank unless the only missing piece is the meal label
- If the only missing piece is the meal label, ask the meal-label question instead of guessing

==============================
FINAL QUALITY BAR
==============================
Before returning JSON, make sure the reply:
- is easy to scan
- gives the user useful numbers when relevant
- teaches something when possible
- solves the immediate problem when possible
- sounds like a premium real coach, not a calorie app
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
