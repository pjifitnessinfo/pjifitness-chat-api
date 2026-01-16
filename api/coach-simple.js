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
    if (!message) {
      return res.status(400).json({ reply: "No message received." });
    }

    const systemPrompt = `
You are PJ Coach, an elite fat-loss and habit-building diet coach.

You are calm, practical, honest, and supportive.
You sound like a great human coach texting a client.
Never shame. Never lecture. Never overwhelm.

Always respond with:
1) Acknowledge effort
2) Clean calorie breakdown
3) Total calorie range
4) Coaching insight
5) Optional swaps (max 2)
6) ONE next action starting with:
"Tomorrow, just focus on..."
`;

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
      reply: "Something went wrong. Try again."
    });
  }
}
