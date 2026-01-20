// /api/meal-photo-estimate.js
// Estimate calories from a meal photo, with CORS enabled.
// Returns { reply, reply_clean, log_json } to the frontend.

export const config = {
  api: {
    bodyParser: {
      // IMPORTANT: meal photos as base64 can be large
      sizeLimit: "15mb",
    },
  },
};

const ALLOWED_ORIGINS = new Set([
  "https://www.pjifitness.com",
  "https://pjifitness.com",
  // Optional local testing:
  "http://localhost:3000",
]);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// You can override in Vercel env if you want:
// PHOTO_VISION_MODEL=gpt-4.1-mini (or another vision-capable model)
const VISION_MODEL = (process.env.PHOTO_VISION_MODEL || "gpt-4.1-mini").trim();

// --- OpenAI Responses API call (vision) ---
async function callOpenAIVisionResponses(imageDataUrl) {
  // If the frontend accidentally sends raw base64 without the data: prefix,
  // wrap it with a default jpeg prefix.
  const url =
    String(imageDataUrl || "").startsWith("data:image/")
      ? imageDataUrl
      : `data:image/jpeg;base64,${String(imageDataUrl || "")}`;

  const systemPrompt =
    "You are the PJiFitness AI Coach. The user sends you a PHOTO of their meal. " +
    "Your job: " +
    "1) Identify the foods and rough portion sizes. " +
    "2) Estimate TOTAL calories, plus approximate grams of protein, carbs, and fats. " +
    "3) Be honest about uncertainty (oils, sauces, hidden calories). " +
    "4) Speak in a clear, friendly tone, 2–4 short paragraphs max. " +
    "5) At the very end, embed a LOG_JSON block in EXACTLY this format:\n" +
    "[[LOG_JSON\n" +
    "{\n" +
    '  \"date\": \"YYYY-MM-DD\",\n' +
    '  \"meals\": [\n' +
    "    {\n" +
    '      \"type\": \"dinner\",\n' +
    '      \"description\": \"string description of the meal\",\n' +
    '      \"calories\": 0,\n' +
    '      \"protein_g\": 0,\n' +
    '      \"carbs_g\": 0,\n' +
    '      \"fat_g\": 0,\n' +
    '      \"source\": \"photo_estimate\"\n' +
    "    }\n" +
    "  ]\n" +
    "}\n" +
    "]]\n" +
    "Use TODAY'S date in YYYY-MM-DD format. Use single best-guess numbers (no ranges). " +
    "6) For \"type\", you MUST choose exactly one of: \"breakfast\", \"lunch\", \"dinner\", or \"snack\" — no other values.";

  const body = {
    model: VISION_MODEL,
    // Responses API supports vision content parts like input_text + input_image. :contentReference[oaicite:1]{index=1}
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              systemPrompt +
              "\n\nHere is a photo of my meal. Assume it's 1 serving for me. " +
              "Estimate total calories and macros. If something is unclear, " +
              "mention uncertainty instead of asking questions.",
          },
          {
            type: "input_image",
            image_url: url, // data:image/jpeg;base64,...
          },
        ],
      },
    ],
    temperature: 0.3,
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawText = await resp.text();

  if (!resp.ok) {
    // include status + a snippet of the body for debugging in Vercel logs
    throw new Error(
      `OpenAI error ${resp.status}: ${rawText.slice(0, 1200)}`
    );
  }

  const data = JSON.parse(rawText);

  // Many Responses return output_text directly (as in docs). :contentReference[oaicite:2]{index=2}
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  // Fallback: attempt to extract from output array
  try {
    const out = data.output || [];
    for (const item of out) {
      const content = item?.content || [];
      for (const part of content) {
        if (part?.type === "output_text" && typeof part?.text === "string") {
          return part.text;
        }
      }
    }
  } catch (_) {}

  return "";
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
    console.error("Failed to parse LOG_JSON:", e);
    return null;
  }
}

function stripLogJsonBlock(text) {
  if (!text) return "";
  const start = text.indexOf("[[LOG_JSON");
  if (start === -1) return text.trim();
  const end = text.indexOf("]]", start);
  if (end === -1) return text.trim();
  return (text.slice(0, start) + text.slice(end + 2)).trim();
}

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://www.pjifitness.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
        "Please set OPENAI_API_KEY in the Vercel project environment variables.",
      reply_clean:
        "I couldn't estimate that meal because the AI key isn't configured. " +
        "Please set OPENAI_API_KEY in the Vercel project environment variables.",
      log_json: null,
    });
  }

  try {
    const { image_base64, email, customerId } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 is required" });
    }

    console.log("Photo estimate request:", { email, customerId });
    console.log(
      "image_base64 prefix:",
      String(image_base64).slice(0, 60)
    );

    let fullReply = "";
    let logJson = null;

    try {
      fullReply = await callOpenAIVisionResponses(image_base64);
      logJson = extractLogJson(fullReply);
    } catch (err) {
      console.error("OpenAI vision call failed:", err);
      fullReply =
        "I tried to estimate that meal from the photo, but something went wrong on my end. " +
        "For now, describe the meal in text and I’ll estimate it that way.";
      logJson = null;
    }

    const replyClean = stripLogJsonBlock(fullReply);

    return res.status(200).json({
  reply: fullReply,
  reply_clean: replyClean,
  log_json: logJson,

  // ✅ Add these for frontend compatibility
  meals: (logJson && Array.isArray(logJson.meals)) ? logJson.meals : [],
  date: logJson?.date || null
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
      log_json: null,
    });
  }
}
