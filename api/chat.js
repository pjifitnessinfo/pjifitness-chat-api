// /api/chat.js
// Simple Chat endpoint using OpenAI REST API.
// Expects: { message, email, customerId, threadId } in JSON body.
// Returns: { reply }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Simple PJiFitness system prompt
const SYSTEM_PROMPT = `
You are the PJiFitness AI Coach.

Tone:
- Casual, direct, supportive, like a real coach texting a client.
- Short answers for simple check-ins (2–6 sentences).

Behavior:
- If user sends weight/calories/steps, acknowledge and give 1 clear focus for next 24 hours.
- If user asks questions about plateaus, stubborn fat, macros, cravings, etc — explain simply and give 1–2 concrete actions.
- Always be encouraging, practical, and realistic. No crash diets.
`;

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    try {
      if (req.body && typeof req.body === "object") {
        return resolve(req.body);
      }
      let data = "";
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error("Invalid JSON body", e);
          resolve({});
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

export default async function handler(req, res) {
  // ---- CORS handling ----
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(200).end();
    return;
  }

  // Allow browser calls from Shopify
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error("Error parsing body", e);
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const userMessage = body.message || "";

  if (!userMessage) {
    res.status(400).json({ error: "Missing 'message' in body" });
    return;
  }

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI error:", errText);
      res.status(500).json({ error: "OpenAI API error" });
      return;
    }

    const data = await openaiRes.json();
    const reply =
      data.choices?.[0]?.message?.content ||
      "Sorry, I’m not sure what to say to that.";

    res.status(200).json({ reply });
  } catch (e) {
    console.error("Chat handler error:", e);
    res.status(500).json({ error: "Server error" });
  }
}
