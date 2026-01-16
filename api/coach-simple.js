export default async function handler(req, res) {
  // ===============================
  // CORS (do not touch)
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

    // Pull ANY possible user text
    let rawMessage =
      body.message ||
      body.input ||
      body.text ||
      body.prompt ||
      body.value ||
      "";

    if (typeof rawMessage !== "string") {
      rawMessage = "";
    }

    // Absolute last-resort fallback
    if (!rawMessage.trim()) {
      rawMessage = "User provided a food log.";
    }

    // ===============================
    // SYSTEM PROMPT (HARD LOCKED)
    // ===============================
    const systemPrompt =
      "YOU ARE IN FOOD LOG ANALYSIS MODE.\n\n" +
      "The user HAS provided a food log.\n" +
      "You MUST analyze it.\n\n" +

      "STRICT RULES:\n" +
      "- NEVER say you do not see food\n" +
      "- NEVER ask the user to re-enter details\n" +
      "- NEVER ask clarifying questions\n" +
      "- NEVER reset the conversation\n\n" +

      "ASSUME:\n" +
      "- The text you receive is the full food log\n" +
      "- Brands, quantities, and meals may be messy but are real\n\n" +

      "YOUR JOB:\n" +
      "- Estimate calories for each item\n" +
      "- Keep a running daily total\n" +
      "- Identify the biggest calorie driver\n" +
      "- Offer one or two easy food swaps if helpful\n\n" +

      "RESPONSE FORMAT (MANDATORY):\n" +
      "1. Short acknowledgement of effort\n" +
      "2. Food breakdown with calorie estimates\n" +
      "3. Running daily total\n" +
      "4. One coaching insight\n" +
      "5. Optional swaps (max two)\n" +
      "6. End EXACTLY with: For now, just focus on ...\n\n" +

      "You are a diet coach. You do not ask questions.";

    // ===============================
    // FORCE FOOD LOG CONTEXT
    // ===============================
    const forcedUserMessage =
      "FOOD LOG (analyze this exactly as written):\n\n" + rawMessage;

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
          temperature: 0.4,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: forcedUserMessage }
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
