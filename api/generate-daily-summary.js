import OpenAI from "openai";
import { google } from "googleapis";

export const config = {
  api: { bodyParser: true }
};

// =============================
// ENV
// =============================
const SHEET_ID = process.env.SHEET_ID;
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============================
// CORS
// =============================
function applyCors(req, res) {
  const origin = req.headers.origin || "";

  const ALLOWED = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
  ]);

  res.setHeader("Vary", "Origin");

  if (ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders || "Content-Type, Authorization"
  );
}

// =============================
// HELPERS
// =============================
function todayYMD(clientDate) {
  if (typeof clientDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(clientDate)) {
    return clientDate;
  }
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

// =============================
// PROMPT
// =============================
function buildPrompt(ctx) {
  return `
You are a calm, experienced fat-loss coach.

USER CONTEXT:
- Today weight: ${ctx.today_weight ?? "not logged"}
- Weekly average: ${ctx.weekly_avg ?? "n/a"}
- Total calories today: ${ctx.total_calories ?? "unknown"}

MEALS TODAY:
${ctx.meals.length
  ? ctx.meals.map(m => `- ${m.meal_text}`).join("\n")
  : "No meals logged yet."}

TASK:
Write a short daily coaching summary (2–4 sentences).

RULES:
- Do NOT shame
- Do NOT panic over scale spikes
- If weight is up suddenly, explain water weight calmly
- If calories seem high or low, gently guide
- End with one simple focus for tomorrow

OPTIONAL:
If something needs coach attention, include a short flag like:
"FLAG: check in on consistency"

Return plain text only.
`.trim();
}

// =============================
// HANDLER
// =============================
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { user_id, clientDate } = req.body;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    const date = todayYMD(clientDate);
    const sheets = await getSheets();

    // =============================
    // 1) GET USER CONTEXT
    // =============================
    const contextRes = await fetch(
      "https://pjifitness-chat-api.vercel.app/api/get-user-context",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, clientDate: date })
      }
    );

    const ctx = await contextRes.json();
    if (!ctx.ok) {
      return res.status(500).json({ ok: false, error: "Failed to load context" });
    }

    // =============================
    // 2) CALL OPENAI
    // =============================
    const prompt = buildPrompt(ctx);

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      messages: [{ role: "system", content: prompt }]
    });

    const ai_text =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Keep things simple today and focus on consistency.";

    const flagMatch = ai_text.match(/^FLAG:\s*(.*)$/m);
    const coach_flag = flagMatch ? flagMatch[1] : "";

    // =============================
    // 3) SAVE DAILY SUMMARY
    // =============================
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
            weight: ctx.today_weight,
            weekly_avg: ctx.weekly_avg,
            total_calories: ctx.total_calories,
            ai_summary: ai_text.replace(/^FLAG:.*$/m, "").trim(),
            coach_flag
          }
        })
      }
    );

    // =============================
    // RESPONSE
    // =============================
    return res.json({
      ok: true,
      date,
      ai_summary: ai_text,
      coach_flag
    });

  } catch (err) {
    console.error("[generate-daily-summary]", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err.message
    });
  }
}
