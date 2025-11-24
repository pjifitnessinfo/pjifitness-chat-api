const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // PJiFitness Assistant
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
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
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    const body = req.body || {};
    const { message, threadId, email, imageBase64 } = body;

    if ((!message || typeof message !== "string") && !imageBase64) {
      return res.status(400).json({ error: "Message or imageBase64 is required" });
    }

    const baseHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };

    const assistantHeaders = {
      ...baseHeaders,
      "OpenAI-Beta": "assistants=v2"
    };

    let thread_id = threadId;

    // 1️⃣ Create thread
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

    // 2️⃣ Build message content (text + optional image)
    const userContent = [];

    if (message && typeof message === "string") {
      userContent.push({
        type: "input_text",
        text: message
      });
    }

    if (imageBase64) {
      userContent.push({
        type: "input_image_url",
        image_url: { url: imageBase64 }   // <-- Direct data URL (NO upload needed)
      });
    }

    // 3️⃣ Add message to thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: userContent
      })
    });

    // 4️⃣ Run assistant
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

    // 7️⃣ Extract Daily Log / Profile
    let extractedLog = null;
    let extractedProfile = null;

    const msgText = message || "";

    const isUserProfile =
      /start_weight:/i.test(msgText) ||
      /goal_weight:/i.test(msgText) ||
      /activity_level:/i.test(msgText) ||
      /age:/i.test(msgText);

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

    // DAILY LOG block
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
You strictly output JSON for a daily fitness log.
Missing fields = null. "flag" must be true/false.

JSON format:
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
                `
              },
              { role: "user", content: msgText }
            ],
            temperature: 0
          })
        });

        const jsonData = await jsonRes.json();
        const jsonText = jsonData?.choices?.[0]?.message?.content;

        if (jsonText) {
          const parsed = JSON.parse(jsonText);

          if (!parsed.email) parsed.email = email || null;

          extractedLog = parsed;
        }
      } catch (e) {}
    }

    // PROFILE block
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
Extract onboarding info into JSON:
Missing fields = null.
Pick program_name based on goal & activity.

JSON:
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
                `
              },
              { role: "user", content: msgText }
            ],
            temperature: 0
          })
        });

        const jsonData = await jsonRes.json();
        const jsonText = jsonData?.choices?.[0]?.message?.content;

        if (jsonText) {
          const parsed = JSON.parse(jsonText);

          if (!parsed.email) parsed.email = email || null;

          extractedProfile = parsed;
        }
      } catch (e) {}
    }

    // 8️⃣ Make.com Webhook
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
            message: msgText || "",
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
        console.error("Webhook error:", e);
      }
    }

    // 9️⃣ Response back to frontend
    return res.status(200).json({
      reply,
      threadId: thread_id
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({
      error: err.message || "Server error"
    });
  }
}
