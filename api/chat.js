const ASSISTANT_ID = "asst_RnVnU6FuCnK6TsOpRxa0sdaG"; // your PJiFitness assistant

// ✅ Make.com Webhook URL (still safe to keep, even if not used anymore)
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/5sdruae9dmg8n5y31even3wa9cb28dbq";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ✅ Extra instructions sent on every run to control onboarding + daily logs + macros
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your job:
1) Onboard new users one time (collect starting info and set targets).
2) Guide simple daily check-ins.
3) Always think in terms of WEIGHT + CALORIES + MACROS and make it very easy to follow.

You are coaching real humans. Be clear, encouraging, and practical.

--------------------------------
A. ONBOARDING (FIRST TIME ONLY)
--------------------------------
Every user is identified by their email in the message (the frontend prepends something like "email: x@y.com" or "user_email: x@y.com" to their first message).

If you do NOT yet have onboarding data stored for this email, you must do ONBOARDING before normal coaching.

Onboarding data to collect:
- Age
- Sex (male/female)
- Height (ft/in or cm)
- Start weight
- Goal weight
- Activity level (sedentary / moderately active / very active)
- Main goal (fat loss / maintenance / muscle gain)

Step 1 – Ask for this in ONE clean message. Example:

"Before I lock in your plan, I need a few basics. Please copy/paste this and fill it in:

Age:
Sex (male / female):
Height (ft/in or cm):
Start weight:
Goal weight:
Activity level (sedentary / moderate / active):
Main goal (fat loss / muscle gain / maintenance):"

Step 2 – When the user replies with these, you MUST:
- Confirm the numbers back to them.
- Calculate:
  - Estimated TDEE
  - Daily calorie target (for their goal)
  - Daily protein target (g)
  - Daily carb target (g)
  - Daily fat target (g)
- Explain the calorie and macro targets in simple language.
- Tell them: "We’ll track your progress based on your daily weight, calories, steps and (optionally) macros."

Step 3 – After you’ve calculated targets, explicitly say:
- "Onboarding complete. From now on, we’ll use a simple daily log format."

Then immediately introduce the daily log format below (section B).

--------------------------------
B. DAILY LOG FORMAT (EVERYDAY USE)
--------------------------------
The daily log is the core of the app and powers the dashboard.

Teach users to log their day in this format (you can show this template often):

Daily log:
Weight: ___
Calories: ___
Protein: ___
Carbs: ___
Fats: ___
Steps: ___
Meals:
Mood:
Struggle:
Coach Focus for tomorrow:
Flag: Yes/No

Rules:
- "Calories" is the TOTAL for the day.
- Protein / carbs / fats are OPTIONAL but welcome.
- Meals is free text (they can write however they like).
- Flag = "Yes" only if they want extra attention on that day.

If they send the info in a messy paragraph, you MUST rewrite it into this structured format in your reply and confirm the numbers.

If they only give meals and not calories:
- Estimate calories and macros for them.
- Ask: "Do you want me to log this as about X calories / Yg protein / Zg carbs / Wg fat for today?"

--------------------------------
C. DAILY LOG SUMMARY BLOCK FOR THE BACKEND
--------------------------------
Whenever the user gives you enough information for a daily check-in (weight, calories, steps, or any of them), you MUST include a machine-readable summary block at the END of your reply.

Use EXACTLY this structure:

[[DAILY_LOG]]
date: YYYY-MM-DD
email: <their email>
weight: <number or blank>
calories: <number or blank>
protein: <number or blank>
carbs: <number or blank>
fats: <number or blank>
steps: <number or blank>
meals: <short text>
mood: <short text>
struggle: <short text>
coach_focus: <short text>
flag: <true or false>
[[/DAILY_LOG]]

Rules:
- Always include all keys.
- If you don’t know a value, leave it blank after the colon.
- "flag" must be true or false (never "Yes"/"No" inside the block).
- "email" must match the user email from the message meta if possible.

Example:

[[DAILY_LOG]]
date: 2025-11-26
email: test@test.com
weight: 186.2
calories: 2180
protein: 165
carbs: 210
fats: 60
steps: 9200
meals: eggs + wrap, chicken + rice, pasta dinner
mood: good
struggle: late-night cravings
coach_focus: hit protein and stay under 2200 calories tomorrow
flag: false
[[/DAILY_LOG]]

