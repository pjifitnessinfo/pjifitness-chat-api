// api/coach-simple.js

export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ===============================
   CORS — MUST RUN FIRST
   (Fixes Shopify/Vercel preflight issues)
================================ */
function applyCors(req, res) {
  const allowed = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
  ]);

  const origin = req.headers.origin;

  // Only allow your site(s)
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // Prevent caching the wrong origin response
  res.setHeader("Vary", "Origin");

  // Methods you support
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  // Echo requested headers so preflight passes even if browser adds more
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
  return /i feel|i’m feeling|im feeling|today feels|feeling/i.test(text || "");
}

/* ===============================
   HANDLER
================================ */
export default async function handler(req, res) {
  // ✅ CORS headers must be set for BOTH OPTIONS + POST
  applyCors(req, res);

  // ✅ Preflight (browser OPTIONS) must return the CORS headers
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed.", signals: {} });
  }

  try {
    const { user_id, message, history = [], debug = false } = req.body || {};

    if (!user_id || !message) {
      return res.status(400).json({ reply: "Invalid request.", signals: {} });
    }

    /* ===============================
       OPENAI CALL
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
      // If the model ever returns non-JSON, still respond gracefully
      return res.status(200).json({
        reply: content || "Okay.",
        signals: {},
        ...(debug ? { sheets_debug: { ran: false, ok: false, reason: "model_returned_non_json" } } : {})
      });
    }

    /* ===============================
       GOOGLE SHEETS (NON-FATAL) + DEBUG
       ✅ FIXED to use your Vercel env vars:
       - GOOGLE_SERVICE_ACCOUNT_JSON
       - SHEET_ID
    ================================ */
    let sheets_debug = { ran: false };

    try {
      sheets_debug.ran = true;

      const CREDS_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const SHEET_ID = process.env.SHEET_ID;

      let EMAIL = null;
      let PRIVATE_KEY_RAW = null;

      if (CREDS_JSON) {
        const creds = JSON.parse(CREDS_JSON);
        EMAIL = creds?.client_email || null;
        PRIVATE_KEY_RAW = creds?.private_key || null;
      }

      sheets_debug.hasEmail = !!EMAIL;
      sheets_debug.hasPrivateKey = !!PRIVATE_KEY_RAW;
      sheets_debug.hasSheetId = !!SHEET_ID;

      // Prevent silent "skip"
      if (!PRIVATE_KEY_RAW || !EMAIL || !SHEET_ID) {
        sheets_debug.ok = false;
        sheets_debug.reason = "missing_env";

        console.error("[Sheets] Missing env vars:", {
          hasServiceAccountJson: !!CREDS_JSON,
          hasEmail: !!EMAIL,
          hasPrivateKey: !!PRIVATE_KEY_RAW,
          hasSheetId: !!SHEET_ID
        });
      } else {
        // In case key comes through with escaped newlines
        const PRIVATE_KEY = String(PRIVATE_KEY_RAW).replace(/\\n/g, "\n");

        const auth = new google.auth.JWT({
          email: EMAIL,
          key: PRIVATE_KEY,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });

        // Forces auth errors to surface here
        await auth.authorize();

        const sheets = google.sheets({ version: "v4", auth });

        const date = today();
        const timestamp = now();

        // If debug requested, write a very obvious marker row
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
          requestBody: { values: [[user_id, "", "", timestamp]] }
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
          // Compute 7-day avg weight from WEIGHT_LOGS for this user (non-fatal)
          let weeklyAvgWeight = "";
          try {
            const wRes = await sheets.spreadsheets.values.get({
              spreadsheetId: SHEET_ID,
              range: "WEIGHT_LOGS!A:E"
            });

            const rows = wRes?.data?.values || [];
            const todayStr = date; // YYYY-MM-DD
            const cutoff = new Date(todayStr);
            cutoff.setDate(cutoff.getDate() - 6); // last 7 days incl today

            const vals = [];
            for (const r of rows) {
              const rDate = r?.[0];      // A = date
              const rUser = r?.[1];      // B = user_id
              const rWeight = r?.[2];    // C = weight

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
          } catch (e) {
            // ignore avg failure
          }

          // ✅ Map columns A:I
          // A date
          // B user_id
          // C weight (today)
          // D weekly_avg_weight
          // E ai_summary
          // F ai_swaps
          // G meal_estimated_calories
          // H mood_text
          // I timestamp

          await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: "DAILY_SUMMARIES!A:I",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                date,
                user_id,
                parsed?.signals?.weight?.value || "",
                weeklyAvgWeight,
                parsed?.reply || "",
                "", // ai_swaps placeholder
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
