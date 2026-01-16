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

  const startsQuestion =
    /^(why|how|what|does|do|can|should|is|are|am i|i am|im)\b/i.test(t) && t.includes("?");

  const struggleSignals =
    /\b(struggling|discouraged|frustrated|confused|stuck|binge|cravings|can't stop|cant stop|overeat|overeating|hate my body|no motivation|give up|i feel)\b/i.test(low);

  const hasMealWords = /\b(breakfast|lunch|dinner|snack|meal)\b/i.test(low);
  const hasAteWords = /\b(i had|i ate|ate|have had|for breakfast|for lunch|for dinner)\b/i.test(low);
  const hasQtyUnits = /\b(\d+(\.\d+)?\s?(g|gram|grams|oz|ounce|ounces|lb|lbs|pound|cups?|tbsp|tsp|ml|mL|cal|kcal))\b/i.test(t);

  const hasFoodNouns =
    /\b(eggs?|toast|bread|rice|pasta|chicken|beef|burger|shake|protein bar|bar|pizza|salad|milk|almond milk|oreo|cheese|yogurt|fries|potato|oatmeal|banana|apple)\b/i.test(low);

  const looksLikeFoodLog = hasMealWords || hasAteWords || hasQtyUnits || hasFoodNouns;

  if (looksLikeFoodLog) return "food_log";
  if (startsQuestion || struggleSignals) return "coaching_question";
  return "coaching_question";
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20);
}

// Ensures replies always end with a complete "For now..." line
function ensureClosingLine(text) {
  let s = String(text || "").trim();
  if (!s) return s;

  s = s.replace(
    /(For now,\s*just\s*focus\s*on)(\.\.\.)?\s*$/i,
    "For now, just focus on your next meal choice and one small win today."
  );

  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (/^For now,\s*just\s*focus\s*on/i.test(ln)) {
      if (!/[.!?]$/.test(ln)) lines[i] = ln + ".";
      s = lines.join("\n");
      return s;
    }
  }

  s += "\n\nFor now, just focus on your next meal choice and one small win today.";
  return s;
}

// -----------------------------
// Prompts
// -----------------------------
const FOOD_LOG_PROMPT = `
You are PJ Coach, a highly effective, human-feeling fat-loss coach.

Your job is to:
- interpret messy food logs
- keep a running mental tally of calories for the day unless told otherwise
- proactively help without being asked

CRITICAL BEHAVIOR:
- If the user mentions food, ALWAYS estimate calories automatically
- Keep a running total for the day unless told otherwise
- If the user asks "total so far" — ROLL IT UP
- Use ranges, not fake precision
- Never ask them to repeat foods already mentioned

THE APP'S CORE VALUE (LOCK THIS IN):
- After every food log, ALWAYS include 1–2 LOWER-CALORIE swap ideas.
- Each swap MUST include an estimated calorie savings like: "(saves ~50–120 calories)".
- A “swap” MUST reduce calories. If it doesn’t reduce calories, label it as an "upgrade" (optional), not a swap.
- Swaps should be realistic (same vibe/meal), not weird diet food.
- If the meal is already lean, say: "No swap needed" AND give ONE tiny upgrade for fullness (more protein/volume).

ACCURACY NOTE (ONLY WHEN RELEVANT)
- If the user seems stuck/plateaued, close to goal, or unsure about portions, suggest checking serving sizes and using a food scale for a short “audit week” to tighten accuracy.
- Keep it practical and non-judgmental (1–2 sentences).

STRICT LIMITS:
- Do not lecture
- Do not sound clinical
- Calories are allowed
- Macros ONLY if user asks

RESPONSE FORMAT:
1) One short acknowledgement (1 sentence max)
2) Breakdown (bullets) if food exists
3) Running total (range OK)
4) Coaching insight (leverage point)
5) Swap ideas (ALWAYS 1–2 lower-cal swaps WITH savings; or "No swap needed")
6) End with a final line that starts with: "For now, just focus on" and completes the thought.
`;

