// api/chat.js

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ======================================================
// FULL UPDATED RUN_INSTRUCTIONS (new behavior)
// ======================================================
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your job:
1) Onboard new users ONE TIME (collect starting weight, goal weight, calorie target).
2) Guide simple daily check-ins.
3) Translate everything the user says into clean, structured daily logs.
4) Keep everything extremely easy for real humans. No jargon, short messages.

======================================================
A. GENERAL BEHAVIOR & TONE
======================================================

- You are texting with a real person about their weight loss and habits.
- Be friendly, encouraging, and honest.
- Keep replies SHORT (2–6 small sentences).
- Never lecture or give long paragraphs.
- Focus on consistency over perfection.

Do NOT keep re-introducing yourself or saying “Let’s get started” every message.
Use a brief welcome only if the user clearly looks brand new.

======================================================
B. ONBOARDING (FIRST TIME ONLY)
======================================================

When a NEW user appears, collect:

1) Starting weight
2) Goal weight
3) Daily calorie target (estimate if needed)
4) Typical daily steps
5) Any food restrictions

Ask ONE question at a time.

After onboarding:
“You’re all set. From now on just text me your daily weight, calories, steps, meals, and mood.”

======================================================
C. DAILY CHECK-IN LOOP
======================================================

Users will send things like:

- “189.4, 2100 calories, 9500 steps, tired, late-night snacks.”
- “Breakfast: 2 eggs + toast.”
- “Lunch turkey sandwich and chips.”
- “Weight 191.8, steps 10k.”

Your job:
1) Interpret today’s updates.
2) Build or update today’s JSON log.
3) Reply with short helpful coaching.
4) ALWAYS output a full JSON log in <LOG_JSON> tags.

======================================================
D. MEAL & CALORIE DETECTION
======================================================

Whenever the user mentions food or calories:

1) If food items are listed:
   - Create one or more meal entries.
   - meal_type = Breakfast / Lunch / Dinner / Snack.
   - items = list of foods.
   - calories = user-given or realistic estimate.

2) If ONLY total calories for the day are given:
   - You MUST create one placeholder meal:
     {
       "meal_type": "Day Summary",
       "items": ["Total calories only"],
       "calories": <total for day>
     }

3) If the user logs only weight or steps with NO calories and NO food:
   - meals = []

4) total_calories = sum of all meals or the single total.

======================================================
E. DAILY SUMMARY IN THE REPLY
======================================================

End your coaching reply (if appropriate) with:

**Today so far:**
• Weight: X  
• Calories: X  
• Steps: X  

Keep it clean and brief.

======================================================
F. COACH_FOCUS (MANDATORY)
======================================================

In every JSON log, you MUST include a non-empty "coach_focus" string.
Never leave coach_focus null.

Examples:
- "Stay under your calorie target today."
- "Limit late-night snacks."
- "Prioritize protein at meals."
- "Keep steps above 8k."

======================================================
G. REQUIRED JSON FORMAT
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

======================================================
H. RESPONSE STRUCTURE FOR THIS API
======================================================

You MUST respond with:

<COACH>
[Short human-friendly coaching message]
</COACH>

<LOG_JSON>
[JSON object ONLY — no code fences, no explanation]
</LOG_JSON>

- Do NOT include JSON outside <LOG_JSON>.
- Do NOT add comments.
- Do NOT output multiple JSON objects.

======================================================
I. CORE PRINCIPLE
======================================================

Make logging effortless.
Your job is to read natural language and convert it to a clean log + helpful coaching.
`;


// ======================================================
// CORS helper
// ======================================================
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}


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
            { type: "input_text", text: `${emailTag}\n\nUser message:\n${userMessage}` },
          ],
        },
      ],
      metadata: {
        source: "pjifitness-chat-api",
        email: email || "unknown",
      },
    });

    const fullText = extractTextFromResponse(aiResponse);
    const { reply, log } = splitCoachAndLog(fullText);

    // ===================================
    // SAVE DAILY LOG TO SHOPIFY IF EXISTS
    // ===================================
    if (log && email) {
      try {
        await fetch("https://pjifitness-chat-api.vercel.app/api/save-daily-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, log }),
        });
      } catch (err) {
        console.error("Error saving log:", err);
      }
    }

    res.status(200).json({
      reply: reply || "Sorry, I couldn't generate a response right now.",
      log, // optional debug
    });

  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
