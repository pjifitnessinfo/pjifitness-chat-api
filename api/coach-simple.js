export const config = {
  api: {
    bodyParser: false
  }
};

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
    // ===============================
    // MANUAL BODY PARSE (CRITICAL FIX)
    // ===============================
    let rawBody = "";
    await new Promise((resolve, reject) => {
      req.on("data", chunk => {
        rawBody += chunk.toString();
      });
      req.on("end", resolve);
      req.on("error", reject);
    });

    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      return res.status(400).json({
        error: "Invalid JSON body",
        rawBody
      });
    }

    console.log("[coach-simple] parsed body:", body);

    const message =
      body.message ||
      body.input ||
      body.text ||
      "";

    const history = Array.isArray(body.history) ? body.history : [];

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Missing message",
        received: body
      });
    }

    // ===============================
    // SYSTEM PROMPT
    // ===============================
    const systemPrompt = `
You are PJ Coach — a highly effective, human-feeling fat-loss coach.
[UNCHANGED PROMPT — OMITTED FOR BREVITY IN EXPLANATION]
`;

    // ===============================
    // OPENAI CALL
    // ===============================
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.OPENAI_API_KEY}\`,
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
      const t = await openaiRes.text();
      console.error("[coach-simple] OpenAI error:", t);
      throw new Error("OpenAI failed");
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
}
