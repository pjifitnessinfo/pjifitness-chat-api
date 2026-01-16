export default async function handler(req, res) {
  // ===============================
  // CORS (simple, unconditional)
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
    // BODY (NO VALIDATION, EVER)
    // ===============================
    const body = req.body || {};

    // Accept ANY possible key, fallback safely
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

    const history = Array.isArray(body.history) ? body.history : [];

    // ===============================
    // SYSTEM PROMPT (ASCII SAFE)
    // ===============================
    const systemPrompt =
      "You are PJ Coach, a calm and practical fat loss coach.\n" +
      "You help users log food and estimate calories.\n" +
      "You are supportive and human.\n" +
      "If food is mentioned, estimate calories.\n" +
      "End with: For now, just focus on ...";

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
        : "OK";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("[coach-simple]", err);
    return res.status(200).json({
      reply: "OK"
    });
  }
}
