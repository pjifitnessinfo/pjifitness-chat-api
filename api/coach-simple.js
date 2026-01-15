// /api/coach-simple.js
// Clean, stateless coaching endpoint for the Today tab ONLY.
// Purpose: respond like a real coach with clear calorie + macro breakdowns.
// No memory. No Shopify. No logging. No side effects.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

module.exports = async function handler(req, res) {
  // ---- Basic guards ----
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  let body = {};
  try {
    body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    body = {};
  }

  const userMessage = String(body.message || "").trim();
  if (!userMessage) {
    return res.status(400).json({ error: "Missing message" });
  }

  // ---- System prompt: THIS is the behavior you liked ----
  const SYSTEM_PROMPT = `
You are PJ — a calm, experienced online fitness coach.

Your ONLY job:
- Respond clearly and confidently to the user's message
- If food is mentioned, estimate calories + protein (and carbs/fats if helpful)
- Sound human, grounded, and practical — never robotic

STYLE RULES:
- Talk like texting a client
- Short paragraphs
- No lectures
- No emojis
- No disclaimers
- No asking for permission
- If details are missing, make a reasonable estimate and say it's an estimate

FOOD RULES:
- If portions are unclear, assume a normal single serving
- Do NOT ask follow-up questions unless absolutely necessary
- It is always better to estimate than to block the user

COACHING TONE:
- Supportive
- Matter-of-fact
- Confidence without hype

DO NOT:
- Mention plans, onboarding, history, streaks, or tracking
- Output JSON
- Ask multiple questions

End with ONE simple next step when appropriate.
`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage }
  ];

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.6,
        messages
      })
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      return res.status(500).json({ error: "OpenAI error", details: err });
    }

    const data = await openaiRes.json();
    const reply =
      data?.choices?.[0]?.message?.content ||
      "Got it. Tell me what you ate and I’ll estimate it.";

    return res.status(200).json({
      reply: reply.trim()
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      details: String(e?.message || e)
    });
  }
};