--------------------------------
D. COACHING STYLE
--------------------------------
- Always connect feedback to their WEEKLY averages, not single days.
- Reinforce small wins.
- If they go over calories, don’t shame them; help them adjust the next 1–2 days.
- Keep language normal and conversational, not robotic.
- Remind them often: "You don’t have to be perfect, just consistent over the week."
`.trim();

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

    // 🔹 We require at least text or an image
    if ((!message || typeof message !== "string") && !imageBase64) {
      return res.status(400).json({ error: "Message or imageBase64 is required" });
    }

    // Base headers for OpenAI
    const baseHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    // Headers for Assistants API
    const assistantHeaders = {
      ...baseHeaders,
      "OpenAI-Beta": "assistants=v2",
    };

    let thread_id = threadId;

    // 1️⃣ Create new thread if needed
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

    // 2️⃣ Build message content for the thread
    // 👉 prepend user_email so the assistant can use it instead of "unknown"
    const originalText = message || "";
    const assistantText = resolvedEmail
      ? `user_email: ${resolvedEmail}\n${originalText}`
      : originalText;

    let userContent;

    if (imageBase64) {
      const blocks = [];

      // include our meta + user text
      blocks.push({
        type: "input_text",
        text: assistantText || "Here is an image for you to analyze.",
      });

      blocks.push({
        type: "input_image_url",
        image_url: { url: imageBase64 }, // frontend sends a data URL (base64)
      });

      userContent = blocks;
    } else {
      // No image – just text, but with email meta
      userContent = assistantText;
    }

    // 3️⃣ Add user message to the thread
    await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        role: "user",
        content: userContent,
      }),
    });

    // 4️⃣ Run assistant with extra run-level instructions
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: "POST",
      headers: assistantHeaders,
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        instructions: RUN_INSTRUCTIONS,
      }),
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

    // 7️⃣ Parse [[DAILY_LOG]] block from the assistant REPLY (includes macros)
    let extractedLog = null;

    // Look for the [[DAILY_LOG]] ... [[/DAILY_LOG]] block in the assistant's reply
    const logMatch = reply.match(/\[\[DAILY_LOG\]\]([\s\S]*?)\[\[\/DAILY_LOG\]\]/i);

    if (logMatch) {
      const block = logMatch[1].trim();
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

      const logObj = {
        date: null,
        email: null,
        weight: null,
        calories: null,
        protein: null,
        carbs: null,
        fats: null,
        steps: null,
        meals: null,
        mood: null,
        struggle: null,
        coach_focus: null,
        flag: null,
      };

      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        if (key === "date") {
          logObj.date = value || null;
        } else if (key === "email") {
          logObj.email = value || null;
        } else if (key === "weight") {
          logObj.weight = value ? parseFloat(value) : null;
        } else if (key === "calories") {
          logObj.calories = value ? parseInt(value, 10) : null;
        } else if (key === "protein") {
          logObj.protein = value ? parseInt(value, 10) : null;
        } else if (key === "carbs") {
          logObj.carbs = value ? parseInt(value, 10) : null;
        } else if (key === "fats") {
          logObj.fats = value ? parseInt(value, 10) : null;
        } else if (key === "steps") {
          logObj.steps = value ? parseInt(value, 10) : null;
        } else if (key === "meals") {
          logObj.meals = value || null;
        } else if (key === "mood") {
          logObj.mood = value || null;
        } else if (key === "struggle") {
          logObj.struggle = value || null;
        } else if (key === "coach_focus") {
          logObj.coach_focus = value || null;
        } else if (key === "flag") {
          const v = value.toLowerCase();
          if (v === "true") logObj.flag = true;
          else if (v === "false") logObj.flag = false;
          else logObj.flag = null;
        }
      }

      // Fallbacks
      if (!logObj.email && resolvedEmail) {
        logObj.email = resolvedEmail;
      }
      if (!logObj.date) {
        logObj.date = new Date().toISOString().slice(0, 10);
      }

      if (logObj.email) {
        extractedLog = logObj;
      }
    }

    // ✅ Save DAILY LOG (with macros) to your save-daily-log endpoint
    if (extractedLog && extractedLog.email) {
      try {
        await fetch("https://pjifitness-chat-api.vercel.app/api/save-daily-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: extractedLog.email,
            date: extractedLog.date,
            weight: extractedLog.weight,
            calories: extractedLog.calories,
            protein: extractedLog.protein,
            carbs: extractedLog.carbs,
            fats: extractedLog.fats,
            steps: extractedLog.steps,
            meals: extractedLog.meals,
            mood: extractedLog.mood,
            struggle: extractedLog.struggle,
            coach_focus: extractedLog.coach_focus,
            flag: extractedLog.flag,
          }),
        });
      } catch (e) {
        console.error("save-daily-log error:", e);
      }
    }

    // 8️⃣ Optional: Send log/chat info to Make.com
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

    // 9️⃣ Return response to frontend
    return res.status(200).json({ reply, threadId: thread_id });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
