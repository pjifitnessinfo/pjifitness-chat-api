// /api/meal-photo-estimate.js
// Estimate calories from a meal photo, with CORS enabled.
// Frontend sends: { image_base64, email, customerId }
// Returns: { reply, reply_clean, log_json }

const ALLOWED_ORIGIN = "https://www.pjifitness.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ------------------------------
// Helpers
// ------------------------------
function stripLogJsonBlock(text) {
  if (!text) return "";
  const start = text.indexOf("[[LOG_JSON");
  if (start === -1) return text.trim();

  // Remove from [[LOG_JSON ... ]] to end (or just remove that block if embedded)
  const end = text.indexOf("]]", start);
  if (end === -1) return text.trim();

  const before = text.slice(0, start);
  const after = text.slice(end + 2);
  return (before + after).trim();
}

// Pull [[LOG_JSON {...}]] out of the reply if it exists
function extractLogJson(text) {
  if (!text) return null;
  const start = text.indexOf("[[LOG_JSON");
  if (start === -1) return null;

  const end = text.indexOf("]]", start);
  if (end === -1) return null;

  const block = text.substring(start, end + 2);
  const jsonStart = block.indexOf("{");
  const jsonEnd = block.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;

  try {
    const jsonString = block.substring(jsonStart, jsonEnd + 1);
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Failed to parse LOG_JSON from photo estimate:", e);
    return null;
  }
}

// Very light validation to catch obviously bad payloads
function looksLikeDataUrl(s) {
  return typeof s === "string" && s.startsWith("data:image/");
}

// ------------------------------
// OpenAI Vision Call (Responses API)
// ------------------------------
async function callOpenAIVision(imageBase64DataUrl) {
  const system =
    "You are the PJiFitness AI Coach. The user sends you a PHOTO of their meal. " +
    "Your job: " +
    "1) Identify the foods and rough portion sizes. " +
    "2) Estimate TOTAL calories, plus approximate grams of protein, carbs, and fats. " +
    "3) Be honest about uncertainty (oils, sauces, hidden calories). " +
    "4) Speak in a clear, friendly tone, 2–4 short paragraphs max. " +
    "5) At the very end, embed a LOG_JSON block in EXACTLY this format:\n" +
    "[[LOG_JSON\n" +
    "{\n" +
    '  "date": "YYYY-MM-DD",\n' +
    '  "meals": [\n' +
    "    {\n" +
    '      "type": "dinner",\n' +
    '      "description": "string description of the meal",\n' +
    '      "calories": 0,\n' +
    '      "protein_g": 0,\n' +
    '      "carbs_g": 0,\n' +
    '      "fat_g": 0,\n' +
    '      "source": "photo_estimate"\n' +
    "    }\n" +
    "  ]\n" +
    "}\n" +
    "]]\n" +
    "Use TODAY'S date in YYYY-MM-DD format. Use single best-guess numbers (no ranges). " +
    '6) For "type", you MUST choose exactly one of: "breakfast", "lunch", "dinner", or "snack" — no other values.';

  const userText =
    "Here is a photo of my meal. Assume it's 1 serving for me. " +
    "Estimate total calories and macros. If something is unclear, " +
    "just mention the uncertainty instead of asking questions.";

  const body = {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [{ type: "text", text: system }]
      },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "input_image", image_url: imageBase64DataUrl }
        ]
      }
    ],
    temperature: 0.3
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("OpenAI vision error: " + resp.status + " " + errText);
  }

  const data = await resp.json();

  // Responses API output text extraction
  // data.output is an array of items; we want concatenated text chunks
  let fullReply = "";

  try {
    const out = Array.isArray(data.output) ? data.output : [];
    for (const item of out) {
      // Many responses include: { type:"message", content:[{type:"output_text", text:"..."}] }
      if (item && item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && (c.type === "output_text" || c.type === "text") && typeof c.text === "string") {
            fullReply += c.text;
          }
        }
      }
      // Fallback: some SDKs provide item.text
      if (item && typeof item.text === "string") fullReply += item.text;
    }
  } catch (e) {
    // last resort
    fullReply = "";
  }

  // Another fallback: some responses return `output_text`
  if (!fullReply && typeof data.output_text === "string") {
    fullReply = data.output_text;
  }

  return String(fullReply || "").trim();
}

// ------------------------------
// Handler
// ------------------------------
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OPENAI_API_KEY) {
    return res.status(200).json({
      reply:
        "I couldn't estimate that meal because the AI key isn't configured. " +
        "Please let PJ know to set OPENAI_API_KEY in the chat API project.",
      reply_clean:
        "I couldn't estimate that meal because the AI key isn't configured. " +
        "Please let PJ know to set OPENAI_API_KEY in the chat API project.",
      log_json: null
    });
  }

  try {
    const { image_base64, email, customerId } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 is required" });
    }

    if (!looksLikeDataUrl(image_base64)) {
      return res.status(400).json({
        error: "image_base64 must be a data URL like data:image/jpeg;base64,..."
      });
    }

    // Helpful logging
    console.log("Photo estimate request from:", { email, customerId });
    console.log("image_base64 starts with:", String(image_base64).slice(0, 60));
    console.log("image_base64 length:", String(image_base64).length);

    let fullReply = "";
    let logJson = null;

    try {
      fullReply = await callOpenAIVision(image_base64);
      logJson = extractLogJson(fullReply);
    } catch (err) {
      console.error("OpenAI vision call failed:", err);
      fullReply =
        "I tried to estimate that meal from the photo, but something went wrong on my end. " +
        "For now, log it manually or describe the meal in text and I’ll estimate it that way.";
      logJson = null;
    }

    const reply_clean = stripLogJsonBlock(fullReply);

    return res.status(200).json({
      reply: fullReply,
      reply_clean,
      log_json: logJson
    });
  } catch (err) {
    console.error("meal-photo-estimate handler error:", err);

    return res.status(200).json({
      reply:
        "I couldn't estimate that meal from the photo due to an unexpected error. " +
        "Try again in a minute or log it manually.",
      reply_clean:
        "I couldn't estimate that meal from the photo due to an unexpected error. " +
        "Try again in a minute or log it manually.",
      log_json: null
    });
  }
}
