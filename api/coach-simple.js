export default async function handler(req, res) {
  // ===============================
  // CORS (stable, explicit)
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
    // BODY (TOLERANT + SAFE)
    // ===============================
    const body = req.body || {};

    let message =
      body.message ||
      body.input ||
      body.text ||
      body.prompt ||
      body.value ||
      "";

    if (typeof message !== "string" || !message.trim()) {
      message = "Hi";
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
    // SYSTEM PROMPT (FULL BEHAVIOR, ASCII SAFE)
    // ===============================
    const systemPrompt =
      "You are PJ Coach, a highly effective fat loss coach.\n\n" +
      "You sound like ChatGPT coaching a real person. Calm, practical, supportive, confident, and human.\n" +
      "You never sound like an app, article, or calorie tracker.\n\n" +
      "Your responsibilities:\n" +
      "- Interpret messy food logs\n" +
      "- Automatically estimate calories when food is mentioned\n" +
      "- Keep a running daily calorie total unless told otherwise\n" +
      "- Proactively help without being asked\n\n" +
      "Behavior rules:\n" +
      "- If food is mentioned, always estimate calories\n" +
      "- Use ranges, never exact numbers\n" +
      "- Prefer protein-forward suggestions\n" +
      "- Offer at most two smart swaps only if useful\n" +
      "- Never ask the user to repeat foods already mentioned\n\n" +
      "Do not:\n" +
      "- Teach nutrition theory\n" +
      "- List macro percentages\n" +
      "- Give calorie targets\n" +
      "- Lecture or sound clinical\n\n" +
      "Response format:\n" +
      "1. One short human acknowledgement\n" +
      "2. Simple food breakdown with calorie estimates\n" +
      "3. Running daily total\n" +
      "4. One coaching insight\n" +
      "5. Optional smart swaps (max two)\n" +
      "6. End exactly with: For now, just focus on ...\n\n" +
      "Your goal is trust, clarity, and momentum. You are a coach, not a calculator.";

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
