// /api/generate-workouts.js
//
// PJiFitness - Generate NEXT workout prescription (V1)
// - Returns JSON: { workout, debug }
// - Workout includes exact per-set WEIGHTS + REPS
//
// Requires POST with last_workout for real prescriptions.

export default async function handler(req, res) {
  // -----------------------------
  // CORS (set FIRST)
  // -----------------------------
  const origin = req.headers.origin || "";
  const allowlist = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
    // add myshopify preview origin here if you ever need it
  ]);
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

  // PING
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "generate-workouts",
      vercelEnv: process.env.VERCEL_ENV || "unknown",
      ts: Date.now()
    });
  }

  // SMOKE
  if (req.method === "POST" && req.headers["x-pj-smoke"] === "1") {
    return res.status(200).json({ ok: true, smoke: true, ts: Date.now() });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const debug = {};
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    debug.hasOpenAIKey = !!OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY env var", debug });
    }

    debug.vercelEnv = process.env.VERCEL_ENV || "unknown";

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

    if (!lastWorkout || !Array.isArray(lastWorkout.exercises)) {
      return res.status(400).json({
        error: "Missing last_workout with exercises[]. Needed to prescribe weights/reps.",
        debug
      });
    }

    // ✅ reduce payload size (faster / cheaper / less likely to time out)
    const compactLast = compactWorkout(lastWorkout);
    const compactHist = history.slice(-2).map(compactWorkout);

    // -----------------------------
    // OpenAI prompt (faster & stricter)
    // -----------------------------
    const system = `
You are PJiFitness Workout Coach.
Return ONLY valid JSON (no markdown).

Goal: produce the user's NEXT workout using progressive overload.
You MUST prescribe exact weight (lbs) and reps for EACH SET.

RULES:
- Base on last workout performance. Use reps-first progression.
- If last set reps dropped (fatigue), keep weight same and target +1 rep on earlier sets, or keep reps and add small weight only if performance was strong.
- Upper increments: +2.5 to +5 lbs. Lower: +5 to +10 lbs.
- Keep it realistic: 4–7 exercises.

STRICT JSON schema (no extra keys):
{
  "title": "string",
  "session_type": "string",
  "duration_minutes": number,
  "exercises": [
    { "name": "string", "sets": [ { "w": number, "r": number } ], "rest_seconds": number, "notes": "string" }
  ],
  "coach_focus": ["string"],
  "safety_notes": ["string"]
}
`;

    const user = `
Goal: ${goal}
Experience: ${experience}
Session type: ${sessionType}
Time (min): ${timeMinutes}
Equipment: ${equipment.length ? equipment.join(", ") : "typical gym"}
Notes: ${notes || "(none)"}

Last workout (completed sets):
${JSON.stringify(compactLast)}

Recent history:
${compactHist.length ? JSON.stringify(compactHist) : "(none)"}

Return NEXT workout JSON now.
`;

    // -----------------------------
    // Call OpenAI (increase timeout)
    // -----------------------------
    const model = process.env.OPENAI_WORKOUT_MODEL || "gpt-4.1-mini";
    debug.model = model;

    const started = Date.now();
    debug.step = "before_openai";

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
          // ✅ keep tokens smaller so it returns faster
          max_output_tokens: 1100,
          temperature: 0.3
        })
      },
      28000 // ✅ 28s timeout (fixes your 12s abort)
    );

    debug.openai_ms = Date.now() - started;
    debug.step = "after_openai";

    if (!oaiResp.ok) {
      const errText = await oaiResp.text();
      debug.openaiStatus = oaiResp.status;
      debug.openaiError = errText?.slice(0, 2000);
      return res.status(500).json({ error: "OpenAI request failed", debug });
    }

    const data = await oaiResp.json();

    const outputText =
      data?.output_text ||
      data?.output?.[0]?.content?.find?.(c => c?.type === "output_text")?.text ||
      "";

    if (!outputText || typeof outputText !== "string") {
      debug.noOutput = true;
      return res.status(500).json({ error: "No output from model", debug });
    }

    let workout;
    try {
      workout = JSON.parse(outputText);
    } catch (e) {
      debug.parseError = String(e);
      debug.outputPreview = outputText.slice(0, 1000);
      return res.status(500).json({ error: "Model returned invalid JSON", debug });
    }

    workout = normalizeWorkout(workout, { sessionType, timeMinutes, lastWorkout: compactLast });

    return res.status(200).json({ workout, debug });
  } catch (err) {
    const name = err?.name || "";
    const msg = String(err);

    // ✅ if OpenAI timed out, return a clear message (not “Unhandled error”)
    if (name === "AbortError") {
      return res.status(504).json({
        error: "OpenAI timeout (took too long). Try again.",
        debug: { ...debug, name, message: msg }
      });
    }

    return res.status(500).json({
      error: "Unhandled error",
      debug: {
        ...debug,
        message: msg,
        name,
        stack: err?.stack ? String(err.stack).slice(0, 1200) : ""
      }
    });
  }
}

