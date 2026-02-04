export const config = {
  api: { bodyParser: true }
};

/* ======================================
   SYSTEM PROMPT (CORE BEHAVIOR)
====================================== */
const SYSTEM_PROMPT = `
You are PJ Coach — a calm, supportive, practical fitness coach.

STYLE:
- Talk naturally like ChatGPT
- Be conversational, human, reassuring
- No rigid formatting
- No lectures or shaming
- Explain things clearly if asked
- Give guidance when useful
- If user sounds stressed, reassure them

COACHING:
- Help the user make sense of their day
- If food is mentioned, reason about calories internally
- If weight is mentioned, reason about trends and water weight
- Guide what to do next without being strict

IMPORTANT:
- Never say "I logged this"
- Never mention databases, tracking, or sheets
- Never ask the user to confirm logging
- Logging happens silently via signals

OUTPUT:
You MUST return JSON with:
{
  reply: string,
  signals: {
    meal?: {
      detected: boolean,
      text?: string,
      estimated_calories?: number,
      confidence?: number
    },
    weight?: {
      detected: boolean,
      value?: number,
      confidence?: number
    }
  }
}

RULES FOR SIGNALS:
- Only set detected=true if confidence is HIGH
- Body weight requires phrases like:
  "I weigh", "weighed in", "today's weight", "scale said"
- Food weights (oz, grams) are NOT body weight
- If unsure, set detected=false
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
    return res.status(405).json({ reply: "Method not allowed." });
  }

  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "No message received." });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT.trim() },
      ...Array.isArray(history)
        ? history
            .filter(m => m && m.role && m.content)
            .slice(-12)
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
        temperature: 0.45,
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

    // Ensure valid JSON response from model
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Safety fallback: show text, no logging
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
    console.error("[coach-simple]", err);
    return res.status(500).json({
      reply: "Something went wrong. Try again in a moment.",
      signals: {}
    });
  }
}
