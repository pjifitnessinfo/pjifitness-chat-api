// /api/generate-workouts.js
//
// PJiFitness - Generate a workout plan (V1)
// - SAFE BY DEFAULT: in Preview environments it never saves anything.
// - Returns JSON: { workout, debug }
//
// Expects POST JSON body:
// {
//   "goal": "fat_loss|muscle_gain|strength|general_fitness" (optional),
//   "experience": "beginner|intermediate|advanced" (optional),
//   "session_type": "upper|lower|push|pull|legs|full_body|back_bi|chest_tri|shoulders|arms" (optional),
//   "equipment": ["dumbbells","barbell","cables","machines","pullup_bar"] (optional),
//   "time_minutes": 45 (optional),
//   "notes": "any extra context" (optional),
//   "last_workout": { ... } (optional),
//   "history": [ ... ] (optional),
//   "save": false (optional, ignored in preview)
// }
//
// You can call from Shopify with: fetch('/api/generate-workouts', ...)

export default async function handler(req, res) {
  // -----------------------------
  // CORS (optional but helpful)
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const debug = {};
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var" });
    }

    // Vercel env: "production" | "preview" | "development"
    const VERCEL_ENV = process.env.VERCEL_ENV || "unknown";
    const IS_PROD = VERCEL_ENV === "production";
    debug.vercelEnv = VERCEL_ENV;
    debug.isProd = IS_PROD;

    // -----------------------------
    // Parse incoming payload
    // -----------------------------
    const body = req.body || {};
    const goal = (body.goal || "general_fitness").toString();
    const experience = (body.experience || "intermediate").toString();
    const sessionType = (body.session_type || "full_body").toString();
    const equipment = Array.isArray(body.equipment) ? body.equipment : [];
    const timeMinutes = Number.isFinite(Number(body.time_minutes)) ? Number(body.time_minutes) : 45;
    const notes = (body.notes || "").toString();

    const lastWorkout = body.last_workout || null;
    const history = Array.isArray(body.history) ? body.history : [];

    // "save" is allowed only in production AND only if you later implement saving logic.
    const wantsSave = !!body.save;
    const allowSave = IS_PROD && wantsSave;
    debug.wantsSave = wantsSave;
    debug.allowSave = allowSave;

    // -----------------------------
    // Build OpenAI prompt
    // -----------------------------
    // We force the model to return STRICT JSON only (no markdown).
    const system = `
You are PJiFitness "Workout Coach".
Return ONLY valid JSON. No markdown, no backticks, no commentary.

You generate a single workout session that is:
- Safe and realistic for the user's experience level.
- Uses available equipment.
- Fits within the time limit.
- Includes progressive overload guidance for next time.
- Includes a short "coach_focus" message (1-3 bullets) based on their last workout and trends.

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
      "sets": number,
      "reps": "string (e.g. 8-10)",
      "rest_seconds": number,
      "tempo": "string (optional)",
      "rpe": "string (optional)",
      "notes": "string (optional)",
      "alternatives": ["string", ...] (optional)
    }
  ],
  "finisher": "string (optional)",
  "cooldown": ["string", ...],
  "coach_focus": ["string", ...],
  "next_time_adjustments": [
    {
      "exercise": "string",
      "adjustment": "string"
    }
  ],
  "safety_notes": ["string", ...]
}
`;

    const user = `
User goal: ${goal}
Experience: ${experience}
Session type requested: ${sessionType}
Time limit (minutes): ${timeMinutes}
Equipment available: ${equipment.length ? equipment.join(", ") : "unspecified / typical gym"}

Extra notes: ${notes || "(none)"}

Last workout (if provided): ${lastWorkout ? JSON.stringify(lastWorkout) : "(none)"}
Recent workout history (if provided): ${history.length ? JSON.stringify(history.slice(-6)) : "(none)"}

Generate the workout session JSON now.
`;

    // -----------------------------
    // Call OpenAI (Responses API style)
    // -----------------------------
    // Note: This uses the newer /v1/responses endpoint and asks for JSON output.
    // If your project uses a different model name, you can swap it below.
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
        // Ask for JSON-only output
        text: { format: { type: "json_object" } },
        max_output_tokens: 1200
      })
    });

    if (!oaiResp.ok) {
      const errText = await oaiResp.text();
      debug.openaiStatus = oaiResp.status;
      debug.openaiError = errText?.slice(0, 5000);
      return res.status(500).json({ error: "OpenAI request failed", debug });
    }

    const data = await oaiResp.json();

    // Extract text from the response object
    // Responses API can return output_text in different shapes; this is a robust fallback.
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
      // Sometimes the model returns JSON-like text; capture for debugging.
      debug.parseError = String(e);
      debug.outputPreview = outputText.slice(0, 2000);
      return res.status(500).json({ error: "Model returned invalid JSON", debug });
    }

    // -----------------------------
    // Minimal validation / cleanup
    // -----------------------------
    workout = normalizeWorkout(workout, { sessionType, timeMinutes });

    // -----------------------------
    // Saving (stub) - OFF in preview
    // -----------------------------
    if (allowSave) {
      // Put your "save workout history" logic here later.
      // For V1, I recommend you keep saving OFF until the UI is stable.
      debug.save = "skipped (not implemented)";
    } else {
      debug.save = IS_PROD ? "off" : "preview_no_save";
    }

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

  if (!w.title) w.title = "Workout Session";
  if (!w.session_type) w.session_type = sessionType || "full_body";
  if (!Number.isFinite(Number(w.duration_minutes))) w.duration_minutes = timeMinutes || 45;

  if (!Array.isArray(w.warmup)) w.warmup = [];
  if (!Array.isArray(w.exercises)) w.exercises = [];
  if (!Array.isArray(w.cooldown)) w.cooldown = [];
  if (!Array.isArray(w.coach_focus)) w.coach_focus = [];
  if (!Array.isArray(w.next_time_adjustments)) w.next_time_adjustments = [];
  if (!Array.isArray(w.safety_notes)) w.safety_notes = [];

  // Ensure each exercise has basic fields
  w.exercises = w.exercises
    .filter(Boolean)
    .map(ex => {
      const e = (ex && typeof ex === "object") ? ex : {};
      if (!e.name) e.name = "Exercise";
      if (!e.category) e.category = "accessory";
      if (!Number.isFinite(Number(e.sets))) e.sets = 3;
      if (!e.reps) e.reps = "8-12";
      if (!Number.isFinite(Number(e.rest_seconds))) e.rest_seconds = 90;
      return e;
    });

  return w;
}
