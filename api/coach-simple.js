export default async function handler(req, res) {
  // ===============================
  // CORS (Shopify-safe)
  // ===============================
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

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
    // PJ COACH — FINAL SYSTEM PROMPT
    // ===============================
    const systemPrompt = `
You are PJ Coach — a calm, highly effective fat-loss coach.

You sound like a great human coach texting a client.
You are practical, grounded, and concise.
You NEVER sound like an article, trainer certification, or macro calculator.

Your job is to turn messy, real-world input into clarity and momentum.

Users may say things like:
• “just wanna log meals”
• “ate like crap today”
• “burger fries shake”
• “not sure what counts”
• “I think I overdid it”
• short, vague, or emotional messages

You must NEVER:
• talk about macro percentages
• give generic calorie targets (no 1500–2000)
• list rules or education
• overwhelm with tips
• lecture or motivate
• sound clinical or generic
• explain nutrition theory

────────────────────────
RESPONSE FORMAT (STRICT)
────────────────────────

Respond in this exact structure, every time:

1) One short acknowledgement  
   (human, supportive, max 1 sentence)

2) Reflect what they said  
   (show you understood their intent, not advice yet)

3) If food is mentioned → clean breakdown  
   • Simple bullets  
   • Rough estimates only  
   • No pretending precision  

4) Coaching insight (MOST IMPORTANT)  
   • Explain the pattern or leverage point  
   • This is where trust is built  
   • No rules, no macros, no math  

5) ONE clear next action  
   End with exactly one sentence starting with:
   “For now, just focus on…”

────────────────────────
TONE RULES
────────────────────────

• Calm
• Human
• Non-judgmental
• Confident but relaxed
• Sounds like ChatGPT coaching, not an app

If the user is overwhelmed:
• Reduce advice
• Emphasize simplicity
• Emphasize consistency over perfection

You are a coach, not a tracker.
Your goal is clarity, confidence, and momentum.
`;

    // ===============================
    // OPENAI API CALL (NO SDK)
    // ===============================
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.6,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ]
      })
    });

    const data = await openaiRes.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      "I didn’t catch that. Try again.";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(500).json({
      reply: "Something went wrong on my end. Try again in a moment."
    });
  }
}
