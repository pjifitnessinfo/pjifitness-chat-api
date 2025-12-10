// /api/meal-photo-estimate.js
// Endpoint to estimate calories from a meal photo.
// Does NOT write to Shopify yet — just returns a reply + optional LOG_JSON.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function callOpenAIVision(imageBase64DataUrl) {
  const body = {
    model: "gpt-4.1-mini", // or match whatever model you use in /api/chat.js
    messages: [
      {
        role: "system",
        content:
          "You are the PJiFitness AI Coach. The user sends you a PHOTO of their meal." +
          " Your job:" +
          " 1) Identify the foods and rough portion sizes." +
          " 2) Estimate TOTAL calories, plus approximate grams of protein, carbs, and fats." +
          " 3) Be honest about uncertainty (oils, sauces, hidden calories)." +
          " 4) Speak in a clear, friendly tone, 2–4 short paragraphs max." +
          " 5) At the very end, embed a LOG_JSON block in EXACTLY this format:\n" +
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
          "Use TODAY'S date in YYYY-MM-DD format. Use best-guess single numbers, not ranges."
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
            image_url: { url: imageBase64DataUrl }
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  try {
    const { image_base64, email, customerId } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 is required" });
    }

    console.log("Photo estimate request from:", { email, customerId });

    const fullReply = await callOpenAIVision(image_base64);
    const logJson = extractLogJson(fullReply);

    return res.status(200).json({
      reply: fullReply,
      log_json: logJson || null
    });
  } catch (err) {
    console.error("meal-photo-estimate error:", err);
    return res.status(500).json({
      error: "Photo estimate failed",
      details: String(err)
    });
  }
}
