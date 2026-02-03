export const config = {
  api: { bodyParser: false }
};

// =============================
// Helpers
// =============================
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function normalizeText(s) {
  return String(s || "").trim();
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    )
    .slice(-20);
}

function ensureClosingLine(text) {
  let s = String(text || "").trim();
  if (!s) return s;

  if (/For now,\s*just\s*focus\s*on/i.test(s)) return s;
  return s + "\n\nFor now, just focus on your next meal choice and one small win today.";
}

// =============================
// Intent Detection
// =============================
function detectIntent(message) {
  const t = normalizeText(message);
  const low = t.toLowerCase();

  if (/^(hi|hey|hello|yo|sup|test)\b[\s!.?]*$/i.test(t)) return "greeting";

  if (
    /\b(adjust|change|correct|fix|meant|actually|too high|too low|was higher|was lower)\b/i.test(low)
  ) {
    return "meal_correction";
  }

  const looksLikeFood =
    /\b(i ate|i had|ate|for breakfast|for lunch|for dinner)\b/i.test(low) ||
    /\b(eggs?|toast|rice|pasta|chicken|beef|burger|shake|protein bar|pizza|salad|milk|cheese|yogurt|fries|potato|oatmeal|banana|apple)\b/i.test(low) ||
    /\b(\d+(\.\d+)?\s?(g|oz|lb|cups?|tbsp|tsp|ml|cal))\b/i.test(t);

  if (looksLikeFood) return "food_log";

  if (/^\d+(\.\d+)?$/.test(t)) return "weight_log";

  return "coaching_question";
}

// =============================
// Google Sheets Save Helper
// =============================
async function saveDailyLog(payload) {
  try {
    await fetch("https://pjifitness-chat-api.vercel.app/api/save-daily-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("[coach-simple] saveDailyLog failed:", err);
  }
}

// =============================
// Prompts (V1)
// =============================
const FOOD_LOG_PROMPT = `
You are PJ Coach, a practical fat-loss coach.

RULES:
- Estimate calories conversationally
- Itemize foods with calorie ranges
- Always include ONE combined total using EXACT format below

ABSOLUTE REQUIREMENT (DO NOT CHANGE):
Total for this meal: 625-630 calories

- Use a RANGE with a dash
- Do not use "~"
- Do not rename the line
- Include this once per meal

COACHING:
- Give 1–2 realistic lower-cal swaps
- End with "For now, just focus on ..."
`;

const COACHING_PROMPT = `
You are PJ Coach — calm, practical, supportive.

RULES:
- Don’t lecture or shame
- Calories only if relevant
- One clear next step
- End with "For now, just focus on ..."
`;

// =============================
// Handler
// =============================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed." });
  }

  try {
    // -------- Read raw body --------
    let rawBody = "";
    await new Promise((resolve, reject) => {
      req.on("data", chunk => (rawBody += chunk.toString("utf8")));
      req.on("end", resolve);
      req.on("error", reject);
    });

    const body = safeJsonParse(rawBody) || {};
    const message = normalizeText(body.message || "");
    const history = sanitizeHistory(body.history);
    const isV3 = body.v3 === true;
    const userId = body.user_id || "guest";

    if (!message) {
      return res.status(400).json({ reply: "No message received." });
    }

    const intent = detectIntent(message);

    // =============================
    // V3 MODE — CHAT + AUTO SAVE
    // =============================
    if (isV3) {

      // 🔹 Save logs BEFORE replying
      if (intent === "food_log") {
        await saveDailyLog({
          type: "meal",
          user_id: userId,
          data: {
            meal_text: message
          }
        });
      }

      if (intent === "weight_log") {
        await saveDailyLog({
          type: "weight",
          user_id: userId,
          data: {
            weight: parseFloat(message)
          }
        });
      }

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content:
                "You are a calm, supportive fitness coach. Respond conversationally. Do not calculate calories unless asked."
            },
            { role: "user", content: message }
          ]
        })
      });

      const data = await openaiRes.json();
      const reply = data?.choices?.[0]?.message?.content || "Try again.";

      return res.status(200).json({ reply, debug: { intent } });
    }

    // =============================
    // V1 MODE — LEGACY COACH
    // =============================
    if (intent === "meal_correction") {
      return res.status(200).json({
        reply: ensureClosingLine(
          "Good catch — since meals are saved in your log, the best move is to edit that meal directly so your totals stay accurate."
        ),
        debug: { intent }
      });
    }

    if (intent === "greeting") {
      return res.status(200).json({
        reply: ensureClosingLine(
          "All good — tell me what you’ve eaten today or what’s been toughest lately."
        ),
        debug: { intent }
      });
    }

    const systemPrompt =
      intent === "food_log" ? FOOD_LOG_PROMPT : COACHING_PROMPT;

    const messages = [
      { role: "system", content: systemPrompt.trim() },
      ...history,
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
        temperature: 0.6,
        messages
      })
    });

    const data = await openaiRes.json();
    const rawReply = data?.choices?.[0]?.message?.content || "Try again.";
    const reply = ensureClosingLine(rawReply);

    return res.status(200).json({ reply, debug: { intent } });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({ reply: "Something went wrong." });
  }
}
