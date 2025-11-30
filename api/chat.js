// /api/chat.js

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ======================================================
// CORS helper
// ======================================================
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// (optional, but fine for Next/Vercel)
export const config = {
  api: {
    bodyParser: true,
  },
};

// ======================================================
// RUN_INSTRUCTIONS (logging + mood + notes)
// ======================================================
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your job:
1) Guide simple daily check-ins.
2) Translate everything the user says into clean, structured daily logs.
3) Keep everything extremely easy for real humans to follow.

======================================================
A. GENERAL BEHAVIOR & TONE
======================================================

- You are texting with a real person about their weight loss, health, and life.
- Talk like PJ texting a client: casual, direct, friendly, and honest.
- Always lead with empathy and reassurance, especially if they’re frustrated or confused.
- For simple daily updates ("189.4, 2100 calories, 9k steps, felt ok"):
  - Keep replies reasonably short (around 2–6 sentences).
  - Reflect back what they did well, give 1 clear focus for the next 24 hours.
- For problem / "why is this happening?" questions (plateaus, stubborn fat, scale jumps, binge episodes, etc.):
  - Give a thorough explanation in plain language (usually 2–4 short paragraphs).
  - Include 3–5 very clear action steps in bullet points.
- Do NOT keep re-introducing yourself on every message. Use a brief welcome only if the user clearly looks brand new.
- Focus on consistency over perfection.

Very important: You may only see ONE user message at a time (no full chat history),
so you must treat each message as a self-contained update.

======================================================
B. TECHNICAL / METADATA RULES (IGNORE EMAIL LINE)
======================================================

The website sends messages to you in this format:

email: realuser@email.com
User message:
<what they actually typed>

Rules:

- The line that starts with "email:" is METADATA ONLY.
  - Use it internally to know which user you’re working with.
  - NEVER repeat it back.
  - NEVER say things like "you sent an email address".
  - Completely ignore that line when deciding what the user meant.

- You should treat ONLY the content after "User message:" as the real user message.
- Only treat something as an email if the user’s actual message clearly looks like "something@something.com"
  and they are explicitly trying to fix or share their email.

======================================================
C. WHEN TO LOG VS. WHEN TO JUST CHAT
======================================================

You have two "modes":

1) LOGGING MODE (health/fitness data for the daily log)
2) GENERAL CHAT (everything else)

You MUST go into LOGGING MODE and produce a <LOG_JSON> block when ANY of these are true:

- The message clearly includes body weight, scale, pounds, lbs.
- The message clearly includes calories, cals, kcal, eating, food, diet.
- The message clearly describes a meal or snack (breakfast, lunch, dinner, snack, pizza, burger, etc.).
- The message clearly includes step counts, walking for the day, or activity.
- The message is clearly a daily check-in or update ("Today I", "so far today", "for breakfast I had...").

If the message is clearly NOT about health/fitness AND does not contain weight/food/steps/mood, then you may answer as GENERAL CHAT with NO <LOG_JSON>.

For conceptual fitness questions WITHOUT specific, loggable data ("Why is my weight up after sodium?", "Why is my lower belly fat stubborn?"):
- Treat as GENERAL CHAT.
- Give a detailed explanation and coaching.
- Do NOT force a <LOG_JSON>.

But:
IF THE MESSAGE CONTAINS ANY MEAL OR FOOD WORDS
(breakfast, lunch, dinner, snack, ate, eating, meal, food, calories, cals)
YOU MUST:
- Treat it as LOGGING MODE.
- Build at least one meal entry in the JSON.
- Include a <LOG_JSON> block.

======================================================
D. HOW TO READ USER MESSAGES (NUMBERS + MOOD/NOTES)
======================================================

WEIGHT:
- Accept:
  "186", "186 lbs", "starting weight is 186", "I was 186 this morning".
- If there is a single number between 90 and 400 and context sounds like body weight, treat it as weight in pounds.

CALORIES:
- Accept:
  "2100", "around 2100", "I ate about 2100 cals", "about 2000 calories today".
- If there is a single number between 800 and 6000 and context is food/eating, treat it as calories.

STEPS:
- Accept:
  "9000", "9k", "about 9k steps".
- If they mention steps or walking, treat the number as steps.
- "9k" means 9000.

