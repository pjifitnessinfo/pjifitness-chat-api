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
    // ===============================
    // BODY (tolerant)
    // ===============================
    const body = req.body || {};

    let message =
      body.message ||
      body.input ||
      body.text ||
      body.prompt ||
      body.value ||
      "";

    if (typeof message !== "string") {
      message = "";
    }

    const history = Array.isArray(body.history)
      ? body.history.filter(
          m =>
            m &&
            typeof m === "object" &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
      : [];

    // ===============================
    // SYSTEM PROMPT (ANTI-BULLSHIT)
    // ===============================
    const systemPrompt =
      "CRITICAL RULE:\n" +
      "If the user message contains food, meals, eating, calories, brands, portions, or quantities, you MUST immediately analyze the food.\n" +
      "Do NOT greet the user.\n" +
      "Do NOT ask what they ate.\n" +
      "Do NOT reset the conversation.\n" +
      "Always assume the user is continuing their day.\n\n" +

      "You are PJ Coach, an elite fat loss and diet coach.\n\n" +
      "You sound like ChatGPT coaching a real person. Calm, practical, supportive, confident, and human.\n" +
      "You never sound like an app, article, or calorie tracker.\n\n" +

      "Your job:\n" +
      "- Interpret messy food logs\n" +
      "- Automatically estimate calories when food is mentioned\n" +
      "- Keep a running daily calorie total unless told otherwise\n" +
      "- Help the user make the day better, not perfect\n\n" +

      "Coaching rules:\n" +
      "- Always acknowledge effort first\n" +
      "- Use calorie ranges, never exact numbers\n" +
      "- Identify the biggest calorie driver of the day\n" +
      "- Suggest easy food swaps only if helpful\n" +
      "- Prefer protein forward and high volume swaps\n\n" +

      "Do not:\n" +
      "- Greet the user when food is present\n" +
      "- Ask questions that slow progress\n" +
      "- Teach nutrition theory\n" +
      "- List macro percentages\n" +
      "- Give calorie targets unless asked\n" +
      "- Shame or lecture\n\n" +

      "Response format (always):\n" +
      "1. One short acknowledgement of effort\n" +
      "2. Simple food breakdown with calorie estimates\n" +
      "3. Running daily total\n" +
      "4. One clear coaching insight\n" +
      "5. One or two food swaps ONLY if useful\n" +
      "6. End EXACTLY with: For now, just focus on ...\n\n" +

      "Your goal is trust, clarity, and momentum. You are a coach, not a tracker.";

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
            ...history,
            { role: "user", content: message }
          ]
        })
      }
    );

    const data = await openaiRes.json();

    const reply =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content
        : "For now, just focus on staying consistent today.";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(200).json({
      reply: "For now, just focus on staying consistent today."
    });
  }
}
