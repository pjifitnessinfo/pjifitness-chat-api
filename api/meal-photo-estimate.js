// /api/meal-photo-estimate.js
// Estimate calories from a meal photo, with CORS enabled.
// Returns { reply, log_json } to the frontend.

const ALLOWED_ORIGIN = "https://www.pjifitness.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Call OpenAI with the base64 data URL
async function callOpenAIVision(imageBase64DataUrl) {
  const body = {
    model: "gpt-4.1-mini", // or match the model you use in /api/chat.js
    messages: [
      {
        role: "system",
        content:
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
          "Use TODAY'S date in YYYY-MM-DD format. Use single best-guess numbers (no ranges)."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Here is a photo of my meal. Assume it's 1 serving for me. " +
              "Estimate total calories and macros. If something is unclear, " +
              "just mention the uncertainty instead of asking questions."
          },
          {
            type: "image_url",
            image_url: {
              // Frontend sends a full data URL like "data:image/png;base64,...."
              url: imageBase64DataUrl
            }
          }
        ]
      }
    ],
    temperature: 0.3
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
  const fullReply = data.choices?.[0]?.message?.content || "";
  return fullReply;
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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OPENAI_API_KEY) {
    // Still return 200 so frontend doesn't fall into "failed to fetch"
    return res.status(200).json({
      reply:
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

    console.log("Photo estimate request from:", { email, customerId });
    console.log("image_base64 starts with:", image_base64.slice(0, 50));

    let fullReply;
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

    return res.status(200).json({
      reply: fullReply,
      log_json: logJson
    });
  } catch (err) {
    console.error("meal-photo-estimate handler error:", err);
    // Final fallback – still 200 so frontend shows a message instead of generic error
    return res.status(200).json({
      reply:
        "I couldn't estimate that meal from the photo due to an unexpected error. " +
        "Try again in a minute or log it manually.",
      log_json: null
    });
  }
}
