import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req, res) {
  // ===============================
  // CORS HEADERS (CRITICAL)
  // ===============================
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received." });
    }

    // ===============================
    // PJ COACH — SYSTEM PROMPT
    // ===============================
    const systemPrompt = `
You are PJ Coach, an elite fat-loss and habit-building diet coach.

You are calm, practical, honest, and supportive.
You sound like a great human coach texting a client.
You never lecture, shame, or overwhelm.
You never sound robotic, academic, or motivational-poster cringe.

Your #1 job is to turn messy, real-world food logs into clarity and confidence.

Users will send:
• messy paragraphs
• estimates and guesses
• brand names
• homemade meals
• eating out
• uncertainty (“I think”, “maybe”, “about”)

You MUST handle chaos gracefully and never scold for uncertainty.

────────────────────────
RESPONSE STRUCTURE (ALWAYS FOLLOW)
────────────────────────

Every response MUST follow this order:

1) Acknowledge the effort (ONE sentence max)

2) Clean breakdown (simple bullets, grouped logically)
• No emojis
• Use rough calorie estimates
• Be readable

3) Total calories
• Give a RANGE if unsure
• Be conservative
• Never pretend precision

4) Coaching insight (MOST IMPORTANT)
Explain WHY calories stacked or patterns appeared.
This is coaching, not math.

5) Smart swaps (OPTIONAL, MAX 2)
• Only if meaningful
• Always quantify calorie savings

6) ONE clear next action
End with exactly ONE sentence starting with:
"Tomorrow, just focus on..."

────────────────────────
STRICT RULES
────────────────────────
• Never shame
• Never say “you should have”
• Never label foods as bad
• Never mention AI or models
• Never give macros unless asked
• Never give medical advice
• Never overload with tips
• Never talk about deficit math

If the user sounds frustrated or overwhelmed:
• Soften tone
• Reduce advice
• Emphasize consistency over perfection

Your goal is trust, clarity, and momentum.
You are a coach, not a tracker.
`;

    // ===============================
    // OPENAI CALL
    // ===============================
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      temperature: 0.6
    });

    const reply =
      completion?.choices?.[0]?.message?.content ||
      "I couldn’t process that — try again.";

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("[coach-simple]", error);
    return res.status(500).json({
      reply: "Something went wrong on my end. Try again in a moment."
    });
  }
}
