export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ======================================
   CORS — MUST RUN FIRST
====================================== */
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ======================================
   GOOGLE SHEETS (SAFE INIT)
====================================== */
let sheets = null;
let SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID;

try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && SHEET_ID) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );

    sheets = google.sheets({ version: "v4", auth });
  }
} catch (err) {
  console.error("❌ Google Sheets init failed:", err);
}

/* ======================================
   SYSTEM PROMPT (UNCHANGED)
====================================== */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.

- Talk naturally like ChatGPT
- If food is mentioned, estimate calories
- If weight is shared, explain trends
- Never mention logging
- Return ONLY valid JSON
`;

/* ======================================
   HANDLER
====================================== */
export default async function handler(req, res) {
  // ✅ CORS ALWAYS FIRST
  applyCors(res);

  // ✅ PRE-FLIGHT
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      reply: "Method not allowed.",
      signals: {}
    });
  }

  try {
    const { user_id, message } = req.body || {};

    if (!user_id || !message) {
      return res.status(400).json({
        reply: "Invalid request.",
        signals: {}
      });
    }

    /* ============================
       OPENAI CALL
    ============================ */
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
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
            { role: "user", content: message }
          ]
        })
      }
    );

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(200).json({
        reply: content || "Okay.",
        signals: {}
      });
    }

    const { meal, weight } = parsed.signals || {};
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    /* ============================
       SILENT SHEETS LOGGING
    ============================ */
    if (sheets) {
      // MEAL LOG
      if (meal?.detected && meal.estimated_calories > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "MEAL_LOGS",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[
              today,
              user_id,
              `meal_${Date.now()}`,
              meal.text || "",
              meal.estimated_calories,
              "",
              now
            ]]
          }
        });
      }

      // WEIGHT LOG
      if (weight?.detected && weight.value > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "WEIGHT_LOGS",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[
              today,
              user_id,
              weight.value,
              "v3",
              now
            ]]
          }
        });
      }
    }

    return res.status(200).json({
      reply: parsed.reply || "Okay.",
      signals: parsed.signals || {}
    });

  } catch (err) {
    console.error("🔥 coach-simple fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong.",
      signals: {}
    });
  }
}
