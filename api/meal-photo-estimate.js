// /api/meal-photo-estimate.js
// TEMP VERSION: confirm photo endpoint works end-to-end, with CORS enabled.
// No OpenAI call yet — returns a simple test reply.

const ALLOWED_ORIGIN = "https://www.pjifitness.com";

export default async function handler(req, res) {
  // Basic CORS headers
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

  try {
    const { image_base64, email, customerId } = req.body || {};

    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 is required" });
    }

    console.log("Photo estimate TEST hit from:", { email, customerId });
    console.log("image_base64 starts with:", image_base64.slice(0, 50));

    const reply =
      "TEST: I received your meal photo and the endpoint is working. " +
      "Next, we’ll plug in AI to estimate calories and macros from the image.";

    const logJson = {
      date: new Date().toISOString().slice(0, 10),
      meals: [
        {
          type: "dinner",
          description: "TEST meal from photo endpoint",
          calories: 500,
          protein_g: 30,
          carbs_g: 40,
          fat_g: 20,
          source: "photo_estimate_test"
        }
      ]
    };

    return res.status(200).json({
      reply,
      log_json: logJson
    });
  } catch (err) {
    console.error("meal-photo-estimate TEST error:", err);
    return res.status(500).json({
      error: "Photo estimate test failed",
      details: String(err)
    });
  }
}
