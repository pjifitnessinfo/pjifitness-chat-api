export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ===============================
   CORS — ABSOLUTE FIRST THING
================================ */
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ===============================
   SYSTEM PROMPT (UNCHANGED)
================================ */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.
Talk naturally. If food is mentioned, estimate calories.
If weight is shared, explain trends.
Return ONLY valid JSON.
`;

/* ===============================
   HANDLER
================================ */
export default async function handler(req, res) {
  // ✅ CORS ALWAYS — EVEN IF WE CRASH LATER
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed.", signals: {} });
  }

  try {
    const { user_id, message } = req.body || {};
    if (!user_id || !message) {
      return res.status(400).json({ reply: "Invalid request.", signals: {} });
    }

    /* ===============================
       OPENAI
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
       GOOGLE SHEETS (SAFE)
    ================================ */
    try {
      const auth = new google.auth.JWT(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        null,
        process.env.GOOGLE_PRIVATE_KEY
          ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
          : null,
        ["https://www.googleapis.com/auth/spreadsheets"]
      );

      const sheets = google.sheets({ version: "v4", auth });
      const SHEET_ID = process.env.GOOGLE_SHEET_ID;

      const today = new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();

      if (parsed?.signals?.meal?.detected) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "MEAL_LOGS",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[today, user_id, parsed.signals.meal.text, parsed.signals.meal.estimated_calories, now]]
          }
        });
      }

      if (parsed?.signals?.weight?.detected) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: "WEIGHT_LOGS",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[today, user_id, parsed.signals.weight.value, now]]
          }
        });
      }
    } catch (sheetErr) {
      console.error("Sheets logging failed (non-fatal):", sheetErr);
      // ⬅️ DO NOT FAIL THE REQUEST
    }

    return res.status(200).json({
      reply: parsed.reply,
      signals: parsed.signals
    });

  } catch (err) {
    console.error("coach-simple fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong.",
      signals: {}
    });
  }
}
