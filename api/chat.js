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

export const config = {
  api: {
    bodyParser: true,
  },
};

// ======================================================
// RUN_INSTRUCTIONS – CHAT ONLY (NO JSON, NO LOG TAGS)
// ======================================================
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your ONLY job is to talk to the user like PJ would:
- casual, direct, friendly, honest
- help them with weight loss, food choices, steps, workouts, and mindset
- encourage consistency over perfection
- keep daily check-in replies around 2–6 sentences
- for deeper "why is this happening?" questions, you can go longer and give clear steps

IMPORTANT:
- The WEBSITE handles all logging of weight / calories / steps.
- Do NOT output JSON.
- Do NOT output <COACH>, <LOG_JSON>, code fences, or any tags.
- Just reply with plain text like a normal chat message.
`;

// ======================================================
// Extract plain text from Responses API output
// ======================================================
function extractTextFromResponse(resp) {
  try {
    if (!resp) return "";

    // Newer SDK: output_text convenience
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

    // We still pass email as metadata if you ever want to inspect logs,
    // but the model does NOT see it in the content.
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

    const fullText = extractTextFromResponse(aiResponse) || "";
    const reply =
      fullText.trim() ||
      "Hey, I saw your message but something glitched on my end. Try again in a moment.";

    res.status(200).json({
      reply,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
