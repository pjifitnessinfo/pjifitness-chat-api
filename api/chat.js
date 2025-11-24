const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // your PJiFitness assistant

// ✅ Make.com Webhook URL — keep on ONE line
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  // ✅ Allow requests from your Shopify domain
  res.setHeader("Access-Control-Allow-Origin", "https://yourstore.myshopify.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
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

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2"
    };

    let thread_id = threadId;

    // 1️⃣ Create new thread if needed
    if (!thread_id) {
      const threadRes = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers,
        body: JSON.stringify({})
      });

      const threadJson = await threadRes.json();
      if (!threadRes.ok) throw new Error("Failed to create thread");

      thread_id = threadJson.id;
    }

    // 2️⃣ Add user message
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: "user",
        content: message
      })
    });

    // 3️⃣ Run assistant
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });

    const runJson = await runRes.json();
    if (!runRes.ok) throw new Error("Failed to start run");

    const runId = runJson.id;

    // 4️⃣ Poll until complete
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${runId}`,
        { headers }
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
      { headers }
    );
    const msgsJson = await msgsRes.json();
    const assistantMsg = msgsJson.data.find((m) => m.role === "assistant");
    const reply =
      assistantMsg?.content?.[0]?.text?.value ||
      "Something went wrong. Please try again.";

    // 6️⃣ Send log to Make.com
    if (MAKE_WEBHOOK_URL) {
      try {
        const payload = {
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

    // 7️⃣ Return response
    return res.status(200).json({ reply, threadId: thread_id });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
