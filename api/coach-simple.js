export const config = {
  api: {
    bodyParser: false
  }
};

export default function handler(req, res) {
  // ===============================
  // HARD CORS — MUST RUN FIRST
  // ===============================
  const origin = req.headers.origin;

  // Allow ONLY your site (no wildcard during preflight issues)
  if (origin === "https://www.pjifitness.com") {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");

  // ===============================
  // PRE-FLIGHT — RETURN IMMEDIATELY
  // ===============================
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed." });
  }

  // ===============================
  // MANUAL BODY PARSE
  // ===============================
  let rawBody = "";

  req.on("data", chunk => {
    rawBody += chunk.toString();
  });

  req.on("end", async () => {
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return res.status(400).json({ reply: "Invalid JSON body." });
    }

    const message =
      body.message ||
      body.input ||
      body.text ||
      "";

    const history = Array.isArray(body.history) ? body.history : [];

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received." });
    }

    try {
      // ===============================
      // SYSTEM PROMPT
      // ===============================
      const systemPrompt = `
You are PJ Coach — a highly effective, human-feeling fat-loss coach.
You are calm, practical, supportive, and human.
Never robotic. Never clinical.
`;

      // ===============================
      // OPENAI CALL
      // ===============================
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

      if (!openaiRes.ok) {
        const text = await openaiRes.text();
        console.error("[coach-simple] OpenAI error:", text);
        return res.status(500).json({ reply: "AI error." });
      }

      const data = await openaiRes.json();

      return res.status(200).json({
        reply:
          data?.choices?.[0]?.message?.content ||
          "I didn’t catch that — try again."
      });

    } catch (err) {
      console.error("[coach-simple] fatal:", err);
      return res.status(500).json({
        reply: "Something went wrong. Try again."
      });
    }
  });
}
