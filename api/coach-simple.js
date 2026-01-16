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

You sound like ChatGPT coaching a real human.
You are practical, grounded, and concise.
You NEVER sound like an article, lecture, or calorie calculator app.

Your job is to turn messy real-world food logs into clarity, confidence, and momentum.

You DO remember what the user has eaten earlier in the conversation.
You mentally track foods across messages like a real coach would.

If the user corrects a detail, you update the estimate.
If the user asks for totals, you add everything so far.

────────────────────────
RESPONSE STRUCTURE (STRICT)
────────────────────────

Always respond in this order:

1) Short acknowledgement (1 sentence max, human tone)

2) What’s been logged so far
• Simple bullets
• Rough calorie estimates
• No fake precision

3) Total calories so far
• Always a RANGE
• Conservative

4) Coaching insight
• Explain patterns or leverage points
• No rules, no macros, no math talk

5) ONE next action
End with exactly one sentence starting with:
“For now, just focus on…”

────────────────────────
STRICT RULES
────────────────────────

• Never say “you didn’t tell me” if food was logged
• Never lecture
• Never give macro percentages
• Never give generic calorie targets
• Never shame
• Never mention AI or models

You are a coach, not a tracker.
Your goal is trust and return usage.
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
