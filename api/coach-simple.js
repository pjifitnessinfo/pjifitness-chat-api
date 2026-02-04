export const config = {
  api: { bodyParser: true }
};

/* ======================================
   SYSTEM PROMPT (NATURAL COACH)
====================================== */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.

STYLE:
- Talk naturally like ChatGPT
- Be conversational and human
- No rigid formatting
- No lecturing or shaming
- Explain clearly if asked
- Reassure when the user sounds stressed

COACHING:
- Help the user make sense of their day
- If food is mentioned, reason casually about calories
- If weight is mentioned, explain trends and water weight
- Guide what to do next without being strict

IMPORTANT:
- Never say you logged anything
- Never mention databases, tracking, or spreadsheets
- Never ask for confirmation to save data
`;

/* ======================================
   SIMPLE SIGNAL DETECTION (SERVER-SIDE)
====================================== */
function detectMeal(text) {
  const foodWords = /(chicken|beef|rice|pizza|pasta|eggs|shake|protein|salad|burger|fish|taco|bowl|sandwich)/i;
  if (!foodWords.test(text)) return null;

  // crude calorie heuristic (good enough v1)
  let calories = 500;
  if (/pizza/i.test(text)) calories = 600;
  if (/bowl/i.test(text)) calories = 550;
  if (/protein|shake/i.test(text)) calories = 300;

  return {
    detected: true,
    text,
    estimated_calories: calories,
    confidence: 0.8
  };
}

function detectWeight(text) {
  // only detect BODY weight with explicit language
  const match = text.match(
    /(i weigh|i weighed|today'?s weight|scale said|weighed in at)\s*(\d+(\.\d+)?)/i
  );
  if (!match) return null;

  return {
    detected: true,
    value: parseFloat(match[2]),
    confidence: 0.95
  };
}

/* ======================================
   MOCK DATA HELPERS (REPLACE W/ SHEETS)
====================================== */
let DAILY_LOG = {};
let WEIGHT_LOG = [];

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
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
    return res.status(405).json({ reply: "Method not allowed." });
  }

  try {
    const { message, history = [] } = req.body;
    if (!message) {
      return res.status(400).json({ reply: "No message received." });
    }

    /* ---------------------------
       1. Call OpenAI (NATURAL)
    ---------------------------- */
    const messages = [
      { role: "system", content: SYSTEM_PROMPT.trim() },
      ...history.slice(-10),
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
        temperature: 0.45,
        messages
      })
    });

    const data = await openaiRes.json();
    const reply =
      data?.choices?.[0]?.message?.content ||
      "I didn’t catch that — try again.";

    /* ---------------------------
       2. Detect signals (silent)
    ---------------------------- */
    const meal = detectMeal(message);
    const weight = detectWeight(message);

    const today = getToday();

    if (meal?.detected) {
      DAILY_LOG[today] = DAILY_LOG[today] || [];
      DAILY_LOG[today].push(meal.estimated_calories);
    }

    if (weight?.detected) {
      WEIGHT_LOG.push({ date: today, value: weight.value });
    }

    /* ---------------------------
       3. Compute summaries
    ---------------------------- */
    const todayCalories = sum(DAILY_LOG[today] || []);

    const last7Days = Object.keys(DAILY_LOG)
      .slice(-7)
      .map(d => sum(DAILY_LOG[d]));

    const weeklyCaloriesAvg =
      last7Days.length ? Math.round(sum(last7Days) / last7Days.length) : null;

    const last7Weights = WEIGHT_LOG.slice(-7).map(w => w.value);
    const weeklyWeightAvg =
      last7Weights.length
        ? Math.round(
            (sum(last7Weights) / last7Weights.length) * 10
          ) / 10
        : null;

    /* ---------------------------
       4. Respond
    ---------------------------- */
    return res.status(200).json({
      reply,
      signals: {
        meal: meal || { detected: false },
        weight: weight || { detected: false }
      },
      summary: {
        today_calories: todayCalories || null,
        weekly_calories_avg: weeklyCaloriesAvg,
        weekly_weight_avg: weeklyWeightAvg
      }
    });

  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again in a moment.",
      signals: {}
    });
  }
}
