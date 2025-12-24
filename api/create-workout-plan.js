// /api/create-workout-plan.js
//
// PJiFitness — Initial AI Workout Program Generator (V1)
// Used ONLY after onboarding
// Returns a structured starter plan (no history required)

export default async function handler(req, res) {
  // -----------------------------
  // CORS
  // -----------------------------
  const origin = req.headers.origin || "";
  const allowlist = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
  ]);
  const allowOrigin = allowlist.has(origin) ? origin : "https://www.pjifitness.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  // PING
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "create-workout-plan",
      ts: Date.now()
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const body = req.body || {};

    const goal = String(body.goal || "muscle_gain");
    const experience = String(body.experience || "intermediate");
    const days = Number(body.days_per_week || 4);
    const equipment = Array.isArray(body.equipment) ? body.equipment : [];
    const timeMinutes = Number(body.time_minutes || 60);

    // -----------------------------
    // OpenAI prompt
    // -----------------------------
    const system = `
You are PJiFitness Workout Coach.

Task:
Create an INITIAL workout program based on onboarding only.
This is NOT progressive overload yet.

Rules:
- Match volume to experience level
- Beginner: conservative sets
- Intermediate: moderate volume
- Advanced: higher volume
- Keep exercises realistic for the equipment
- No junk volume
- Clear titles

Return ONLY valid JSON.
No markdown.
No commentary.

STRICT JSON SCHEMA:
{
  "plan_title": "string",
  "days_per_week": number,
  "workouts": [
    {
      "session_type": "string",
      "title": "string",
      "duration_minutes": number,
      "exercises": [
        {
          "name": "string",
          "sets": [{ "w": number, "r": number }],
          "rest_seconds": number,
          "notes": "string"
        }
      ],
      "coach_focus": ["string"]
    }
  ]
}
`;

    const user = `
Goal: ${goal}
Experience: ${experience}
Days per week: ${days}
Time per session: ${timeMinutes} minutes
Equipment: ${equipment.length ? equipment.join(", ") : "full gym"}

Build the program now.
`;

    const started = Date.now();

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_WORKOUT_MODEL || "gpt-4.1-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        text: { format: { type: "json_object" } },
        temperature: 0.4,
        max_output_tokens: 1400
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return res.status(500).json({ error: "OpenAI failed", detail: t });
    }

    const data = await resp.json();

    const outputText =
      data?.output_text ||
      data?.output?.[0]?.content?.find?.(c => c?.type === "output_text")?.text ||
      "";

    if (!outputText) {
      return res.status(500).json({ error: "No output from model" });
    }

    let plan;
    try {
      plan = JSON.parse(outputText);
    } catch (e) {
      return res.status(500).json({
        error: "Invalid JSON from model",
        preview: outputText.slice(0, 800)
      });
    }

    // -----------------------------
    // Normalize + safety
    // -----------------------------
    if (!Array.isArray(plan.workouts)) plan.workouts = [];

    plan.workouts = plan.workouts.slice(0, days).map(w => {
      w.exercises = Array.isArray(w.exercises) ? w.exercises.slice(0, 8) : [];
      w.exercises = w.exercises.map(ex => ({
        name: ex.name || "Exercise",
        sets: (Array.isArray(ex.sets) ? ex.sets : [{ w: 0, r: 8 }])
  .slice(0, 5)
  .map(s => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 8 }))
  // ✅ If the model returns tiny "weights" (3–9), treat as unknown (0)
  .map(s => ({ w: (s.w > 0 && s.w < 10) ? 0 : s.w, r: s.r })),

        rest_seconds: Number(ex.rest_seconds || 90),
        notes: String(ex.notes || "")
      }));
      w.coach_focus = Array.isArray(w.coach_focus) ? w.coach_focus.slice(0, 4) : [];
      w.duration_minutes = Number(w.duration_minutes || timeMinutes);
      return w;
    });

    return res.status(200).json({
      plan,
      debug: {
        ms: Date.now() - started
      }
    });

  } catch (err) {
    return res.status(500).json({
      error: "Unhandled error",
      message: String(err)
    });
  }
}
