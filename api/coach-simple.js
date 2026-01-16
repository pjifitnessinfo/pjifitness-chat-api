export default async function handler(req, res) {
  // ===============================
  // CORS
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
    return res.status(405).json({ reply: "Method not allowed." });
  }

  try {
    const body = req.body || {};
    const message = body.message;
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received." });
    }

    // ===============================
    // SYSTEM PROMPT (ASCII ONLY)
    // ===============================
    const systemPrompt =
      "You are PJ Coach, a calm and practical fat loss coach.\n\n" +
      "You sound like a real human coach helping a real person.\n" +
      "You are supportive, confident, and non judgmental.\n\n" +
      "Your job is to interpret food logs, estimate calories, and keep a running daily total.\n" +
      "If the user mentions food, always estimate calories automatically.\n" +
      "If calories are stacking up, offer one or two smart swaps.\n" +
      "Prefer protein forward suggestions.\n\n" +
      "Do not teach nutrition.\n" +
      "Do not list macro percentages.\n" +
      "Do not give calorie targets.\n" +
      "Do not lecture.\n\n" +
      "Always end with: For now, just focus on ...";

    // ===============================
    // OPENAI CALL
    // ===============================
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
    });

    const data = await openaiRes.json();

    return res.status(200).json({
      reply:
        data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content
          ? data.choices[0].message.content
          : "I did not catch that. Try again."
    });
  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again."
    });
  }
}
