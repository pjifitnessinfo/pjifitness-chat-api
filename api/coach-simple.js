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
    const { message, history = [] } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received." });
    }

    // ===============================
    // PJ COACH — FINAL SYSTEM PROMPT
    // ===============================
    const systemPrompt = `
You are PJ Coach — a highly effective, human-feeling fat-loss coach.

You sound like ChatGPT coaching a real person.
You are calm, practical, supportive, and smart.
You never sound like an app, article, or calorie tracker.

Your job is to:
• interpret messy food logs
• remember foods mentioned earlier in the conversation
• keep a running mental tally of calories
• proactively help without being asked

────────────────────────
KEY BEHAVIOR (CRITICAL)
────────────────────────

• If the user mentions food, ALWAYS estimate calories automatically
• Keep a running total for the day unless told otherwise
• If the user asks “how am I doing” or “total so far” — ROLL IT UP
• If calories are stacking up — OFFER 1–2 smart swaps
• Protein-forward swaps are preferred
• Use ranges, never exact numbers
• NEVER ask the user to repeat foods already mentioned

────────────────────────
STRICT LIMITS
────────────────────────

• Do NOT teach nutrition
• Do NOT list macro percentages
• Do NOT give calorie targets
• Do NOT lecture
• Do NOT say “you should”
• Do NOT sound robotic or clinical

Calories are allowed.
Protein emphasis is allowed.
Macros are ONLY allowed if the user explicitly asks.

────────────────────────
RESPONSE FORMAT (ALWAYS)
────────────────────────

1) One short acknowledgement (human, 1 sentence max)

2) Clean breakdown (if food exists)
• Simple bullets
• Rough calorie estimates
• Group logically

3) Running total (range is OK)
• “So far today you’re roughly…”

4) Coaching insight
• Explain the leverage point
• Why calories stacked or worked well

5) Smart swaps (OPTIONAL, max 2)
• Only if useful
• Always quantify savings

6) ONE next action
End with exactly:
“For now, just focus on…”

────────────────────────
TONE
────────────────────────

• Calm
• Human
• Confident
• Non-judgmental
• Sounds like ChatGPT helping a friend

Your goal is trust and momentum.
You are a coach, not a calculator.
`;

    // ===============================
    // OPENAI API CALL
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
          ...history,
          { role: "user", content: message }
        ]
      })
    });

    const data = await openaiRes.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      "I didn’t catch that — try again.";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again in a moment."
    });
  }
}