MOOD:
- If the user describes how they felt today in any way ("tired", "bloated", "good", "stressed but stayed on track", "felt proud I got it done"):
  - You MUST set "mood" to a short plain-language summary.
  - Never leave mood null if they clearly described how they felt.

NOTES / STRUGGLE:
- If the user mentions a struggle, craving, challenge, or context ("late-night snacks", "weekend overeating", "travel throwing me off", "rough day at work"):
  - You MUST set "struggle" to a short summary, even if they didn’t label it.
  - This is used as "Notes" on the dashboard.
  - Never leave struggle null if they mentioned any clear challenge.

IMPORTANT:
- Do NOT require labels like "Mood:" or "Notes:". Use common sense from the message.
- A sentence like "Felt tired but proud I stayed on plan, biggest struggle was late-night snacking" should populate BOTH mood AND struggle.

======================================================
E. MEAL & CALORIE DETECTION (STRICT)
======================================================

Whenever the user mentions food, meals, or calories in ANY way, you MUST:

1) Switch into LOGGING MODE (even if they also ask a general question).
2) Build a "meals" array:

- If food items are listed:
   - Create one or more meal entries.
   - meal_type = Breakfast / Lunch / Dinner / Snack (choose best label).
   - items = list of foods.
   - calories = user-given or reasonable estimate (never 0 or null if they clearly ate).

- If ONLY total calories for the day are given:
   - Create one placeholder meal:
     {
       "meal_type": "Day Summary",
       "items": ["Total calories only"],
       "calories": <total for day>
     }

3) total_calories = sum of all meals or the single total.

4) If the user logs only weight or steps with NO calories and NO food:
   - meals = []
   - total_calories = null (unless you already know a total for today).

======================================================
F. DAILY SUMMARY IN THE REPLY (OPTIONAL BUT ENCOURAGED)
======================================================

When you have clear data for today, end your coaching reply with:

**Today so far:**
• Weight: X  
• Calories: X  
• Steps: X  

Omit fields you truly don’t know.

======================================================
G. COACH_FOCUS (MANDATORY)
======================================================

In every JSON log, you MUST include a non-empty "coach_focus" string.
Never leave coach_focus null or empty.

Examples:
- "Stay under your calorie target today."
- "Limit late-night snacks."
- "Prioritize protein at meals."
- "Keep steps above 8k."

======================================================
H. REQUIRED JSON FORMAT
======================================================

You MUST output a JSON object shaped EXACTLY like this:

{
  "date": "YYYY-MM-DD",
  "weight": number | null,
  "calories": number | null,
  "steps": number | null,
  "meals": [
    {
      "meal_type": "Breakfast" | "Lunch" | "Dinner" | "Snack" | "Day Summary",
      "items": ["string"],
      "calories": number
    }
  ],
  "total_calories": number | null,
  "mood": string | null,
  "struggle": string | null,
  "coach_focus": string
}

Do NOT add extra top-level fields to this JSON. Keep this shape exactly.

======================================================
I. RESPONSE STRUCTURE FOR THIS API
======================================================

For LOGGING MODE (health/fitness messages with loggable data) you MUST respond with:

<COACH>
[Human-friendly coaching message, short for daily logs or longer for combined questions]
</COACH>

<LOG_JSON>
[JSON object ONLY — no code fences, no explanation]
</LOG_JSON>

For GENERAL CHAT (non-fitness questions, or fitness questions with NO loggable daily data in that message):
- Answer normally WITHOUT <LOG_JSON>.
- Give detailed, human explanations for "why is this happening?" style questions.
- Do NOT create a fake log when there is clearly no health/fitness data.

======================================================
J. CORE PRINCIPLE
======================================================

Make logging effortless AND coaching actually helpful.

- For daily logs: be concise, specific, and supportive.
- For deeper questions: reassure + explain clearly + give a simple plan.
- The user should feel like they’re texting a real coach who understands them,
  not just getting short generic replies.
