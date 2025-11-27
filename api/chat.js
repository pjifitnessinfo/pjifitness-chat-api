// /api/chat.js

const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // your PJiFitness assistant

// Optional: still send data to Make.com if you want
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🔸 Run-level instructions (short, just for wiring + DAILY_LOG behavior)
// Your main coaching behavior now lives in the Assistant instructions you pasted in UI.
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

The frontend will often prefix messages with something like:
"user_email: person@example.com"

Use that as the user's email / identity whenever possible.

Your main coaching behavior, tone, and detailed rules live in your main system
instructions. This run-level instruction only adds:

1) How to handle the FIRST-TIME ONBOARDING FLOW
2) How to handle END-OF-DAY DAILY_LOG blocks for the backend

=====================================
A) FIRST-TIME / ONBOARDING FLOW
=====================================

Goal: when someone is new (or says they are starting fresh), you should walk
them through a short, structured "Start Here" helper BEFORE you show a normal
daily checklist.

Signs they are new:
- They say things like "I'm new", "first time", "start here", "set me up", etc.
- There is no earlier context in this thread showing you've already collected
  start weight, goal weight, or calorie targets.
- You have not already given them an onboarding summary in this thread.

When you detect that, do this:

1) Explain briefly how PJiFitness works in 2–3 short bullets:
   - We track weight + calories + steps + consistency.
   - We use that data to adjust the plan over time.
   - You can check in daily with quick logs.

2) Ask 3–6 targeted questions one group at a time (don’t dump a huge list):
   - Current weight (and, if they know it, approximate height)
   - Goal weight (or main goal if not scale-related)
   - Rough timeline / urgency (slow and steady vs more aggressive)
   - A typical day of eating (very high level)
   - Typical steps or activity level

3) CALORIE GOAL (IMPORTANT)
   - Use their answers + your main system rules to suggest a daily calorie
     target and a simple protein goal.
   - Be explicit: e.g. "Target: 2,100 kcal per day, ~180g protein."
   - Also suggest a simple step target (for most people 7k–10k is a good start).

4) ONBOARDING SUMMARY
   - Give a short summary:
     - Start weight / goal weight
     - Daily calorie target
     - Protein target
     - Step target
   - Finish with very clear instructions on how they should check in each day
     (weight, calories, steps, quick notes/mood).

After this onboarding is complete in a thread, you no longer repeat the
full "Start Here" helper. Switch into normal daily coaching and daily
check-ins for that user in this thread.

Do NOT output any DAILY_LOG during the middle of onboarding questions.
Only use DAILY_LOG when the day is actually being closed out (see below).

=====================================
B) END-OF-DAY LOGGING (VERY IMPORTANT)
=====================================

When the user clearly indicates THE DAY IS FINISHED with phrases such as:
- "end of day"
- "summarize today"
- "save today"
- "daily log"
- "log today"
- "can you save this for today"
(or anything obviously meaning the day is DONE)

You MUST output a DAILY_LOG block at the END of your reply, using EXACTLY
this structure:

DAILY_LOG:
user_id: unknown
date: YYYY-MM-DD
weight:
calories:
steps:
mood:
feeling:
main_struggle:
coach_focus:
flag:

Rules:
- Use plain text only. No backticks, no code fences, no extra tags around it.
- Keys must appear exactly as shown (same spelling & order).
- If you don't know a value, leave it blank after the colon.
- "flag" must be either "true" or "false" (lowercase).
- The rest of your reply should be normal coaching (summary + next steps).

