export default async function handler(req, res) {
  // ===============================
  // CORS (stable)
  // ===============================
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(200).json({ reply: "OK" });
  }

  try {
    const body = req.body || {};

    // Pull message safely
    let message =
      body.message ||
      body.input ||
      body.text ||
      body.prompt ||
      body.value ||
      "";

    // Normalize history
    const history = Array.isArray(body.history)
      ? body.history.filter(
          m =>
            m &&
            typeof m === "object" &&
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.trim()
        )
      : [];

    // 🔑 CRITICAL DEFENSIVE FIX:
    // If message is empty BUT we have user history, use the latest user message
    if (!message.trim() && history.length > 0) {
      message = history[history.length - 1].content;
    }

    // Absolute final fallback
    if (!message.trim()) {
      message = "Food log provided.";
    }

    // ===============================
    // SYSTEM PROMPT (ANTI-RESET)
    // ===============================
    const systemPrompt =
      "CRITICAL RULE:\n" +
      "If the user message contains food, meals, brands, portions, calories, or quantities, you MUST analyze it immediately.\n" +
      "Do NOT say the user has not shared food.\n" +
      "Do NOT greet the user.\n" +
      "Do NOT reset the conversation.\n\n" +

      "You are PJ Coach, an elite fat loss and diet coach.\n" +
      "You coach like a real human helping a real person.\n\n" +

      "Your job:\n" +
      "- Interpret messy food logs\n" +
      "- Estimate calories automatically\n" +
      "- Keep a running daily total\n" +
      "- Help the user make the day better, not perfect\n\n" +

      "Rules:\n" +
      "- Always acknowledge effort first\n" +
      "- Use calorie ranges\n" +
      "- Identify the biggest leverage point\n" +
      "- Suggest easy swaps only if helpful\n\n" +

      "Response format:\n" +
      "1. Short acknowledgement\n" +
      "2. Food breakdown with calories\n" +
      "3. Running total\n" +
      "4. Coaching insight\n" +
      "5. Optional swaps\n" +
      "6. End EXACTLY with: For now, just focus on ...";

    // ===============================
    // OPENAI CALL
    // ===============================
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.OPENAI_API_KEY,
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
      }
    );

    const data = await openaiRes.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      "For now, just focus on staying consistent today.";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(200).json({
      reply: "For now, just focus on staying consistent today."
    });
  }
}
