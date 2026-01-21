export const config = {
  api: { bodyParser: false }
};

// -----------------------------
// Helpers
// -----------------------------
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function normalizeText(s) {
  return String(s || "").trim();
}

function detectIntent(message) {
  const t = normalizeText(message);
  const low = t.toLowerCase();

  if (/^(hi|hey|hello|yo|sup|test)\b[\s\!\.\?]*$/i.test(t)) return "greeting";

  const correctionSignals =
    /\b(adjust|change|correct|fix|meant|actually|was lower|was higher|not that much|too high|too low)\b/i.test(low);

  const hasMealWords = /\b(breakfast|lunch|dinner|snack|meal)\b/i.test(low);
  const hasAteWords = /\b(i had|i ate|ate|have had|for breakfast|for lunch|for dinner)\b/i.test(low);
  const hasQtyUnits = /\b(\d+(\.\d+)?\s?(g|gram|grams|oz|ounce|ounces|lb|lbs|cups?|tbsp|tsp|ml|cal|kcal))\b/i.test(t);

  const hasFoodNouns =
    /\b(eggs?|toast|bread|rice|pasta|chicken|beef|burger|shake|protein bar|bar|pizza|salad|milk|almond milk|cheese|yogurt|fries|potato|oatmeal|banana|apple)\b/i.test(low);

  if (correctionSignals) return "meal_correction";

  const looksLikeFoodLog = hasMealWords || hasAteWords || hasQtyUnits || hasFoodNouns;
  if (looksLikeFoodLog) return "food_log";

  return "coaching_question";
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20);
}

function ensureClosingLine(text) {
  let s = String(text || "").trim();
  if (!s) return s;

  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (/^For now,\s*just\s*focus\s*on/i.test(ln)) {
      if (!/[.!?]$/.test(ln)) lines[i] = ln + ".";
      return lines.join("\n");
    }
  }

  return s + "\n\nFor now, just focus on your next meal choice and one small win today.";
}

// -----------------------------
// Prompts
// -----------------------------
const FOOD_LOG_PROMPT = `
You are PJ Coach, a practical fat-loss coach.

const FOOD_LOG_PROMPT = `
You are PJ Coach, a practical fat-loss coach.

IMPORTANT CONTEXT:
- You estimate calories conversationally
- You do NOT save or overwrite meals
- The meal log UI is the source of truth

RULES:
- Estimate calories when food is mentioned
- Keep a running daily total conversationally
- ALWAYS give 1–2 realistic lower-calorie swaps with estimated savings
- If the user wants to change or correct a logged meal:
  → Tell them to edit it in the meal log
  → Do NOT pretend totals were overwritten

FORMAT:
1) Acknowledge
2) Breakdown (if food)
3) Running total (range OK)
4) Coaching insight
5) 1–2 lower-cal swaps (with savings)
6) End with: "For now, just focus on ..."
`;

const COACHING_PROMPT = `
You are PJ Coach — calm, practical, supportive.

RULES:
- Don’t lecture
- Don’t shame
- Calories only if relevant
- One clear next step
- End with: "For now, just focus on ..."
`;

// -----------------------------
// Handler
// -----------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ reply: "Method not allowed." });

  try {
    let rawBody = "";
    await new Promise((resolve, reject) => {
      req.on("data", chunk => (rawBody += chunk.toString("utf8")));
      req.on("end", resolve);
      req.on("error", reject);
    });

    const body = safeJsonParse(rawBody) || {};
    const message = normalizeText(body.message || "");
    const history = sanitizeHistory(body.history);

    if (!message) {
      return res.status(400).json({ reply: "No message received." });
    }

    const intent = detectIntent(message);

    // Meal correction → redirect to UI
    if (intent === "meal_correction") {
      return res.status(200).json({
        reply: ensureClosingLine(
          "Good catch — since meals are saved in your log, the best move is to edit that meal directly there so your totals stay accurate.\n\nOnce that’s updated, I can help you think through swaps or the rest of the day."
        ),
        debug: { intent }
      });
    }

    // Greeting
    if (intent === "greeting") {
      return res.status(200).json({
        reply: ensureClosingLine(
          "All good — I’ll estimate calories from your food logs, keep a running total, and always suggest 1–2 realistic lower-cal swaps.\n\nTell me what you’ve eaten today or what’s been toughest lately."
        ),
        debug: { intent },
        set_onboarded: true
      });
    }

    const systemPrompt = intent === "food_log" ? FOOD_LOG_PROMPT : COACHING_PROMPT;

    const messages = [{ role: "system", content: systemPrompt.trim() }];
    messages.push(...history);
    messages.push({ role: "user", content: message });

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

    return res.status(200).json({ reply, debug: { intent }, set_onboarded: true });

  } catch (err) {
    console.error("[simple.js] fatal:", err);
    return res.status(500).json({ reply: "Something went wrong." });
  }
}