// -----------------------------
// Helpers
// -----------------------------
async function fetchWithTimeout(url, options = {}, ms = 28000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function compactWorkout(w) {
  try {
    const out = {
      date: w?.date || "",
      split: w?.split || w?.session_type || "",
      workout_name: w?.workout_name || "",
      exercises: []
    };
    const exs = Array.isArray(w?.exercises) ? w.exercises : [];
    out.exercises = exs.slice(0, 8).map(ex => {
      const sets = Array.isArray(ex?.sets) ? ex.sets : [];
      const done = sets.filter(s => s && (s.done === true || s.done === "true"));
      const use = done.length ? done : sets;
      return {
        name: ex?.name || "",
        sets: use.slice(0, 5).map(s => ({ w: Number(s.w) || 0, r: Number(s.r) || 0 }))
      };
    });
    return out;
  } catch {
    return w;
  }
}

function normalizeWorkout(workout, { sessionType, timeMinutes, lastWorkout }) {
  const w = (workout && typeof workout === "object") ? workout : {};

  if (!w.title) w.title = "Next Workout";
  if (!w.session_type) w.session_type = sessionType || (lastWorkout?.split || "full_body");
  if (!Number.isFinite(Number(w.duration_minutes))) w.duration_minutes = timeMinutes || 60;

  if (!Array.isArray(w.exercises)) w.exercises = [];
  if (!Array.isArray(w.coach_focus)) w.coach_focus = [];
  if (!Array.isArray(w.safety_notes)) w.safety_notes = [];

  w.exercises = w.exercises
    .filter(Boolean)
    .slice(0, 10)
    .map(ex => {
      const e = (ex && typeof ex === "object") ? ex : {};
      if (!e.name) e.name = "Exercise";
      if (!Number.isFinite(Number(e.rest_seconds))) e.rest_seconds = 90;
      if (typeof e.notes !== "string") e.notes = "";

      if (!Array.isArray(e.sets)) e.sets = [];
      e.sets = e.sets
        .filter(Boolean)
        .slice(0, 6)
        .map(s => ({ w: Number(s.w) || 0, r: Number(s.r) || 0 }))
        .filter(s => s.w > 0 && s.r > 0);

      // If model fails, fallback to last workout baseline
      if (!e.sets.length) {
        const base = findBaselineForExercise(lastWorkout, e.name) || { w: 0, r: 8 };
        e.sets = [{ w: base.w, r: base.r }, { w: base.w, r: base.r }, { w: base.w, r: base.r }];
      }

      return e;
    });

  return w;
}

function findBaselineForExercise(lastWorkout, exName) {
  try {
    const name = String(exName || "").toLowerCase();
    const exs = Array.isArray(lastWorkout?.exercises) ? lastWorkout.exercises : [];
    for (const ex of exs) {
      const n = String(ex?.name || "").toLowerCase();
      if (!n) continue;
      if (n === name || n.includes(name) || name.includes(n)) {
        const sets = Array.isArray(ex?.sets) ? ex.sets : [];
        const last = sets[sets.length - 1];
        const w = Number(last?.w);
        const r = Number(last?.r);
        if (Number.isFinite(w) && w > 0 && Number.isFinite(r) && r > 0) return { w, r };
      }
    }
    return null;
  } catch {
    return null;
  }
}
