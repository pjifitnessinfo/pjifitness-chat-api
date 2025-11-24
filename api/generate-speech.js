// /api/generate-speech.js
export default async function handler(req, res) {
  // 🔓 CORS (allows your Shopify site to call this endpoint)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text input" });

    // 🎤 Call OpenAI TTS (ONYX = best male-sounding voice)
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "onyx", // 🔥 MALE COACH VOICE
        format: "mp3",
        input: text,
        instructions:
          "Speak like a calm, confident male fitness coach. Clear, encouraging tone. Short, natural sentences.",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("TTS API Error:", errorText);
      return res.status(response.status).send(errorText);
    }

    // Convert returned audio to a playable MP3 buffer
    const audioBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(audioBuffer);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);

    // 🎧 SEND AUDIO BACK TO FRONTEND
    res.send(buffer);
  } catch (err) {
    console.error("TTS Error:", err);
    res.status(500).json({
      error: "Failed to generate speech",
      details: err.message || err,
    });
  }
}
