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
   SYSTEM PROMPT (LOCKED)
================================ */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.

TONE & STYLE:
- Talk naturally like ChatGPT
- Friendly, human, reassuring
- No rigid formatting
- No robotic lists
- Explain things clearly if asked
- Coach, don’t lecture

CORE BEHAVIOR (IMPORTANT):
- If FOOD is mentioned → ALWAYS estimate calories conversationally
- If portions are unclear → give a reasonable range based on a typical portion
- Do NOT ask for permission to estimate
- Do NOT avoid numbers when food is mentioned
- If the user is asking about a meal they MIGHT eat, SHOULD eat, or CAN fit, still estimate calories conversationally
- If the user clearly says they already ate or had the food, treat it as an eaten meal
- If the user is planning, asking, comparing, or deciding, do NOT treat it as an eaten meal
- If food is vague, briefly explain what details would improve accuracy (ounces, cups, slices, oil, sauce), but still give a practical estimate

WEIGHT RULES:
- Detect body weight ONLY if phrased like:
  "I weigh", "I weighed in", "today’s weight", "scale said"
- Ignore food weights (oz, grams, cups)
- When weight is shared, explain trends and water weight briefly

LOGGING (SILENT):
- NEVER say “I logged this”
- NEVER mention tracking, databases, or sheets
- Signals are internal only

SIGNAL RULES (VERY IMPORTANT):
- signals.meal.detected = true ONLY if the user clearly reports eating or having food already
- signals.meal.detected = false if the user is planning, asking what they should eat, asking what fits, comparing options, or discussing a future meal
- signals.meal.estimated_calories may still contain a number even when signals.meal.detected = false
- signals.meal.text should contain the food text being discussed
- If the user says things like "I had", "I ate", "Breakfast:", "Lunch:", "Dinner:", or "Snack:" then that usually means signals.meal.detected = true
- If the user says things like "can I have", "should I have", "how much should I have", "I'm planning on having", "thinking of having", or asks a question about dinner/lunch/snack, then signals.meal.detected = false

OUTPUT FORMAT (MANDATORY):
Return ONLY valid JSON:
{
  "reply": string,
  "signals": {
    "meal": { "detected": boolean, "text": string, "estimated_calories": number, "confidence": number },
    "weight": { "detected": boolean, "value": number, "confidence": number },
    "mood": { "detected": boolean, "text": string, "confidence": number }
  }
}
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

  if (!Number.isFinite(target) || !Number.isFinite(eatenToday) || !Number.isFinite(weekEaten)) return "";

  const weekTarget = target * 7;
  const leftToday = target - eatenToday;
  const leftWeek = weekTarget - weekEaten;

  const flexTxt = Number.isFinite(flex) ? `±${Math.round(flex)}` : "";

  return (
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

/* ✅ NEW: normalize calories into a real integer */
function normalizeCalories(val) {
  // already a number-ish
  if (Number.isFinite(Number(val))) return Math.round(Number(val));

  // strings like "500-700", "500 to 700", "~600", "about 650"
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
    return res.status(405).json({ reply: "Method not allowed.", signals: {} });
  }

  try {
    const { user_id, message, history = [], debug = false, context = null, first_name = "", email = "" } = req.body || {};
const FIRST_NAME = String(first_name || "").trim();
const EMAIL      = String(email || "").trim();

    if (!user_id || !message) {
      return res.status(400).json({ reply: "Invalid request.", signals: {} });
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
        ...(debug ? { sheets_debug: { ran: false, ok: false, reason: "model_returned_non_json" } } : {})
      });
    }

    /* ===============================
       ✅ HARDEN SIGNALS (MINIMAL)
       - ensure objects exist
       - normalize meal calories
       - if calories exist, force meal.detected=true
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

// keep detected as a real boolean, but do NOT force true just because calories exist
parsed.signals.meal.detected = !!parsed.signals.meal.detected;

      if (parsed?.signals?.weight?.detected) {
        const w = toNum(parsed?.signals?.weight?.value);
        if (Number.isFinite(w) && w > 0) parsed.signals.weight.value = w;
      }
    } catch {
      // never fail the request if signal hardening errors
    }

    /* ===============================
       ✅ TOTALS APPEND
       - Now works whenever meal calories exist (since detected is forced true)
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

          parsed.reply = String(parsed.reply || "Okay.") + totalsLine;
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

    // ✅ identity from request (safe even if blank)
    // IMPORTANT: do NOT redeclare FIRST_NAME / EMAIL (already declared above)
    const SHEET_FIRST_NAME = FIRST_NAME; // from req.body destructure section
    const SHEET_EMAIL = EMAIL;           // from req.body destructure section

    // DEBUG row (now includes name/email columns)
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

    // users tab: user_id | first_name | email | timestamp
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "users!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[user_id, SHEET_FIRST_NAME, SHEET_EMAIL, timestamp]] }
    });

    // MEAL_LOGS: date | user_id | entry_id | meal_text | calories | first_name | timestamp | email
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

    // WEIGHT_LOGS: date | user_id | weight | source | timestamp | first_name | email
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

    // DAILY_SUMMARIES writes when meal/weight/mood relevant
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

      // DAILY_SUMMARIES A:J
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
  ...(debug ? { sheets_debug } : {})
});

} catch (err) {
  return res.status(500).json({
    reply: "Something went wrong.",
    signals: {}
  });
}
}