const COACHING_PROMPT = `
You are PJ Coach — a practical, human, real-world health & fat-loss coach.
You help people with fat loss, nutrition habits, cravings, binge patterns, consistency, motivation, routines, and mindset around food.

CORE STYLE
- Sound like a smart friend + coach: calm, direct, non-judgmental.
- Be practical and grounded.
- Don’t lecture. Don’t overwhelm. Don’t ramble.

IMPORTANT (NON-NEGOTIABLE)
- NEVER say: "Since you didn't list foods..." or "I can't estimate calories..." unless they explicitly asked you to calculate a total.
- Never scold them for not logging perfectly.
- Don’t mention calories unless they asked or it’s essential to answer the question.

HOW TO ANSWER (ALWAYS)
1) Acknowledge what they’re feeling or asking (1–2 sentences).
2) Give the clearest explanation in plain English (short).
3) Give ONE concrete next step they can do today (very specific).
4) Optionally ask ONE high-signal question if it would change the advice.
5) End with a final line that starts with: "For now, just focus on" and completes the thought.

HIGH-SIGNAL FOLLOW-UP QUESTIONS (CHOOSE ONLY ONE WHEN NEEDED)
- Consistency: "Are you consistent 6–7 days/week, or do weekends look different?"
- Hidden calories: "Any snacks/drinks/sauces you don’t usually count?"
- Activity: "Have your daily steps dropped lately?"
- Timeline: "How long has the scale been stuck — days, ~2 weeks, or a month+?"
- Cravings: "When do cravings hit hardest — afternoon, night, or stress moments?"
- Hunger: "On a typical day, what time do you first get really hungry?"

PLATEAU / ACCURACY (USE WHEN RELEVANT)
- If they’re plateaued or progress is slow near goal weight, explain that accuracy matters more, and a short “audit week” helps:
  checking serving sizes/labels + weighing key foods with a food scale for 5–7 days.
- Keep it non-judgmental and framed as a short experiment, not forever.

BOUNDARIES (LIGHT, NOT ROBOTIC)
- Do NOT diagnose medical conditions.
- If symptoms/medical issues come up, suggest they talk to a clinician, while still offering safe general guidance.
- Avoid extreme or unsafe dieting advice.
`;

// -----------------------------
// Handler
// -----------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");

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
    const message = normalizeText(body.message || body.input || body.text || "");
    const history = sanitizeHistory(body.history);

    if (!message) {
      return res.status(400).json({ reply: "No message received.", debug: { intent: "unknown" } });
    }

    const intent = detectIntent(message);

    // Greeting handled locally
    if (intent === "greeting") {
      return res.status(200).json({
        reply: ensureClosingLine(
          "All good — quick heads up: I’ll estimate calories from your logs, keep a running total, and always give you 1–2 realistic lower-cal swaps that still feel like your normal food.\n\nTell me what you’ve eaten today, or tell me what’s been hardest lately."
        ),
        debug: { intent },
        set_onboarded: true
      });
    }

    const systemPrompt = intent === "food_log" ? FOOD_LOG_PROMPT : COACHING_PROMPT;

    const onboarded = !!body.onboarded;
    const isFirstTurn = history.length === 0 && !onboarded;

    const messages = [{ role: "system", content: systemPrompt.trim() }];

    if (isFirstTurn) {
      messages.push({
        role: "system",
        content:
          "FIRST_TURN: In your first response, include ONE short sentence explaining: you estimate calories from messy logs, keep a running total, and give 1–2 realistic lower-cal swaps to help long-term weight management. Then continue normally."
      });
    }

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

    if (!openaiRes.ok) {
      const t = await openaiRes.text();
      console.error("[coach-simple] OpenAI error:", t);
      return res.status(500).json({ reply: "Something went wrong. Try again.", debug: { intent } });
    }

    const data = await openaiRes.json();
    const rawReply = data?.choices?.[0]?.message?.content || "I didn't catch that — try again.";
    const reply = ensureClosingLine(rawReply);

    return res.status(200).json({ reply, debug: { intent }, set_onboarded: true });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({ reply: "Something went wrong. Try again." });
  }
}
