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
    const { message, threadId, email, imageBase64 } = body;

    // 🔹 We require at least text or an image
    if ((!message || typeof message !== "string") && !imageBase64) {
      return res.status(400).json({ error: "Message or imageBase64 is required" });
    }

    // Base headers for OpenAI
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

    // 2️⃣ Build message content for the thread
    //
    // IMPORTANT:
    // - If there is NO image, we send a plain string (exactly like original code).
    // - If there IS an image, we send an array of content blocks: text + image.
    //   This keeps old behavior intact and only changes behavior when an image is attached.
    let userContent;

    if (imageBase64) {
      const blocks = [];

      if (message && typeof message === "string") {
        blocks.push({
          type: "input_text",
          text: message
        });
      }

      blocks.push({
        type: "input_image_url",
        image_url: { url: imageBase64 } // frontend sends a data URL (base64)
      });

      userContent = blocks;
    } else {
      // Legacy behavior (no images) — keep exactly as before
      userContent = message;
    }

    // 3️⃣ Add user message to the thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: userContent
      })
    });

    // 4️⃣ Run assistant (no extra backend instructions – it uses the PJ instructions you set)
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });

    const runJson = await runRes.json();
    if (!runRes.ok) throw new Error("Failed to start run");
    const runId = runJson.id;

    // 5️⃣ Poll until complete
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

    // 6️⃣ Fetch assistant reply
    const msgsRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      { headers: assistantHeaders }
    );
    const msgsJson = await msgsRes.json();
    const assistantMsg = msgsJson.data.find((m) => m.role === "assistant");
    const reply =
      assistantMsg?.content?.[0]?.text?.value ||
      "Something went wrong. Please try again.";

    // 7️⃣ Detect DAILY LOG + USER PROFILE + extract structured fields for Make / saving
    let extractedLog = null;
    let extractedProfile = null;

    const textForParsing = message || "";

    // ✅ FIRST: detect USER PROFILE from onboarding labels
    const isUserProfile =
      /start_weight:/i.test(textForParsing) ||
      /goal_weight:/i.test(textForParsing) ||
      /activity_level:/i.test(textForParsing) ||
      /age:/i.test(textForParsing);

    // ✅ THEN: detect DAILY LOG, but ONLY if it's NOT a profile
    const isDailyLog =
      !isUserProfile &&
      (
        /\bweight:/i.test(textForParsing) ||
        /calories:/i.test(textForParsing) ||
        /steps:/i.test(textForParsing) ||
        /mood:/i.test(textForParsing) ||
        /feeling:/i.test(textForParsing) ||
        /struggle:/i.test(textForParsing) ||
        /focus:/i.test(textForParsing) ||
        /flag:/i.test(textForParsing)
      );

    // ---- DAILY LOG JSON extraction ----
    if (isDailyLog) {
      try {
        const jsonRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
email, date, weight, calories, steps, meals, mood, feeling, struggle, focus, flag.

Rules:
1. Extract fields if present.
2. Missing fields = null.
3. "flag" must be boolean (true/false).
4. Return ONLY valid JSON.

JSON shape:
{
  "email": string | null,
  "date": string | null,
  "weight": number | null,
  "calories": number | null,
  "steps": number | null,
  "meals": string | null,
  "mood": string | null,
  "feeling": string | null,
  "struggle": string | null,
  "focus": string | null,
  "flag": boolean | null
}
                `.trim()
              },
              { role: "user", content: textForParsing }
            ],
            temperature: 0
          })
        });

        const jsonData = await jsonRes.json();
        const jsonText = jsonData?.choices?.[0]?.message?.content || null;

        if (jsonText) {
          const parsed = JSON.parse(jsonText);

          if (!parsed.email) parsed.email = email || null;

          extractedLog = {
            email: parsed.email ?? null,
            date: parsed.date ?? null,
            weight: parsed.weight ?? null,
            calories: parsed.calories ?? null,
            steps: parsed.steps ?? null,
            meals: parsed.meals ?? null,
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
        const jsonRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
              { role: "user", content: textForParsing }
            ],
            temperature: 0
          })
        });

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

    // 8️⃣ Save DAILY LOG to your own API for the dashboard
    if (extractedLog && extractedLog.email) {
      try {
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const dateToUse = extractedLog.date || today;

        await fetch("https://pjifitness-chat-api.vercel.app/api/save-daily-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: extractedLog.email,
            date: dateToUse,
            weight: extractedLog.weight,
            calories: extractedLog.calories,
            steps: extractedLog.steps,
            meals: extractedLog.meals,
            mood: extractedLog.mood,
            struggle: extractedLog.struggle,
            coach_focus: extractedLog.focus, // map "focus" -> "coach_focus"
            flag: extractedLog.flag
          })
        });
      } catch (e) {
        console.error("save-daily-log error:", e);
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
            message: textForParsing,
            reply,
            threadId: thread_id,
            hasImage: !!imageBase64,
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
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
