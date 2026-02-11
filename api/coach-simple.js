export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ===============================
   CORS — MUST RUN FIRST
================================ */
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
- If portions are unclear → give a reasonable range
- Do NOT ask for permission to estimate
- Do NOT avoid numbers when food is mentioned

WEIGHT RULES:
- Detect body weight ONLY if phrased like:
  "I weigh", "I weighed in", "today’s weight", "scale said"
- Ignore food weights (oz, grams, cups)
- When weight is shared, explain trends and water weight briefly

LOGGING (SILENT):
- NEVER say “I logged this”
- NEVER mention tracking, databases, or sheets
- Signals are internal only

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
  return /i feel|i’m feeling|im feeling|today feels|feeling/i.test(text);
}

/* ===============================
   HANDLER
================================ */
export default async function handler(req, res) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed.", signals: {} });
  }

  try {
    const { user_id, message, history = [] } = req.body || {};
    const debug = !!(req.body && req.body.debug);
let sheets_debug = { ran: false };


    if (!user_id || !message) {
      return res.status(400).json({ reply: "Invalid request.", signals: {} });
    }

    /* ===============================
       OPENAI CALL (UNCHANGED)
    ================================ */
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
      return res.status(200).json({ reply: content || "Okay.", signals: {} });
    }

            /* ===============================
       GOOGLE SHEETS (NON-FATAL)
    ================================ */
    const debug = !!(req.body && req.body.debug);
    let sheets_debug = { ran: false };

    try {
      sheets_debug.ran = true;

      const PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY;
      const EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const SHEET_ID = process.env.GOOGLE_SHEET_ID;

      sheets_debug.hasPrivateKey = !!PRIVATE_KEY_RAW;
      sheets_debug.hasEmail = !!EMAIL;
      sheets_debug.hasSheetId = !!SHEET_ID;

      // 🔍 Prevent silent failure (your old code would just do nothing)
      if (!PRIVATE_KEY_RAW || !EMAIL || !SHEET_ID) {
        sheets_debug.ok = false;
        sheets_debug.reason = "missing_env";

        console.error("[Sheets] Missing env vars:", {
          hasPrivateKey: !!PRIVATE_KEY_RAW,
          hasEmail: !!EMAIL,
          hasSheetId: !!SHEET_ID
        });
      } else {
        const PRIVATE_KEY = PRIVATE_KEY_RAW.replace(/\\n/g, "\n");

        const auth = new google.auth.JWT({
          email: EMAIL,
          key: PRIVATE_KEY,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });

        // ✅ Forces auth errors to show up clearly
        await auth.authorize();

        const sheets = google.sheets({ version: "v4", auth });

        const date = today();
        const timestamp = now();

        // ✅ If debug=true, write an obvious marker row so you can SEE it
        if (debug) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "MEAL_LOGS!A:G",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                `debug_${Date.now()}`,
                "DEBUG_WRITE",
                0,
                "",
                timestamp
              ]]
            }
          });
          sheets_debug.debugRow = "wrote DEBUG_WRITE to MEAL_LOGS";
        }

        /* ---------- USERS ---------- */
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "users!A:D",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[user_id, "", "", timestamp]]
          }
        });

        /* ---------- MEAL_LOGS ---------- */
        if (parsed?.signals?.meal?.detected) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "MEAL_LOGS!A:G",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                `meal_${Date.now()}`,
                parsed.signals.meal.text || "",
                parsed.signals.meal.estimated_calories || "",
                "",
                timestamp
              ]]
            }
          });
        }

        /* ---------- WEIGHT_LOGS ---------- */
        if (parsed?.signals?.weight?.detected) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "WEIGHT_LOGS!A:E",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                parsed.signals.weight.value,
                "v3",
                timestamp
              ]]
            }
          });
        }

        /* ---------- DAILY_SUMMARIES ---------- */
        if (
          parsed?.signals?.meal?.detected ||
          parsed?.signals?.weight?.detected ||
          isMoodMessage(message)
        ) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "DAILY_SUMMARIES!A:G",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                parsed?.signals?.weight?.value || "",
                "",
                parsed?.signals?.meal?.estimated_calories || "",
                isMoodMessage(message) ? message : "",
                timestamp
              ]]
            }
          });
        }

        sheets_debug.ok = true;
        console.log("[Sheets] ✅ Logged OK", { user_id, date });
      }
    } catch (sheetErr) {
      sheets_debug.ok = false;
      sheets_debug.reason = "exception";
      sheets_debug.message = sheetErr?.message;
      sheets_debug.code = sheetErr?.code;
      sheets_debug.status = sheetErr?.response?.status;
      sheets_debug.data = sheetErr?.response?.data;

      console.error("[Sheets] ❌ Logging failed:", {
        message: sheetErr?.message,
        code: sheetErr?.code,
        status: sheetErr?.response?.status,
        data: sheetErr?.response?.data
      });
    }

    return res.status(200).json({
      reply: parsed.reply || "Okay.",
      signals: parsed.signals || {},
      ...(debug ? { sheets_debug } : {})
    });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong.",
      signals: {}
    });
  }
}
