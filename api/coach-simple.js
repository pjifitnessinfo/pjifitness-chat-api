export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ===============================
   CORS — ABSOLUTE FIRST
================================ */
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ===============================
   GOOGLE SHEETS CLIENT (SAFE)
================================ */
function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.SHEET_ID) {
    return null;
  }

  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  return google.sheets({ version: "v4", auth });
}

/* ===============================
   SYSTEM PROMPT (UNCHANGED)
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
    "meal": {
      "detected": boolean,
      "text": string,
      "estimated_calories": number,
      "confidence": number
    },
    "weight": {
      "detected": boolean,
      "value": number,
      "confidence": number
    }
  }
}
`;

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

  /* ===============================
     FORCE SHEET TEST (CONSOLE)
  ================================ */
  if (req.body?.__force_sheet_test === true) {
    try {
      const sheets = getSheetsClient();
      if (!sheets) throw new Error("Sheets not configured");

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: "MEAL_LOGS",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            new Date().toISOString().slice(0, 10),
            "FORCE_TEST",
            "console test row",
            999,
            new Date().toISOString()
          ]]
        }
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error("FORCE TEST FAILED:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  try {
    const { user_id, message, history = [] } = req.body || {};

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

    if (!content) {
      return res.status(200).json({ reply: "Try again.", signals: {} });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(200).json({ reply: content, signals: {} });
    }

    /* ===============================
       GOOGLE SHEETS (NON-FATAL)
    ================================ */
    try {
      const sheets = getSheetsClient();
      if (sheets) {
        const today = new Date().toISOString().slice(0, 10);
        const now = new Date().toISOString();

        if (parsed?.signals?.meal?.detected) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SHEET_ID,
            range: "MEAL_LOGS",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                today,
                user_id,
                parsed.signals.meal.text || "",
                parsed.signals.meal.estimated_calories || "",
                now
              ]]
            }
          });
        }

        if (parsed?.signals?.weight?.detected) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SHEET_ID,
            range: "WEIGHT_LOGS",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: [[
                today,
                user_id,
                parsed.signals.weight.value,
                now
              ]]
            }
          });
        }
      }
    } catch (sheetErr) {
      console.error("Sheets logging failed (non-fatal):", sheetErr);
    }

    return res.status(200).json({
      reply: parsed.reply,
      signals: parsed.signals
    });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong.",
      signals: {}
    });
  }
}
