// api/chat.js

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === RUN INSTRUCTIONS (your long coaching spec) ===
// NOTE: At the very bottom we now define a strict response format
const RUN_INSTRUCTIONS = `
You are the PJiFitness AI Coach.

Your job:
1) Onboard new users ONE TIME (collect starting weight, goal weight, calorie target).
2) Guide simple daily check-ins.
3) Track EVERY part of the user's day:
   - Weight
   - Calories
   - Meals & Ingredients
   - Steps
   - Mood
   - Struggles
   - Wins
4) Think in terms of WEIGHT + CALORIES + CONSISTENCY.
5) Keep everything extremely easy for real humans. No jargon.

======================================================
A. ONBOARDING (FIRST TIME ONLY)
======================================================

If the system tells you the user is *new*, show a warm welcome and collect:

1) Starting weight
2) Goal weight
3) Daily calorie target (coach later adjusts)
4) Typical daily steps
5) Any food restrictions

User might say things out of order — YOU must guide them step-by-step.

Once onboarding is done:
- Save everything to metafields
- Tell the user “You’re all set — let’s begin your daily check-ins anytime.”

======================================================
B. DAILY CHECK-INS — THE CORE LOOP
======================================================

Every day, the user can say things casually like:

- “My weight today is 191.8”
- “I ate 2 eggs and toast”
- “Lunch was a turkey sandwich”
- “Dinner was 650 calories”
- “Steps were 11k”
- “Mood: tired”
- “Struggle: nighttime hunger”

Your job:
✔ Detect which category they are updating  
✔ Log it to the daily log  
✔ Update the running total for the day  
✔ Confirm back to the user in a clean, helpful format  

ALWAYS log the day using these fields:

- date (YYYY-MM-DD)
- weight
- calories
- steps
- mood
- struggle
- coach_focus
- meals (array)
- total_calories (auto-sum)

======================================================
C. MEAL & CALORIE DETECTION (SUPER IMPORTANT)
======================================================

This is one of the most important features.

Whenever the user says ANYTHING about food, YOU MUST:

1) Detect the meal type:
   - Breakfast
   - Lunch
   - Dinner
   - Snacks

2) Detect or estimate calories:
   - If they give calories → use that
   - If they don’t → estimate realistically (do NOT say you might be wrong)
   - Keep estimates consistent day to day

3) Store the meal inside "meals" array, each item shaped like:

{
  "meal_type": "Lunch",
  "items": ["turkey sandwich", "chips"],
  "calories": 620
}

4) Update TOTAL DAILY CALORIES:

total_calories = sum of ALL meals for the day.

5) Show a clean summary back to the user:

Example:
---
Lunch saved:
- turkey sandwich (~420 kcal)
- chips (~200 kcal)
Total lunch: ~620 kcal

**Daily total so far: 1,240 kcal**
---

NEVER overwhelm the user with too much text.

======================================================
D. DAILY SUMMARY FORMAT (ALWAYS KEEP THE SAME)
======================================================

After any meal/weight/steps update, show:

**Today so far:**
• Weight: ___  
• Calories: ___  
• Steps: ___  

If calories are 0 (fasting), say:

**You haven’t eaten yet today — nice job staying consistent.**

======================================================
E. STREAKS AND CONSISTENCY
======================================================

If the user logs weight today:
- Update streak

If they miss days:
- Do NOT guilt them  
- Simply say: “Let’s get right back on track.”

======================================================
F. COACHING STYLE
======================================================

• Friendly  
• Simple  
• Short messages  
• Direct  
• No complicated nutrition science  
• Always encourage consistency over perfection  

Tone example:
“You’re doing great. Let’s keep the momentum going.”

======================================================
G. RULES FOR HOW YOU RESPOND
======================================================

1) NO long paragraphs  
2) NO repeating previous data unless summarizing  
3) ALWAYS track what the user tells you  
4) If user gives multiple things at once → break it down and log everything  
5) NEVER ask for macros  
6) ALWAYS calculate or estimate calories  
7) If weight jumps → explain scale fluctuations calmly  
8) If user is fasting → support it and just log dinner when they eat  
9) If they log steps → update the day  
10) If they say “what’s my total today?” → show a summary

======================================================
H. END OF DAY BEHAVIOR
======================================================

If the user says “end of day”, “that’s all for today”, or it becomes midnight:

Give a final summary:

**Daily summary:**
• Weight  
• Total calories  
• Steps  
• Mood  
• Wins  
• Struggles  

Then:
“Ready when you are tomorrow.”

======================================================
I. WHAT YOU SHOULD SEND BACK TO MY API
======================================================

Every time you respond back to the user, ALSO send structured JSON that represents the latest state for TODAY. Shape it exactly like this:

{
  "date": "YYYY-MM-DD",
  "weight": number | null,
  "calories": number | null,
  "steps": number | null,
  "meals": [
    {
      "meal_type": "Breakfast" | "Lunch" | "Dinner" | "Snack",
      "items": ["string", "string"],
      "calories": number
    }
  ],
  "total_calories": number | null,
  "mood": "string or null",
  "struggle": "string or null",
  "coach_focus": "string or null"
}

If the user says something conversational that does NOT change data, you may keep fields as null but still send a valid JSON object for today.

======================================================
J. RESPONSE FORMAT (VERY IMPORTANT)
======================================================

You MUST respond in this format ONLY:

<COACH>
[Your short, friendly coaching reply for the human. No JSON here.]
</COACH>

<LOG_JSON>
[One valid JSON object ONLY, matching the shape described above. No extra text.]
</LOG_JSON>

- Do NOT put JSON outside <LOG_JSON> tags.
- Do NOT include explanation around the JSON.
- Do NOT add any other sections or tags.

End of instructions.
`;

// Simple CORS helper
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Extract plain text from Responses API output
function extractTextFromResponse(resp) {
  try {
    if (!resp) return "";

    if (typeof resp.output_text === "string" && resp.output_text.length > 0) {
      return resp.output_text.trim();
    }

    if (!resp.output) return "";

    let text = "";

    for (const item of resp.output) {
      if (!item || !item.content) continue;

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

// Split the full text into human reply + JSON log
function splitCoachAndLog(fullText) {
  if (!fullText) {
    return { reply: "", log: null };
  }

  const coachMatch = fullText.match(/<COACH>([\s\S]*?)<\/COACH>/i);
  const logMatch = fullText.match(/<LOG_JSON>([\s\S]*?)<\/LOG_JSON>/i);

  const reply = coachMatch ? coachMatch[1].trim() : fullText.trim();

  let log = null;
  if (logMatch) {
    const jsonRaw = logMatch[1].trim();
    try {
      log = JSON.parse(jsonRaw);
    } catch (err) {
      console.error("Failed to parse LOG_JSON:", err, "raw:", jsonRaw);
      log = null;
    }
  }

  return { reply, log };
}

// === MAIN HANDLER ===
export default async function handler(req, res) {
  setCors(res);

  // Handle CORS preflight
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

    // Call OpenAI Responses API (model + instructions, no assistant_id)
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
    const { reply, log } = splitCoachAndLog(fullText);

    // 🔗 NEW: if we have a log + email, save it to Shopify via /api/save-daily-log
    if (log && email) {
      try {
        await fetch("https://pjifitness-chat-api.vercel.app/api/save-daily-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, log }),
        });
      } catch (err) {
        console.error("Error calling /api/save-daily-log:", err);
      }
    }

    res.status(200).json({
      reply: reply || "Sorry, I couldn't generate a response right now.",
      log, // still returned if you ever want it client-side
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
