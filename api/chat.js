const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // PJiFitness Assistant
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  // CORS
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

    // Allow text OR image OR both
    if ((!message || typeof message !== "string") && !imageBase64) {
      return res
        .status(400)
        .json({ error: "Message or imageBase64 is required" });
    }

    const baseHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    const assistantHeaders = {
      ...baseHeaders,
      "OpenAI-Beta": "assistants=v2",
    };

    let thread_id = threadId;

    // 1️⃣ Create thread if needed
    if (!thread_id) {
      const threadRes = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: assistantHeaders,
        body: JSON.stringify({}),
      });

      const threadJson = await threadRes.json();
      if (!threadRes.ok) {
        console.error("Thread create error:", threadJson);
        throw new Error("Failed to create thread");
      }

      thread_id = threadJson.id;
    }

    // 2️⃣ Build user message content (text + optional image)
    const userContent = [];

    if (message && typeof message === "string") {
      userContent.push({
        type: "input_text",
        text: message,
      });
    }

    if (imageBase64) {
      // Send the browser data URL directly
      userContent.push({
        type: "input_image_url",
        image_url: { url: imageBase64 },
      });
    }

    if (userContent.length === 0) {
      return res.status(400).json({
        error: "No valid message or image to send to the assistant.",
      });
    }

    // 3️⃣ Add user message to thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: userContent,
      }),
    });

    // 4️⃣ Extra instructions to STOP onboarding loop + handle images
    const extraInstructions = `
You are the PJiFitness AI coach.

IMPORTANT BEHAVIOR RULES:
- Users sometimes upload IMAGES along with text.
  - If an image is present, ALWAYS analyze it first.
  - If it looks like a NUTRITION LABEL: read the label and extract serving size, calories per serving, protein, carbs, fats, and anything else important. Answer their question about it.
  - If it looks like a MEAL / PLATE OF FOOD: estimate calories, macros, and portion sizes, and give simple coaching suggestions and lower-calorie swaps.
  - Tell the user that calorie estimates from photos are approximate.

- ONBOARDING (start_weight, goal_weight, age, activity level) should happen ONLY ONCE per thread:
  - If the conversation history already includes their basic profile (start weight, goal weight, age, activity level), DO NOT ask for onboarding questions again unless the user explicitly says they want to restart or change their goals.
  - Do NOT re-ask onboarding questions when they log daily stats or ask general questions.

- DAILY LOGS are messages like:
  - "weight: 190, calories: 2100, steps: 8500, mood: good, struggle: cravings"
  - When you see a daily log, respond like a coach: reflect what they did, normalize normal weight fluctuations, and give 1–3 simple, specific suggestions for the next 24 hours.
  - Do NOT treat daily logs as onboarding.

- GENERAL QUESTIONS (e.g. "What's the weather", "Why am I bloated", "Can you read this label?"):
  - Answer directly and naturally as a coach.
  - Do NOT go back into onboarding mode unless they clearly ask to restart their plan or change goals.
`.trim();

    // 5️⃣ Start assistant run with extra instructions
    const runRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        method: "POST",
        headers: assistantHeaders,
        body: JSON.stringify({
          assistant_id: ASSISTANT_ID,
          instructions: extraInstructions,
        }),
      }
    );

    const runJson = await runRes.json();
    if (!runRes.ok) {
      console.error("Run start error:", runJson);
      throw new Error("Failed to start run");
    }

    const runId = runJson.id;

    // 6️⃣ Poll until run completes
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${runId}`,
        {
          method: "GET",
          headers: assistantHeaders,
        }
      );
      const statusJson = await statusRes.json();

      if (statusJson.status === "completed") break;

      if (["failed", "cancelled", "expired"].includes(statusJson.status)) {
        console.error("Run failed status:", statusJson);
        throw new Error("Run failed");
      }

      await sleep(1000);
    }

    // 7️⃣ Get latest assistant reply
    const msgsRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      { method: "GET", headers: assistantHeaders }
    );
    const msgsJson = await msgsRes.json();

    const assistantMsg = msgsJson.data.find((m) => m.role === "assistant");
    const reply =
      assistantMsg?.content?.[0]?.text?.value ||
      "Something went wrong. Please try again.";

    // 8️⃣ DAILY LOG + USER PROFILE extraction for Make.com
    let extractedLog = null;
    let extractedProfile = null;

    const msgText = message || "";

    // Only treat as onboarding when explicit onboarding-style labels are present
    const isUserProfile =
      /start_weight:/i.test(msgText) ||
      /goal_weight:/i.test(msgText) ||
      /activity_level:/i.test(msgText) ||
      /age:/i.test(msgText);

    // Daily log detection: user is logging a check-in
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
              temperature: 0,
              messages: [
                {
                  role: "system",
                  content: `
You are a strict JSON formatter for a fitness coaching app.

The user message contains a "daily log" with some of:
email, weight, calories, steps, mood, feeling, struggle, focus, flag.

Rules:
1. Extract fields if present.
2. Missing fields = null.
3. "flag" must be boolean (true/false) or null if unclear.
4. Return ONLY valid JSON, no extra text.

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
                `.trim(),
                },
                { role: "user", content: msgText },
              ],
            }),
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
            flag:
              typeof parsed.flag === "boolean"
                ? parsed.flag
                : null,
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
              temperature: 0,
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
3. Suggest a program_name based on their goal and activity level.
   Use exactly one of:
   - "Fat loss – 3 day dumbbell"
   - "Fat loss – 4 day dumbbell"
   - "Recomp – 3 day dumbbell"
   - "Strength – 4 day dumbbell"
4. Set "week" to 1.
5. plan_json must be null.
6. Return ONLY valid JSON, no extra text:

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
                `.trim(),
                },
                { role: "user", content: msgText },
              ],
            }),
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
            plan_json: null,
          };
        }
      } catch (e) {
        console.error("JSON extraction error (user_profile):", e);
      }
    }

    // 9️⃣ Send to Make.com
    if (MAKE_WEBHOOK_URL) {
      try {
        let payload;

        if (extractedLog) {
          payload = {
            type: "daily_log",
            ...extractedLog,
            threadId: thread_id,
            timestamp: new Date().toISOString(),
          };
        } else if (extractedProfile) {
          payload = {
            type: "user_profile",
            ...extractedProfile,
            threadId: thread_id,
            timestamp: new Date().toISOString(),
          };
        } else {
          payload = {
            type: "chat",
            email: email || null,
            message: msgText || "",
            reply,
            threadId: thread_id,
            hasImage: !!imageBase64,
            timestamp: new Date().toISOString(),
          };
        }

        await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        console.error("Make.com webhook error:", e);
      }
    }

    // 🔟 Return reply to frontend
    return res.status(200).json({
      reply,
      threadId: thread_id,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({
      error: err.message || "Server error",
    });
  }
}
