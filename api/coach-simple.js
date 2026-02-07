export const config = {
  api: { bodyParser: true }
};

/* ======================================
   SYSTEM PROMPT (HYBRID – NATURAL + SMART)
====================================== */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.

TONE & STYLE:
- Talk naturally like ChatGPT
- Friendly, human, reassuring
- No rigid formatting
- No robotic lists
- Explain things clearly if asked
- Coach, don’t lecture

CORE BEHAVIOR (IMPORTANT):
- If FOOD is mentioned → ALWAYS estimate calories conversationally
- If portions are unclear → give a reasonable range
- Do NOT ask for permission to estimate
- Do NOT avoid numbers when food is mentioned

WEIGHT RULES:
- Detect body weight ONLY if phrased like:
  "I weigh", "I weighed in", "today’s weight", "scale said"
- Ignore food weights (oz, grams, cups)
- When weight is shared, explain trends and water weight briefly

LOGGING (SILENT):
- NEVER say “I logged this”
- NEVER mention tracking, databases, or sheets
- Signals are internal only

OUTPUT FORMAT (MANDATORY):
Return ONLY valid JSON:

{
  "reply": string,
  "signals": {
    "meal": {
      "detected": boolean,
      "text": string,
      "estimated_calories": number,
      "confidence": number
    },
    "weight": {
      "detected": boolean,
      "value": number,
      "confidence": number
    }
  }
}

SIGNAL RULES:
- detected=true ONLY when confidence is high
- estimated_calories must be a SINGLE number (best estimate)
- confidence between 0 and 1
`;

/* ======================================
   HANDLER
====================================== */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ reply: "Method not allowed.", signals: {} });
  }

  try {
    const { user_id, message, history = [] } = req.body;
    console.log("USER_ID:", user_id);

    if (!user_id) {
  return res.status(400).json({
    reply: "Missing user ID.",
    signals: {}
  });
}


    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received.", signals: {} });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT.trim() },
      ...Array.isArray(history)
        ? history.filter(m => m?.role && m?.content).slice(-12)
        : [],
      { role: "user", content: message }
    ];

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.5,
        messages
      })
    });

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(200).json({
        reply: "I didn’t catch that — try again.",
        signals: {}
      });
    }

    // Enforce JSON output
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Safety fallback — still respond, but no logging
      return res.status(200).json({
        reply: content,
        signals: {}
      });
    }

    return res.status(200).json({
      reply: parsed.reply || "Okay.",
      signals: parsed.signals || {}
    });

  } catch (err) {
    console.error("[coach-simple] fatal:", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again in a moment.",
      signals: {}
    });
  }
}
