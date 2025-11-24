const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // your PJiFitness assistant

// ⬇️ PASTE YOUR MAKE.COM WEBHOOK URL HERE
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq
";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  // Allow calls from your Shopify site
  res.setHeader("Access-Control-Allow-Origin", "*");
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
    const { message, threadId, email } = body; // email is optional for later

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "assistants=v2"
    };

    let thread_id = threadId;

    // 1) Create thread if none
    if (!thread_id) {
      const threadRes = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers,
        body: JSON.stringify({})
      });

      const threadJson = await threadRes.json();
      if (!threadRes.ok) {
        console.error("Thread error:", threadJson);
        return res.status(500).json({ error: "Failed to create thread" });
      }

      thread_id = threadJson.id;
    }

    // 2) Add user message
    const msgRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          role: "user",
          content: message
        })
      }
    );

    const msgJson = await msgRes.json();
    if (!msgRes.ok) {
      console.error("Message error:", msgJson);
      return res.status(500).json({ error: "Failed to add message" });
    }

    // 3) Create run
    const runRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          assistant_id: ASSISTANT_ID
        })
      }
    );

    const runJson = await runRes.json();
    if (!runRes.ok) {
      console.error("Run error:", runJson);
      return res.status(500).json({ error: "Failed to start run" });
    }

    const runId = runJson.id;

    // 4) Poll until completed
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${runId}`,
        {
          method: "GET",
          headers
        }
      );
      const statusJson = await statusRes.json();

      if (!statusRes.ok) {
        console.error("Status error:", statusJson);
        return res
          .status(500)
          .json({ error: "Failed to check run status" });
      }

      if (statusJson.status === "completed") {
        break;
      }

      if (
        statusJson.status === "failed" ||
        statusJson.status === "cancelled" ||
        statusJson.status === "expired"
      ) {
        console.error("Run failed:", statusJson);
        return res
          .status(500)
          .json({ error: "Run did not complete", details: statusJson });
      }

      await sleep(1000);
    }

    // 5) Get latest assistant message
    const msgsRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      {
        method: "GET",
        headers
      }
    );
    const msgsJson = await msgsRes.json();

    if (!msgsRes.ok) {
      console.error("Messages list error:", msgsJson);
      return res.status(500).json({ error: "Failed to list messages" });
    }

    const assistantMsg = msgsJson.data.find((m) => m.role === "assistant");

    const reply =
      assistantMsg &&
      assistantMsg.content &&
      assistantMsg.content[0] &&
      assistantMsg.content[0].text &&
      assistantMsg.content[0].text.value
        ? assistantMsg.content[0].text.value
        : "Something went wrong. Please try again.";

    // 6) 🔗 Send a copy of this log to Make.com (for Google Sheets)
    if (MAKE_WEBHOOK_URL && MAKE_WEBHOOK_URL.startsWith("http")) {
      try {
        const payload = {
          // Basic info we know right now
          email: email || null,         // later we can pass Shopify email into the request
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
      } catch (webhookErr) {
        console.error("Make.com webhook error:", webhookErr);
        // Don't crash the chat if the logging fails
      }
    } else {
      console.warn("MAKE_WEBHOOK_URL is not set or invalid.");
    }

    // 7) Return reply to the browser
    return res.status(200).json({ reply, threadId: thread_id });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
