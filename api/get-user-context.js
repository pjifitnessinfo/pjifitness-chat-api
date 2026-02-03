import OpenAI from "openai";
import { google } from "googleapis";

export const config = {
  api: { bodyParser: true }
};

const SHEET_ID = process.env.SHEET_ID;
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TAB_WEIGHT = "WEIGHT_LOGS";
const TAB_MEAL = "MEAL_LOGS";

// -----------------------------
// CORS
// -----------------------------
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

// -----------------------------
// Helpers
// -----------------------------
function todayYMD(clientDate) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(clientDate || "")) return clientDate;
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

async function getSheets() {
  const auth = new google.auth.JWT(
    SERVICE_ACCOUNT.client_email,
    null,
    SERVICE_ACCOUNT.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

// -----------------------------
// Prompt
// -----------------------------
function buildPrompt(ctx) {
  return `
You are a calm, experienced fat-loss coach.

Today weight: ${ctx.today_weight}
Weekly average: ${ctx.weekly_avg}
Total calories today: ${ctx.total_calories}

Meals:
${ctx.meals.length ? ctx.meals.map(m => `- ${m.meal_text}`).join("\n") : "No meals logged."}

Write a short coaching summary (2–4 sentences).
- No shaming
- Explain water weight if scale jumps
- End with one simple focus for tomorrow

If coach review is needed, include:
FLAG: <reason>
`.trim();
}

// -----------------------------
// Handler
// -----------------------------
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { user_id, clientDate, action } = req.body;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    const date = todayYMD(clientDate);
    const sheets = await getSheets();

    // -----------------------------
    // READ WEIGHTS
    // -----------------------------
    const weightsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TAB_WEIGHT}!A2:C`
    });

    const weightRows = weightsRes.data.values || [];
    const userWeights = weightRows
      .filter(r => r[1] === user_id)
      .slice(-7)
      .map(r => Number(r[2]))
      .filter(Boolean);

    const todayRow = weightRows.find(
      r => r[0] === date && r[1] === user_id
    );

    const today_weight = todayRow ? Number(todayRow[2]) : null;
    const weekly_avg =
      userWeights.length
        ? Math.round(
            (userWeights.reduce((a, b) => a + b, 0) / userWeights.length) * 10
          ) / 10
        : null;

    // -----------------------------
    // READ MEALS
    // -----------------------------
    const mealsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TAB_MEAL}!A:G`
    });

    const mealRows = mealsRes.data.values || [];
    const meals = mealRows
      .filter(r => r[0] === date && r[1] === user_id)
      .map(r => ({
        meal_text: r[3],
        ai_estimate: r[4]
      }));

    const total_calories = meals.reduce((sum, m) => {
      const match = (m.ai_estimate || "").match(/(\d+)[–-](\d+)/);
      if (!match) return sum;
      return sum + (Number(match[1]) + Number(match[2])) / 2;
    }, 0);

    const context = {
      ok: true,
      user_id,
      date,
      today_weight,
      weekly_avg,
      total_calories: Math.round(total_calories),
      meals
    };

    // -----------------------------
    // GENERATE SUMMARY (optional)
    // -----------------------------
    if (action === "generate_summary") {
      const prompt = buildPrompt(context);

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0.4,
        messages: [{ role: "system", content: prompt }]
      });

      const text = completion.choices[0].message.content.trim();
      const flagMatch = text.match(/^FLAG:\s*(.*)$/m);

      // save summary
      await fetch(
        "https://pjifitness-chat-api.vercel.app/api/save-daily-log",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "summary",
            user_id,
            clientDate: date,
            data: {
              weight: today_weight,
              weekly_avg,
              total_calories: context.total_calories,
              ai_summary: text.replace(/^FLAG:.*$/m, "").trim(),
              coach_flag: flagMatch ? flagMatch[1] : ""
            }
          })
        }
      );

      return res.json({
        ...context,
        ai_summary: text,
        coach_flag: flagMatch ? flagMatch[1] : ""
      });
    }

    // default: just context
    return res.json(context);

  } catch (err) {
    console.error("[get-user-context]", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err.message
    });
  }
}
