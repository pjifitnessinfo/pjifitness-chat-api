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
  const allowlist = new Set(["https://www.pjifitness.com", "https://pjifitness.com"]);
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
    return res.status(200).json({ ok: true, route: "create-workout-plan", ts: Date.now() });
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

    const goal = String(body.goal || "fat_loss"); // your UI maps "cut" => fat_loss
    const experience = String(body.experience || "intermediate");
    const days = Math.max(1, Math.min(6, Number(body.days_per_week || 4) || 4));
    const equipment = Array.isArray(body.equipment) ? body.equipment : [];
    const timeMinutes = Math.max(20, Math.min(120, Number(body.time_minutes || 60) || 60));
    const age = String(body.age || "").trim();

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
- Use "session_type" as one of: "upper_body", "lower_body", "full_body"
- Include short safety notes for each workout

Return ONLY valid JSON.
No markdown.
No commentary.

STRICT JSON SCHEMA:
{
  "plan_title": "string",
  "days_per_week": number,
  "workouts": [
    {
      "session_type": "upper_body|lower_body|full_body",
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
      "coach_focus": ["string"],
      "safety_notes": ["string"]
    }
  ]
}
`.trim();

    const user = `
Goal: ${goal}
Experience: ${experience}
Age: ${age || "n/a"}
Days per week: ${days}
Time per session: ${timeMinutes} minutes
Equipment: ${equipment.length ? equipment.join(", ") : "full gym"}

Build the program now.
`.trim();

    const started = Date.now();

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_WORKOUT_MODEL || "gpt-4.1-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        text: { format: { type: "json_object" } },
        temperature: 0.4,
        max_output_tokens: 1600,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      return res.status(500).json({ error: "OpenAI failed", detail: t });
    }

    const data = await resp.json();

    // Responses API: prefer output_text but fall back to parsing output content blocks
    const outputText =
      data?.output_text ||
      data?.output?.[0]?.content?.find?.((c) => c?.type === "output_text")?.text ||
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
        preview: outputText.slice(0, 800),
      });
    }

    // -----------------------------
    // Normalize + safety
    // -----------------------------
    if (!plan || typeof plan !== "object") plan = {};
    if (!Array.isArray(plan.workouts)) plan.workouts = [];

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    const normalizeSessionType = (t) => {
      const s = String(t || "").toLowerCase();
      if (s.includes("lower") || s.includes("leg")) return "lower_body";
      if (s.includes("full")) return "full_body";
      if (s.includes("upper") || s.includes("push") || s.includes("pull")) return "upper_body";
      // fallback: rotate a bit by day if the model gives nonsense
      return "full_body";
    };

    const isCompoundLift = (name) => {
      const lower = String(name || "").toLowerCase();
      return /(squat|deadlift|bench|press|row|pull[- ]?up|pulldown|rdl|romanian|lunge|leg press)/.test(
        lower
      );
    };

    plan.plan_title = String(plan.plan_title || "Workout Program");
    plan.days_per_week = Number(plan.days_per_week || days) || days;

    plan.workouts = plan.workouts.slice(0, days).map((w, idx) => {
      const title = String(w?.title || `Day ${idx + 1}`);
      const session_type = normalizeSessionType(w?.session_type);

      let exercises = Array.isArray(w?.exercises) ? w.exercises.slice(0, 10) : [];

      exercises = exercises.map((ex) => {
        const name = String(ex?.name || "Exercise");

        let sets = (Array.isArray(ex?.sets) ? ex.sets : [{ w: 0, r: 8 }])
          .slice(0, 6)
          .map((s) => ({
            w: Number(s?.w) || 0,
            r: Number(s?.r) || 8,
          }))
          // kill tiny placeholder weights (1–9 lbs) -> 0
          .map((s) => ({ w: s.w > 0 && s.w < 10 ? 0 : s.w, r: s.r }));

        // Compounds get 3 sets, accessories get 2 sets
        const targetSets = isCompoundLift(name) ? 3 : 2;

        if (sets.length < targetSets) {
          const base = sets[0] || { w: 0, r: 8 };
          while (sets.length < targetSets) sets.push({ w: base.w, r: base.r });
        } else if (sets.length > targetSets) {
          sets = sets.slice(0, targetSets);
        }

        const restDefault = isCompoundLift(name) ? 90 : 60;

        return {
          name,
          sets,
          rest_seconds: clamp(Number(ex?.rest_seconds || restDefault) || restDefault, 30, 180),
          notes: String(ex?.notes || ""),
        };
      });

      const coach_focus = Array.isArray(w?.coach_focus) ? w.coach_focus.slice(0, 5) : [];
      const safety_notes = Array.isArray(w?.safety_notes) ? w.safety_notes.slice(0, 5) : [];

      return {
        session_type,
        title,
        duration_minutes: clamp(Number(w?.duration_minutes || timeMinutes) || timeMinutes, 20, 120),
        exercises,
        coach_focus,
        safety_notes,
      };
    });

    return res.status(200).json({
      plan,
      debug: { ms: Date.now() - started },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled error",
      message: String(err?.message || err),
    });
  }
}