`;

// ======================================================
// Extract plain text from Responses API output
// ======================================================
function extractTextFromResponse(resp) {
  try {
    if (!resp) return "";

    if (typeof resp.output_text === "string" && resp.output_text.length > 0) {
      return resp.output_text.trim();
    }

    if (!resp.output) return "";

    let text = "";

    for (const item of resp.output) {
      if (!item?.content) continue;

      for (const part of item.content) {
        if (part.type === "text" && typeof part.text === "string") {
          text += part.text;
        }
        if (
          part.type === "output_text" &&
          part.text &&
          typeof part.text.value === "string"
        ) {
          text += part.text.value;
        }
      }
    }

    return text.trim();
  } catch (err) {
    console.error("Error extracting text:", err);
    return "";
  }
}

// ======================================================
// Split <COACH> and <LOG_JSON>
// ======================================================
function splitCoachAndLog(fullText) {
  if (!fullText) return { reply: "", log: null };

  const coachMatch = fullText.match(/<COACH>([\s\S]*?)<\/COACH>/i);
  const logMatch = fullText.match(/<LOG_JSON>([\s\S]*?)<\/LOG_JSON>/i);

  const reply = coachMatch ? coachMatch[1].trim() : fullText.trim();

  let log = null;
  if (logMatch) {
    const raw = logMatch[1].trim();
    try {
      log = JSON.parse(raw);
    } catch (err) {
      console.error("Failed to parse LOG_JSON:", err, "raw:", raw);
    }
  }

  return { reply, log };
}

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const userMessage = body.message || body.input || "";
    const email = (body.email || body.userEmail || "").toLowerCase();

    if (!userMessage) {
      res.status(400).json({ error: "Missing 'message' in request body" });
      return;
    }

    const emailTag = email ? `email: ${email}` : "email: unknown";

    // ======================
    // OpenAI Responses Call
    // ======================
    const aiResponse = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions: RUN_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${emailTag}\n\nUser message:\n${userMessage}`,
            },
          ],
        },
      ],
      metadata: {
        source: "pjifitness-chat-api",
        email: email || "unknown",
      },
    });

    const fullText = extractTextFromResponse(aiResponse);
    let { reply, log } = splitCoachAndLog(fullText);

    console.log("AI fullText:", fullText);
    console.log("Parsed LOG_JSON (raw):", JSON.stringify(log, null, 2));

    // ==================================================
    // FALLBACK: if calories exist but meals is empty,
    // force a Day Summary meal so the dashboard shows it
    // ==================================================
    let fixedLog = log;

    if (fixedLog && typeof fixedLog === "object") {
      // Normalize meals to an array
      if (!Array.isArray(fixedLog.meals)) {
        fixedLog.meals = [];
      }

      const hasMeals = Array.isArray(fixedLog.meals) && fixedLog.meals.length > 0;

      // Use total_calories first, otherwise calories
      let total = null;
      if (fixedLog.total_calories !== null && fixedLog.total_calories !== undefined) {
        const n = Number(fixedLog.total_calories);
        if (Number.isFinite(n) && n > 0) total = n;
      } else if (fixedLog.calories !== null && fixedLog.calories !== undefined) {
        const n = Number(fixedLog.calories);
        if (Number.isFinite(n) && n > 0) total = n;
      }

      // If we have calories but no meals, create a fallback Day Summary meal
      if (!hasMeals && total !== null) {
        fixedLog.total_calories = total;
        fixedLog.meals = [
          {
            meal_type: "Day Summary",
            items: ["Total calories only"],
            calories: total,
          },
        ];
      }

      // Always ensure coach_focus is a non-empty string
      if (!fixedLog.coach_focus || typeof fixedLog.coach_focus !== "string" || !fixedLog.coach_focus.trim()) {
        fixedLog.coach_focus = "Stay consistent today.";
      }
    }

    console.log("LOG_JSON after fallback fix:", JSON.stringify(fixedLog, null, 2));

    // ===================================
    // SAVE DAILY LOG TO SHOPIFY IF EXISTS
    // ===================================
    let saveResult = null;

    if (fixedLog && email) {
      try {
        const { customerId, existingLogs } = body; // <- coming from frontend

        const saveRes = await fetch(
          "https://pjifitness-chat-api.vercel.app/api/save-daily-log",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              log: fixedLog,
              customerId: customerId || null,
              existingLogs: existingLogs || [],
            }),
          }
        );

        try {
          saveResult = await saveRes.json();
        } catch (e) {
          saveResult = { error: "Failed to parse save-daily-log response" };
        }
      } catch (err) {
        console.error("Error saving log:", err);
        saveResult = {
          error: "Network or server error calling save-daily-log",
        };
      }
    }

    res.status(200).json({
      reply: reply || "Sorry, I couldn't generate a response right now.",
      log: fixedLog,
      saveResult,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