Only include this DAILY_LOG block when you are closing out the day
OR when the user explicitly asks to save / summarize today.
Do NOT include DAILY_LOG for every message.
`.trim();

export default async function handler(req, res) {
  // ✅ CORS for Shopify + browser
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

    // 🔹 Accept email from multiple possible fields
    const {
      message,
      threadId,
      email,
      imageBase64,
      customerId,
      userEmail,
      userId,
      user_id,
    } = body;

    const resolvedEmail =
      (email || userEmail || userId || user_id || customerId || "").toLowerCase() ||
      null;

    // 🔹 Require at least some text or an image
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
      if (!threadRes.ok) throw new Error("Failed to create thread");
      thread_id = threadJson.id;
    }

    // 2️⃣ Build message content for the thread (prepend email meta)
    const originalText = message || "";
    const assistantText = resolvedEmail
      ? `user_email: ${resolvedEmail}\n${originalText}`
      : originalText;

    let userContent;

    if (imageBase64) {
      const blocks = [];

      blocks.push({
        type: "input_text",
        text: assistantText || "Here is an image for you to analyze.",
      });

      blocks.push({
        type: "input_image_url",
        image_url: { url: imageBase64 }, // frontend sends data URL (base64)
      });

      userContent = blocks;
    } else {
      userContent = assistantText;
    }

    // 3️⃣ Add user message
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: userContent,
      }),
    });

    // 4️⃣ Run assistant with run-level instructions
    const runRes = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        method: "POST",
        headers: assistantHeaders,
        body: JSON.stringify({
          assistant_id: ASSISTANT_ID,
          instructions: RUN_INSTRUCTIONS,
        }),
      }
    );

    const runJson = await runRes.json();
    if (!runRes.ok) throw new Error("Failed to start run");
    const runId = runJson.id;

    // 5️⃣ Poll until run completes
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

    // 7️⃣ Parse DAILY_LOG block (new format)
    // We look for the line "DAILY_LOG:" and then read subsequent "key: value" lines.
    let extractedLog = null;

    const dlIndex = reply.indexOf("DAILY_LOG:");
    if (dlIndex !== -1) {
      const after = reply.slice(dlIndex + "DAILY_LOG:".length);
      const lines = after.split("\n");

      const logObj = {
        user_id: null,
        date: null,
        weight: null,
        calories: null,
        steps: null,
        mood: null,
        feeling: null,
        main_struggle: null,
        coach_focus: null,
        flag: null,
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) {
          // first non "key: value" line = end of the block
          break;
        }

        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();

        switch (key) {
          case "user_id":
            logObj.user_id = value || null;
            break;
          case "date":
            logObj.date = value || null;
            break;
          case "weight":
            logObj.weight = value ? parseFloat(value) : null;
            break;
          case "calories":
            logObj.calories = value ? parseInt(value, 10) : null;
            break;
          case "steps":
            logObj.steps = value ? parseInt(value, 10) : null;
            break;
          case "mood":
            logObj.mood = value || null;
            break;
          case "feeling":
            logObj.feeling = value || null;
            break;
          case "main_struggle":
            logObj.main_struggle = value || null;
            break;
          case "coach_focus":
            logObj.coach_focus = value || null;
            break;
          case "flag": {
            const v = value.toLowerCase();
            if (v === "true") logObj.flag = true;
            else if (v === "false") logObj.flag = false;
            else logObj.flag = null;
            break;
          }
          default:
            // ignore unknown keys
            break;
        }
      }

      // Fallbacks: email + date
      const emailForLog = resolvedEmail || null;
      if (!logObj.date) {
        logObj.date = new Date().toISOString().slice(0, 10);
      }

      if (emailForLog) {
        extractedLog = {
          email: emailForLog,
          ...logObj,
        };
      }
    }

    // 8️⃣ Save DAILY LOG to your /api/save-daily-log endpoint (Shopify metaobject)
    if (extractedLog && extractedLog.email) {
      try {
        await fetch(
          "https://pjifitness-chat-api.vercel.app/api/save-daily-log",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: extractedLog.email,
              log: {
                date: extractedLog.date,
                weight: extractedLog.weight,
                calories: extractedLog.calories,
                steps: extractedLog.steps,
                mood: extractedLog.mood,
                feeling: extractedLog.feeling,
                main_struggle: extractedLog.main_struggle,
                coach_focus: extractedLog.coach_focus,
                flag: extractedLog.flag,
                // meals can be added later if you decide to include it in the DAILY_LOG
              },
            }),
          }
        );
      } catch (e) {
        console.error("save-daily-log error:", e);
      }
    }

    // 9️⃣ Optional: send info to Make.com
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
        } else {
          payload = {
            type: "chat",
            email: resolvedEmail,
            message: originalText,
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

    // 🔟 Return assistant reply + threadId to frontend
    return res.status(200).json({ reply, threadId: thread_id });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
