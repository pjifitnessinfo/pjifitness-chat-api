// /api/generate-workouts.js
//
// PJiFitness - Generate NEXT workout prescription (V1)
// - Returns JSON: { workout, debug }
// - Workout includes exact per-set WEIGHTS + REPS for progressive overload
//
// Expects POST JSON body (same as before), but last_workout is strongly recommended:
// {
//   goal, experience, session_type, equipment, time_minutes, notes,
//   last_workout: { date, split, workout_name, exercises:[{name, sets:[{w,r,done}]}] },
//   history: [...]
// }

export default async function handler(req, res) {
  // -----------------------------
  // CORS (match your chat endpoint behavior)
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "https://www.pjifitness.com");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const debug = {};
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    }

    const VERCEL_ENV = process.env.VERCEL_ENV || "unknown";
    const IS_PROD = VERCEL_ENV === "production";
    debug.vercelEnv = VERCEL_ENV;
    debug.isProd = IS_PROD;

    // -----------------------------
    // Parse incoming payload
    // -----------------------------
    const body = req.body || {};
    const goal = (body.goal || "muscle_gain").toString();
    const experience = (body.experience || "intermediate").toString();
    const sessionType = (body.session_type || "full_body").toString();
    const equipment = Array.isArray(body.equipment) ? body.equipment : [];
    const timeMinutes = Number.isFinite(Number(body.time_minutes)) ? Number(body.time_minutes) : 60;
    const notes = (body.notes || "").toString();

    const lastWorkout = body.last_workout || null;
    const history = Array.isArray(body.history) ? body.history : [];

    debug.goal = goal;
    debug.experience = experience;
    debug.sessionType = sessionType;
    debug.timeMinutes = timeMinutes;
    debug.hasLastWorkout = !!lastWorkout;

    // Require last_workout for real overload prescriptions (best V1 behavior)
    if (!lastWorkout || !Array.isArray(lastWorkout.exercises)) {
      return res.status(400).json({
        error: "Missing last_workout with exercises[]. Needed to prescribe weights/reps for progressive overload.",
        debug
      });
    }

    // -----------------------------
    // Build OpenAI prompt
    // -----------------------------
    // IMPORTANT: This schema returns per-set prescriptions.
    const system = `
You are PJiFitness "Workout Coach".
Return ONLY valid JSON. No markdown, no backticks, no commentary.

You are generating the user's NEXT workout session using progressive overload.

You MUST prescribe exact WEIGHT (lbs) and REPS for EACH SET for EACH EXERCISE.

Progressive overload rules:
- Use the last workout (completed sets) as the baseline.
- If the user hit the top end of a rep range with good performance, increase weight 2.5–10 lbs next time.
- If reps were low / near failure / form likely broke down, keep weight similar and increase reps slightly OR reduce weight slightly.
- Keep workouts realistic: 4–8 exercises, mostly 6–12 reps for hypertrophy, with sensible rest times.
- Keep the session type consistent with the request (or last workout split).

IMPORTANT JSON SCHEMA:
{
  "title": "string",
  "session_type": "string",
  "duration_minutes": number,
  "warmup": ["string", ...],
  "exercises": [
    {
      "name": "string",
      "category": "compound|accessory|core|conditioning",
      "sets": [
        { "w": number, "r": number },
        ...
      ],
      "rest_seconds": number,
      "notes": "string (optional)"
    }
  ],
  "finisher": "string (optional)",
  "cooldown": ["string", ...],
  "coach_focus": ["string", ...],
  "safety_notes": ["string", ...]
}

Do NOT include extra keys.
Weights are in pounds. Reps are integers.
`;

    const user = `
Goal: ${goal}
Experience: ${experience}
Session type: ${sessionType}
Time limit (minutes): ${timeMinutes}
Equipment: ${equipment.length ? equipment.join(", ") : "typical gym"}
Extra notes: ${notes || "(none)"}

Last workout (completed sets only):
${JSON.stringify(lastWorkout, null, 2)}

Recent history (optional):
${history.length ? JSON.stringify(history.slice(-4), null, 2) : "(none)"}

Generate the NEXT workout JSON now.
`;

    // -----------------------------
    // Call OpenAI (Responses API)
    // -----------------------------
    const model = process.env.OPENAI_WORKOUT_MODEL || "gpt-4.1-mini";
    debug.model = model;

    const oaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        text: { format: { type: "json_object" } },
        max_output_tokens: 1400,
        temperature: 0.4
      })
    });

    if (!oaiResp.ok) {
      const errText = await oaiResp.text();
      debug.openaiStatus = oaiResp.status;
      debug.openaiError = errText?.slice(0, 5000);
      return res.status(500).json({ error: "OpenAI request failed", debug });
    }

    const data = await oaiResp.json();

    const outputText =
      data?.output_text ||
      data?.output?.[0]?.content?.find?.(c => c?.type === "output_text")?.text ||
      data?.output?.map?.(o => (o?.content || []).map(c => c?.text).join("")).join("") ||
      "";

    if (!outputText || typeof outputText !== "string") {
      debug.raw = data;
      return res.status(500).json({ error: "No output from model", debug });
    }

    let workout;
    try {
      workout = JSON.parse(outputText);
    } catch (e) {
      debug.parseError = String(e);
      debug.outputPreview = outputText.slice(0, 2000);
      return res.status(500).json({ error: "Model returned invalid JSON", debug });
    }

    workout = normalizeWorkout(workout, { sessionType, timeMinutes });

    return res.status(200).json({ workout, debug });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled error",
      debug: { ...debug, message: String(err), stack: err?.stack ? String(err.stack).slice(0, 2000) : "" }
    });
  }
}

// -----------------------------
// Helpers
// -----------------------------
function normalizeWorkout(workout, { sessionType, timeMinutes }) {
  const w = (workout && typeof workout === "object") ? workout : {};

  if (!w.title) w.title = "Next Workout";
  if (!w.session_type) w.session_type = sessionType || "full_body";
  if (!Number.isFinite(Number(w.duration_minutes))) w.duration_minutes = timeMinutes || 60;

  if (!Array.isArray(w.warmup)) w.warmup = [];
  if (!Array.isArray(w.exercises)) w.exercises = [];
  if (!Array.isArray(w.cooldown)) w.cooldown = [];
  if (!Array.isArray(w.coach_focus)) w.coach_focus = [];
  if (!Array.isArray(w.safety_notes)) w.safety_notes = [];

  w.exercises = w.exercises
    .filter(Boolean)
    .slice(0, 10)
    .map(ex => {
      const e = (ex && typeof ex === "object") ? ex : {};
      if (!e.name) e.name = "Exercise";
      if (!e.category) e.category = "accessory";
      if (!Number.isFinite(Number(e.rest_seconds))) e.rest_seconds = 90;

      // Ensure sets is array of {w,r}
      if (!Array.isArray(e.sets)) e.sets = [];
      e.sets = e.sets
        .filter(Boolean)
        .slice(0, 6)
        .map(s => {
          const ss = (s && typeof s === "object") ? s : {};
          const wNum = Number(ss.w);
          const rNum = Number(ss.r);
          return {
            w: Number.isFinite(wNum) ? wNum : 0,
            r: Number.isFinite(rNum) ? rNum : 8
          };
        })
        .filter(s => s.w > 0 && s.r > 0);

      // If model forgot sets, put a safe default
      if (!e.sets.length) {
        e.sets = [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }];
      }

      return e;
    });

  return w;
}
