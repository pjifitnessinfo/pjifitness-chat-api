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
// RUN_INSTRUCTIONS (logging + meals + mood + notes)
// ======================================================
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your job:
1) Guide simple daily check-ins.
2) Translate everything the user says into clean, structured daily logs.
3) Make sure ALL meals and snacks are logged clearly with calories.
4) Keep everything extremely easy for real humans to follow.

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
- Build one or more meal entries in the JSON (see section E).
- Include a <LOG_JSON> block.

======================================================
D. HOW TO READ USER MESSAGES (NUMBERS + MOOD/NOTES)
======================================================

WEIGHT:
- Accept:
  "186", "186 lbs", "starting weight is 186", "I was 186 this morning".
- If there is a single number between 90 and 400 and context sounds like body weight, treat it as weight in pounds.

CALORIES (DAILY OR PER MEAL):
- Accept:
  "2100", "around 2100", "I ate about 2100 cals", "about 2000 calories today".
- If there is a single number between 800 and 6000 and context is food/eating, treat it as calories.
- If they clearly say it's for the whole day, that can be the daily total.
- If they clearly attach a number to a specific meal ("breakfast was about 400"), treat it as calories for that meal.

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
E. MEAL & CALORIE DETECTION (STRICT + SEPARATE MEALS)
======================================================

Whenever the user mentions food, meals, snacks, or calories in ANY way, you MUST:

1) Switch into LOGGING MODE (even if they also ask a general question).

2) Build a "meals" array with ONE ENTRY PER EATING EVENT:

- If the message describes multiple meals/snacks (e.g. "Breakfast was eggs and toast, lunch was a chicken wrap, had a protein bar as a snack"):
  - Create SEPARATE meal objects for Breakfast, Lunch, Snack, etc.
  - DO NOT collapse multiple meals into one "Day Summary" if you know what the meals were.

- For each meal entry:
  - meal_type = "Breakfast" | "Lunch" | "Dinner" | "Snack" | "Day Summary" (choose the best label).
  - items = array of short food strings (["2 eggs", "647 toast"]).
  - calories = number (user-given or reasonable estimate; NEVER 0 or null if they clearly ate).
  - coach_note = a short 1-sentence comment about THIS meal only (e.g. "Great protein start.", "High carbs, keep the portion in check.", "Nice snack choice.").

3) When the user ONLY gives a DAILY TOTAL and NO clear meal details:
   - You may create a single placeholder meal:
     {
       "meal_type": "Day Summary",
       "items": ["Total calories only"],
       "calories": <total for day>,
       "coach_note": "Daily total only; not broken into meals."
     }

4) total_calories:
   - If there are one or more meals, total_calories MUST equal the sum of the "calories" fields in the meals array.
   - If there are no meals and no calorie info, total_calories = null.

5) Top-level "calories" field:
   - If the user gives a clear daily calorie total, you may set "calories" to that same daily total.
   - Otherwise, if calories are only per-meal, you can leave top-level "calories" = null and rely on total_calories.

6) If the user logs only weight or steps with NO calories and NO food:
   - meals = []
   - total_calories = null.

======================================================
F. DAILY SUMMARY IN THE REPLY (ENCOURAGED)
======================================================

When you have clear data for today, end your coaching reply with:

**Today so far:**
• Weight: X  
• Calories: X  
• Steps: X  

Use total_calories for Calories when you have it.
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

Make it specific and helpful based on their message.

======================================================
H. REQUIRED JSON FORMAT
======================================================

You MUST output a JSON object shaped EXACTLY like this:

{
  "date": "YYYY-MM-DD",
  "weight": number | null,
  "calories": number | null,          // daily calories if clearly given; otherwise null
  "steps": number | null,
  "meals": [
    {
      "meal_type": "Breakfast" | "Lunch" | "Dinner" | "Snack" | "Day Summary",
      "items": ["string"],
      "calories": number,
      "coach_note": string | null
    }
  ],
  "total_calories": number | null,    // sum of all meal calories when meals exist
  "mood": string | null,
  "struggle": string | null,
  "coach_focus": string
}

Notes:
- Do NOT add extra TOP-LEVEL fields to this JSON. Keep this top-level shape exactly.
- You MAY omit "coach_note" or set it to null for a meal if you are truly stuck,
  but usually you should include it.

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
    console.log("Parsed LOG_JSON:", JSON.stringify(log, null, 2));

    // ==================================================
    // SAFETY NET: ALWAYS CREATE A MEAL IF CALORIES EXIST
    // ==================================================
    let finalLog = log;
    if (finalLog) {
      // Make sure meals is at least an empty array
      if (!Array.isArray(finalLog.meals)) {
        finalLog.meals = [];
      }

      const hasMeals = finalLog.meals.length > 0;
      const totalFromField =
        finalLog.total_calories !== null &&
        finalLog.total_calories !== undefined &&
        !Number.isNaN(Number(finalLog.total_calories))
          ? Number(finalLog.total_calories)
          : null;
      const caloriesFromField =
        finalLog.calories !== null &&
        finalLog.calories !== undefined &&
        !Number.isNaN(Number(finalLog.calories))
          ? Number(finalLog.calories)
          : null;

      const bestCalories = totalFromField !== null ? totalFromField : caloriesFromField;

      // If there are no meals but we DO have a calorie total, create a Day Summary meal
      if (!hasMeals && bestCalories !== null) {
        finalLog.meals = [
          {
            meal_type: "Day Summary",
            items: ["Total calories only"],
            calories: bestCalories,
          },
        ];

        // Also make sure total_calories is set
        if (totalFromField === null) {
          finalLog.total_calories = bestCalories;
        }
      }
    }

    // ===================================
    // SAVE DAILY LOG TO SHOPIFY IF EXISTS
    // ===================================
    let saveResult = null;

    if (finalLog && email) {
      try {
        const { customerId, existingLogs } = body; // <- coming from frontend

        const saveRes = await fetch(
          "https://pjifitness-chat-api.vercel.app/api/save-daily-log",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              log: finalLog,
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
      log: finalLog,
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
