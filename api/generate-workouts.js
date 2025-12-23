// /api/generate-workouts.js
//
// PJiFitness - Generate NEXT workout prescription (V1)
// - Returns JSON: { workout, debug }
// - Workout includes exact per-set WEIGHTS + REPS for progressive overload
//
// Expects POST JSON body:
// {
//   goal, experience, session_type, equipment, time_minutes, notes,
//   last_workout: {
//     date, split, workout_name,
//     exercises:[{name, sets:[{w,r,done}]}]
//   },
//   history: [...]
// }

export default async function handler(req, res) {
  // -----------------------------
  // ✅ CORS MUST BE SET FIRST (before any early returns)
  // -----------------------------
  const origin = req.headers.origin || "";

  // Allow your live site + optional myshopify previews
  const allowlist = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
    // If you test from theme preview and see CORS again, add:
    // "https://YOUR-STORE.myshopify.com"
  ]);

  // If origin is in allowlist, echo it back. Otherwise default to main site.
  const allowOrigin = allowlist.has(origin) ? origin : "https://www.pjifitness.com";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, x-pj-smoke"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  // -----------------------------
  // ✅ PING + SMOKE TEST (DEPLOY VERIFICATION)
  // -----------------------------
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "generate-workouts",
      vercelEnv: process.env.VERCEL_ENV || "unknown",
      ts: Date.now()
    });
  }

  if (req.method === "POST" && req.headers["x-pj-smoke"] === "1") {
    return res.status(200).json({ ok: true, smoke: true, ts: Date.now() });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const debug = {};
  try {
    console.log("generate-workouts hit", new Date().toISOString());

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    debug.hasOpenAIKey = !!OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var", debug });
    }

    const VERCEL_ENV = process.env.VERCEL_ENV || "unknown";
    debug.vercelEnv = VERCEL_ENV;

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

    // Require last_workout for real overload prescriptions
    if (!lastWorkout || !Array.isArray(lastWorkout.exercises)) {
      return res.status(400).json({
        error:
          "Missing last_workout with exercises[]. Needed to prescribe weights/reps for progressive overload.",
        debug
      });
    }

    // -----------------------------
    // Build OpenAI prompt
    // -----------------------------
    const system = `
You are PJiFitness "Workout Coach".
Return ONLY valid JSON. No markdown, no backticks, no commentary.

You are generating the user's NEXT workout session using progressive overload.

You MUST prescribe exact WEIGHT (lbs) and REPS for EACH SET for EACH EXERCISE.

Progressive overload rules:
- Use the last workout (completed sets) as the baseline.
- Prefer adding reps first within a rep range. When top reps are achieved with good performance, increase weight next time.
- Typical increments: upper body +2.5 to +5 lbs; lower body +5 to +10 lbs (unless last set was near failure).
- If user underperformed (reps dropped, likely form breakdown), keep weight similar and prescribe a smaller rep target OR reduce weight slightly.
- Keep it realistic: 4–8 exercises. Mostly 6–12 reps for hypertrophy. Sensible rest times.

IMPORTANT JSON SCHEMA (STRICT):
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

Last workout (as provided):
${JSON.stringify(lastWorkout, null, 2)}

Recent history (optional):
${history.length ? JSON.stringify(history.slice(-4), null, 2) : "(none)"}

Task:
Generate the NEXT workout JSON now.
- Use the same split focus as last workout if relevant.
- Prescribe exact per-set weights+reps that represent realistic progressive overload.
`;

    // -----------------------------
    // Call OpenAI (Responses API) WITH TIMEOUT
    // -----------------------------
    const model = process.env.OPENAI_WORKOUT_MODEL || "gpt-4.1-mini";
    debug.model = model;

    const started = Date.now();

    const oaiResp = await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          text: { format: { type: "json_object" } },
          max_output_tokens: 1600,
          temperature: 0.4
        })
      },
      12000
    );

    debug.openai_ms = Date.now() - started;

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
      debug.noOutput = true;
      debug.raw = safeClip(data, 4000);
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

    workout = normalizeWorkout(workout, { sessionType, timeMinutes, lastWorkout });

    return res.status(200).json({ workout, debug });
  } catch (err) {
    return res.status(500).json({
      error: "Unhandled error",
      debug: {
        ...debug,
        message: String(err),
        name: err?.name || "",
        stack: err?.stack ? String(err.stack).slice(0, 2000) : ""
      }
    });
  }
}

// ------------------------------------
// Helpers
// ------------------------------------
async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function normalizeWorkout(workout, { sessionType, timeMinutes, lastWorkout }) {
  const w = (workout && typeof workout === "object") ? workout : {};

  if (!w.title) w.title = "Next Workout";
  if (!w.session_type) w.session_type = sessionType || (lastWorkout?.split || "full_body");
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

      if (!Array.isArray(e.sets)) e.sets = [];
      e.sets = e.sets
        .filter(Boolean)
        .slice(0, 6)
        .map(s => {
          const ss = (s && typeof s === "object") ? s : {};
          const wNum = Number(ss.w);
          const rNum = Number(ss.r);
          return {
            w: Number.isFinite(wNum) ? wNum : NaN,
            r: Number.isFinite(rNum) ? rNum : NaN
          };
        })
        .filter(s => Number.isFinite(s.w) && s.w > 0 && Number.isFinite(s.r) && s.r > 0);

      if (!e.sets.length) {
        const base = findBaselineForExercise(lastWorkout, e.name);
        const safeW = Number.isFinite(base?.w) ? base.w : 0;
        const safeR = Number.isFinite(base?.r) ? base.r : 8;
        e.sets = [{ w: safeW, r: safeR }, { w: safeW, r: safeR }, { w: safeW, r: safeR }];
      }

      return e;
    });

  return w;
}

function findBaselineForExercise(lastWorkout, exName) {
  try {
    if (!lastWorkout || !Array.isArray(lastWorkout.exercises)) return null;
    const name = String(exName || "").toLowerCase();

    for (const ex of lastWorkout.exercises) {
      const n = String(ex?.name || "").toLowerCase();
      if (!n) continue;
      if (n === name || n.includes(name) || name.includes(n)) {
        const sets = Array.isArray(ex.sets) ? ex.sets : [];
        const done = sets.filter(s => s && (s.done === true || s.done === "true"));
        const s = (done.length ? done[done.length - 1] : sets[sets.length - 1]) || null;
        if (s && s.w != null && s.r != null) {
          const wNum = Number(s.w);
          const rNum = Number(s.r);
          if (Number.isFinite(wNum) && Number.isFinite(rNum)) return { w: wNum, r: rNum };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function safeClip(obj, maxChars) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return obj;
    return s.slice(0, maxChars);
  } catch {
    return null;
  }
}
