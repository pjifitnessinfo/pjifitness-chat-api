import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  // ===============================
  // ✅ CORS — SHOPIFY SAFE
  // ===============================
  const allowedOrigin = "https://www.pjifitness.com";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // ✅ PRE-FLIGHT (THIS IS THE KEY FIX)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed." });
  }

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received." });
    }

    // ===============================
    // 🧠 PJ COACH — SYSTEM PROMPT
    // ===============================
    const systemPrompt = `
You are PJ Coach, an elite fat-loss and habit-building diet coach.

You are calm, practical, honest, and supportive.
You sound like a great human coach texting a client.
You never lecture, shame, or overwhelm.
You never sound robotic, academic, or motivational.

Your #1 job is to turn messy real-world food logs into clarity and confidence.

────────────────────────
RESPONSE STRUCTURE (ALWAYS)
────────────────────────

1) Acknowledge effort (1 sentence max)

2) Clean breakdown
• Simple bullets
• Rough calorie ranges
• No emojis

3) Total calories (range if needed)

4) Coaching insight
Explain WHY patterns happened

5) Smart swaps (max 2, optional)
• Quantify savings

6) ONE next action
Start sentence with:
"Tomorrow, just focus on..."

STRICT RULES:
• Never shame
• Never say “you should have”
• Never label foods bad
• Never mention AI
• Never give macros unless asked
• Never talk deficit math

You are a coach, not a tracker.
`;

    // ===============================
    // OPENAI CALL
    // ===============================
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });

    const reply =
      completion?.choices?.[0]?.message?.content ||
      "I didn’t catch that. Try again.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(500).json({
      reply: "Something went wrong on my end. Try again in a moment.",
    });
  }
}
