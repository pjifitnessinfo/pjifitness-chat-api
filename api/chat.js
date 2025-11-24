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
    const { message, threadId, email } = body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
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

    // 2️⃣ Add user message to the thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: message
      })
    });

    // 3️⃣ Run assistant
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });

    const runJson = await runRes.json();
    if (!runRes.ok) throw new Error("Failed to start run");
    const runId = runJson.id;

    // 4️⃣ Poll until complete
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

    // 5️⃣ Fetch assistant reply
    const msgsRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      { headers: assistantHeaders }
    );
    const msgsJson = await msgsRes.json();
    const assistantMsg = msgsJson.data.find((m) => m.role === "assistant");
    const reply =
      assistantMsg?.content?.[0]?.text?.value ||
      "Something went wrong. Please try again.";

    // 6️⃣ Detect DAILY LOG + extract structured fields for Make
    let extractedLog = null;

    const isDailyLog =
      /weight:/i.test(message) ||
      /calories:/i.test(message) ||
      /steps:/i.test(message) ||
      /mood:/i.test(message) ||
      /struggle:/i.test(message) ||
      /focus:/i.test(message) ||
      /flag:/i.test(message);

    if (isDailyLog) {
      try {
        const jsonRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: baseHeaders, // standard chat completions headers
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `
You are a strict JSON formatter for a fitness coaching app.

The user will send a "daily log" message that may include:
- email
- weight
- calories
- steps
- mood
- struggle
- focus
- flag (yes/no, true/false)

Your job:
1. Extract these fields if present.
2. If any field is missing, set it to null.
3. "flag" must be a boolean (true or false).
4. Return ONLY valid JSON with NO extra text.

JSON shape:
{
  "email": string | null,
  "weight": number | null,
  "calories": number | null,
  "steps": number | null,
  "mood": string | null,
  "struggle": string | null,
  "focus": string | null,
  "flag": boolean | null
}
                `.trim()
              },
              {
                role: "user",
                content: message
              }
            ],
            temperature: 0
          })
        });

        const jsonData = await jsonRes.json();
        const jsonText = jsonData?.choices?.[0]?.message?.content || null;

        if (jsonText) {
          const parsed = JSON.parse(jsonText);

          // Make sure email is filled from request if missing
          if (!parsed.email) {
            parsed.email = email || null;
          }

          extractedLog = {
            email: parsed.email ?? null,
            weight: parsed.weight ?? null,
            calories: parsed.calories ?? null,
            steps: parsed.steps ?? null,
            mood: parsed.mood ?? null,
            struggle: parsed.struggle ?? null,
            focus: parsed.focus ?? null,
            flag: typeof parsed.flag === "boolean" ? parsed.flag : null
          };
        }
      } catch (e) {
        console.error("JSON extraction error:", e);
      }
    }

    // 7️⃣ Send log to Make.com
    if (MAKE_WEBHOOK_URL) {
      try {
        const payload = extractedLog
          ? {
              type: "daily_log",
              ...extractedLog,
              threadId: thread_id,
              timestamp: new Date().toISOString()
            }
          : {
              type: "chat",
              email: email || null,
              message,
              reply,
              threadId: thread_id,
              timestamp: new Date().toISOString()
            };

        await fetch(MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (e) {
        console.error("Make.com webhook error:", e);
      }
    }

    // 8️⃣ Return response to frontend
    return res.status(200).json({ reply, threadId: thread_id });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
