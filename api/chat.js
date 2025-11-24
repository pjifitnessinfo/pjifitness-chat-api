const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // your PJiFitness assistant

// ✅ Make.com Webhook URL
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  // ✅ Allow CORS for Shopify and browsers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ success: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  try {
    const body = req.body || {};
    const { message, threadId, email, imageBase64, imageName } = body;

    // ⛔ Now we allow EITHER a message, OR an image, OR both
    if (
      (!message || typeof message !== "string") &&
      !imageBase64
    ) {
      return res
        .status(400)
        .json({ error: "Message or imageBase64 is required" });
    }

    // Base headers for OpenAI JSON endpoints
    const baseHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };

    // Headers for Assistants API
    const assistantHeaders = {
      ...baseHeaders,
      "OpenAI-Beta": "assistants=v2"
    };

    let thread_id = threadId;

    // 1️⃣ Create new thread if needed
    if (!thread_id) {
      const threadRes = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: assistantHeaders,
        body: JSON.stringify({})
      });

      const threadJson = await threadRes.json();
      if (!threadRes.ok) throw new Error("Failed to create thread");
      thread_id = threadJson.id;
    }

    // 2️⃣ If we got an imageBase64, upload it as a "vision" file to OpenAI
    let imageFileId = null;

    if (imageBase64) {
      try {
        // handle both "data:image/png;base64,XXXX" and raw base64
        const base64Data = imageBase64.includes("base64,")
          ? imageBase64.split("base64,")[1]
          : imageBase64;

        const buffer = Buffer.from(base64Data, "base64");

        const formData = new FormData();
        const fileName = imageName || "upload.jpg";

        formData.append("file", new Blob([buffer]), fileName);
        formData.append("purpose", "vision");

        const fileRes = await fetch("https://api.openai.com/v1/files", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}` // ❗ do NOT set Content-Type manually here
          },
          body: formData
        });

        const fileJson = await fileRes.json();
        if (!fileRes.ok) {
          console.error("Image upload failed:", fileJson);
          throw new Error("Failed to upload image to OpenAI");
        }

        imageFileId = fileJson.id;
      } catch (e) {
        console.error("Image upload error:", e);
      }
    }

    // 3️⃣ Build the user message content: text + optional image
    const userContent = [];

    if (message && typeof message === "string") {
      userContent.push({
        type: "input_text",
        text: message
      });
    }

    if (imageFileId) {
      userContent.push({
        type: "input_image_file",
        image_file: { file_id: imageFileId }
      });
    }

    if (userContent.length === 0) {
      return res.status(400).json({
        error: "No valid message or image to send to the assistant."
      });
    }

    // 4️⃣ Add user message (with optional image) to the thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: userContent
      })
    });

    // 5️⃣ Run assistant
    const runRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        method: "POST",
        headers: assistantHeaders,
        body: JSON.stringify({ assistant_id: ASSISTANT_ID })
      }
    );

    const runJson = await runRes.json();
    if (!runRes.ok) throw new Error("Failed to start run");
    const runId = runJson.id;

    // 6️⃣ Poll until complete
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${runId}`,
        { headers: assistantHeaders }
      );
      const statusJson = await statusRes.json();

      if (statusJson.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(statusJson.status)) {
        throw new Error("Run failed");
      }

      await sleep(1000);
    }

    // 7️⃣ Fetch assistant reply
    const msgsRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      { headers: assistantHeaders }
    );
    const msgsJson = await msgsRes.json();
    const assistantMsg = msgsJson.data.find((m) => m.role === "assistant");
    const reply =
      assistantMsg?.content?.[0]?.text?.value ||
      "Something went wrong. Please try again.";

    // 8️⃣ Detect DAILY LOG + USER PROFILE + extract structured fields for Make
    let extractedLog = null;
    let extractedProfile = null;

    const msgText = message || "";

    // ✅ FIRST: detect USER PROFILE from onboarding labels
    const isUserProfile =
      /start_weight:/i.test(msgText) ||
      /goal_weight:/i.test(msgText) ||
      /activity_level:/i.test(msgText) ||
      /age:/i.test(msgText);

    // ✅ THEN: detect DAILY LOG, but ONLY if it's NOT a profile
    const isDailyLog =
      !isUserProfile &&
      (/\bweight:/i.test(msgText) ||
        /calories:/i.test(msgText) ||
        /steps:/i.test(msgText) ||
        /mood:/i.test(msgText) ||
        /feeling:/i.test(msgText) ||
        /struggle:/i.test(msgText) ||
        /focus:/i.test(msgText) ||
        /flag:/i.test(msgText));

    // ---- DAILY LOG JSON extraction ----
    if (isDailyLog) {
      try {
        const jsonRes = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: baseHeaders,
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content: `
You are a strict JSON formatter for a fitness coaching app.

The user will send a "daily log" including:
email, weight, calories, steps, mood, feeling, struggle, focus, flag.

Rules:
1. Extract fields if present.
2. Missing fields = null.
3. "flag" must be boolean (true/false).
4. Return ONLY valid JSON.

JSON shape:
{
  "email": string | null,
  "weight": number | null,
  "calories": number | null,
  "steps": number | null,
  "mood": string | null,
  "feeling": string | null,
  "struggle": string | null,
  "focus": string | null,
  "flag": boolean | null
}
                  `.trim()
                },
                { role: "user", content: msgText }
              ],
              temperature: 0
            })
          }
        );

        const jsonData = await jsonRes.json();
        const jsonText = jsonData?.choices?.[0]?.message?.content || null;

        if (jsonText) {
          const parsed = JSON.parse(jsonText);

          if (!parsed.email) parsed.email = email || null;

          extractedLog = {
            email: parsed.email ?? null,
            weight: parsed.weight ?? null,
            calories: parsed.calories ?? null,
            steps: parsed.steps ?? null,
            mood: parsed.mood ?? null,
            feeling: parsed.feeling ?? null,
            struggle: parsed.struggle ?? null,
            focus: parsed.focus ?? null,
            flag: typeof parsed.flag === "boolean" ? parsed.flag : null
          };
        }
      } catch (e) {
        console.error("JSON extraction error (daily_log):", e);
      }
    }

    // ---- USER PROFILE JSON extraction (onboarding) ----
    if (isUserProfile) {
      try {
        const jsonRes = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: baseHeaders,
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content: `
You are a strict JSON formatter for onboarding a fitness coaching client.

The user message may include:
- email
- start_weight
- goal_weight
- age
- activity_level (sedentary, light, moderate, high, athlete)

Tasks:
1. Extract these fields.
2. If something is missing, set it to null.
3. Suggest a strength program_name based on their goal and activity level.
   Use one of these strings:
   - "Fat loss – 3 day dumbbell"
   - "Fat loss – 4 day dumbbell"
   - "Recomp – 3 day dumbbell"
   - "Strength – 4 day dumbbell"
4. Set "week" to 1.
5. plan_json should be null for now.
6. Return ONLY valid JSON with this shape:

{
  "email": string | null,
  "start_weight": number | null,
  "goal_weight": number | null,
  "age": number | null,
  "activity_level": string | null,
  "program_name": string | null,
  "week": number | null,
  "plan_json": null
}
                  `.trim()
                },
                { role: "user", content: msgText }
              ],
              temperature: 0
            })
          }
        );

        const jsonData = await jsonRes.json();
        const jsonText = jsonData?.choices?.[0]?.message?.content || null;

        if (jsonText) {
          const parsed = JSON.parse(jsonText);

          if (!parsed.email) parsed.email = email || null;

          extractedProfile = {
            email: parsed.email ?? null,
            start_weight: parsed.start_weight ?? null,
            goal_weight: parsed.goal_weight ?? null,
            age: parsed.age ?? null,
            activity_level: parsed.activity_level ?? null,
            program_name: parsed.program_name ?? null,
            week: parsed.week ?? 1,
            plan_json: parsed.plan_json ?? null
          };
        }
      } catch (e) {
        console.error("JSON extraction error (user_profile):", e);
      }
    }

    // 9️⃣ Send log/profile/chat to Make.com
    if (MAKE_WEBHOOK_URL) {
      try {
        let payload;

        if (extractedLog) {
          payload = {
            type: "daily_log",
            ...extractedLog,
            threadId: thread_id,
            timestamp: new Date().toISOString()
          };
        } else if (extractedProfile) {
          payload = {
            type: "user_profile",
            ...extractedProfile,
            threadId: thread_id,
            timestamp: new Date().toISOString()
          };
        } else {
          payload = {
            type: "chat",
            email: email || null,
            message: msgText || null,
            reply,
            threadId: thread_id,
            hasImage: !!imageFileId,
            timestamp: new Date().toISOString()
          };
        }

        await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        console.error("Make.com webhook error:", e);
      }
    }

    // 🔟 Return response to frontend
    return res.status(200).json({ reply, threadId: thread_id });
  } catch (err) {
    console.error("Handler error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Server error" });
  }
}
