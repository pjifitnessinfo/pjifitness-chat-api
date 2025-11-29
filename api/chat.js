// /api/chat.js

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ======================================================
// CORS helper
// ======================================================
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// (optional, but fine for Next/Vercel)
export const config = {
  api: {
    bodyParser: true,
  },
};

// ======================================================
// SIMPLE V1 RUN_INSTRUCTIONS – CHAT ONLY
// ======================================================
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your job:
- Act like a friendly, no-BS fat loss and fitness coach texting with a client.
- Answer their questions and give clear, practical coaching they can use TODAY.
- Focus on weight loss, nutrition, steps/activity, strength training, mindset, and consistency.
- Keep it simple and realistic for a busy, normal human.

Tone:
- Casual, direct, encouraging, honest. Like PJ texting a client.
- Be supportive, not judgmental.
- If they had a bad day, normalize it and give them a plan for the next 24 hours.

Guidelines:
- For quick updates ("189.4 today, 2100 calories, 9k steps, felt ok"):
  - Give a short response (2–6 sentences).
  - Reflect what went well.
  - Give ONE clear focus for tomorrow or the rest of the day.

- For deeper questions ("Why is my weight stuck?", "Why is my lower belly fat not moving?"):
  - Give a clear explanation in plain language (up to a few short paragraphs).
  - Include 3–5 simple action steps (bullets are okay).

- You DO NOT need to do onboarding.
- You DO NOT need to collect name, starting weight, goal weight, or anything structured.
- You DO NOT need to produce JSON or logs.
- Just be a really good coach in text.

Assume:
- Each message is self-contained (you might not see full history).
- Respond based only on what they just sent, plus your coaching knowledge.
`;

// ======================================================
// Extract plain text from Responses API output
// ======================================================
function extractTextFromResponse(resp) {
  try {
    if (!resp) return "";

    if (typeof resp.output_text === "string" && resp.output_text.length > 0) {
      return resp.output_text.trim();
    }

    if (!resp.output) return "";

    let text = "";

    for (const item of resp.output) {
      if (!item?.content) continue;

      for (const part of item.content) {
        if (part.type === "text" && typeof part.text === "string") {
          text += part.text;
        }
        if (
          part.type === "output_text" &&
          part.text &&
          typeof part.text.value === "string"
        ) {
          text += part.text.value;
        }
      }
    }

    return text.trim();
  } catch (err) {
    console.error("Error extracting text:", err);
    return "";
  }
}

// ======================================================
// MAIN HANDLER – CHAT ONLY
// ======================================================
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const userMessage = body.message || body.input || "";
    const email = (body.email || body.userEmail || "").toLowerCase();

    if (!userMessage) {
      res.status(400).json({ error: "Missing 'message' in request body" });
      return;
    }

    // We ONLY send the user's actual message to the model.
    const aiResponse = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions: RUN_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userMessage,
            },
          ],
        },
      ],
      metadata: {
        source: "pjifitness-chat-api",
        email: email || "unknown",
      },
    });

    const reply = extractTextFromResponse(aiResponse);

    console.log("AI reply:", reply);

    // Keep response shape so frontend doesn't break
    res.status(200).json({
      reply: reply || "Sorry, I couldn't generate a response right now.",
      log: null,
      saveResult: null,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
