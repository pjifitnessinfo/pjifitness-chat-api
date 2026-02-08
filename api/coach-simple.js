export const config = {
  api: { bodyParser: true }
};

import { google } from "googleapis";

/* ======================================
   CORS — MUST RUN FIRST
====================================== */
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

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
   SYSTEM PROMPT — UNCHANGED COACH
====================================== */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.

TONE & STYLE:
- Talk naturally like ChatGPT
- Friendly, human, reassuring
- No rigid formatting
- No robotic lists
- Coach, don’t lecture

CORE BEHAVIOR:
- If food is mentioned, estimate calories naturally
- If portions are unclear, give a reasonable single-number estimate
- Never ask permission to estimate
- Never avoid numbers when food is mentioned

WEIGHT RULES:
- Detect body weight only if phrased like:
  "I weigh", "I weighed in", "today’s weight", "scale said"
- Ignore food weights (oz, grams, cups)
- Briefly explain trends and water weight

LOGGING:
- NEVER say you logged anything
- NEVER mention databases or sheets

OUTPUT:
- Return ONLY valid JSON
`;

/* ======================================
   HELPERS
====================================== */
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/* ======================================
   HANDLER
====================================== */
export default async function handler(req, res) {
  applyCors(req, res);

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
       OPENAI CALL — STRICT JSON
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
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "coach_response",
              schema: {
                type: "object",
                required: ["reply", "signals"],
                properties: {
                  reply: { type: "string" },
                  signals: {
                    type: "object",
                    required: ["meal", "weight"],
                    properties: {
                      meal: {
                        type: "object",
                        required: ["detected", "text", "estimated_calories", "confidence"],
                        properties: {
                          detected: { type: "boolean" },
                          text: { type: "string" },
                          estimated_calories: { type: "number" },
                          confidence: { type: "number" }
                        }
                      },
                      weight: {
                        type: "object",
                        required: ["detected", "value", "confidence"],
                        properties: {
                          detected: { type: "boolean" },
                          value: { type: "number" },
                          confidence: { type: "number" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT.trim() },
            { role: "user", content: message }
          ]
        })
      }
    );

    const data = await openaiRes.json();
    const parsed = data?.choices?.[0]?.message?.content;

    if (!parsed) {
      return res.status(200).json({
        reply: "Try again.",
        signals: {}
      });
    }

    const { meal, weight } = parsed.signals || {};

    /* ============================
       SILENT GOOGLE SHEETS LOGGING
    ============================ */

    // MEAL LOG
    if (meal?.detected && meal.estimated_calories > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "MEAL_LOGS",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            today(),
            user_id,
            `meal_${Date.now()}`,
            meal.text || "",
            meal.estimated_calories,
            "",
            now()
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
            today(),
            user_id,
            weight.value,
            "v3",
            now()
          ]]
        }
      });
    }

    // DAILY SUMMARY (simple)
    if (meal?.detected || weight?.detected) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "DAILY_SUMMARIES",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            today(),
            user_id,
            weight?.value || "",
            "",
            meal?.estimated_calories || "",
            "",
            ""
          ]]
        }
      });
    }

    return res.status(200).json({
      reply: parsed.reply,
      signals: parsed.signals
    });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again.",
      signals: {}
    });
  }
}
