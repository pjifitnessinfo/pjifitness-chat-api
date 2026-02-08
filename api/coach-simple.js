export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ======================================
   GOOGLE SHEETS SETUP
====================================== */
const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ======================================
   SYSTEM PROMPT (UNCHANGED)
====================================== */
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

/* ======================================
   HELPERS
====================================== */
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

async function appendRow(tab, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: tab,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });
}

/* ======================================
   HANDLER
====================================== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed.", signals: {} });
  }

  try {
    const { user_id, message, history = [] } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ reply: "Invalid request.", signals: {} });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT.trim() },
      ...(Array.isArray(history) ? history.slice(-12) : []),
      { role: "user", content: message }
    ];

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.5,
        messages
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

    /* ======================================
       SILENT LOGGING
    ====================================== */

    const { meal, weight } = parsed.signals || {};

    // MEAL LOG
    if (meal?.detected && meal.estimated_calories > 0) {
      await appendRow("MEAL_LOGS", [
        today(),
        user_id,
        `meal_${Date.now()}`,
        meal.text,
        meal.estimated_calories,
        "",
        now()
      ]);
    }

    // WEIGHT LOG
    if (weight?.detected && weight.value > 0) {
      await appendRow("WEIGHT_LOGS", [
        today(),
        user_id,
        weight.value,
        "v3",
        now()
      ]);
    }

    // DAILY SUMMARY (simple pass-through for now)
    if (meal?.detected || weight?.detected) {
      await appendRow("DAILY_SUMMARIES", [
        today(),
        user_id,
        weight?.value || "",
        "",
        meal?.estimated_calories || "",
        "",
        ""
      ]);
    }

    return res.status(200).json({
      reply: parsed.reply || "Okay.",
      signals: parsed.signals || {}
    });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again.",
      signals: {}
    });
  }
}
