// /api/generate-workouts.js
//
// PJiFitness - Generate NEXT workout prescription (V2 Smart)
// - Returns JSON: { workout, debug }
// - Uses OpenAI for structure/exercise selection
// - Then applies deterministic progressive overload logic so it's ALWAYS useful
//
// Requires POST with last_workout.exercises[] for real prescriptions.

export default async function handler(req, res) {
  // -----------------------------
  // CORS (set FIRST)
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
    "Content-Type, Authorization, X-Requested-With, Accept, x-pj-smoke"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  // PING
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "generate-workouts",
      vercelEnv: process.env.VERCEL_ENV || "unknown",
      ts: Date.now(),
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
    const goal = String(body.goal || "muscle_gain");
    const experience = String(body.experience || "intermediate");
    const sessionTypeIn = String(body.session_type || "full_body");
    const sessionType = normalizeSessionType(sessionTypeIn);
    const equipment = Array.isArray(body.equipment) ? body.equipment : [];
    const timeMinutes = Number.isFinite(Number(body.time_minutes)) ? Number(body.time_minutes) : 60;
    const notes = String(body.notes || "");
    const lastWorkoutRaw = body.last_workout || null;
    const historyRaw = Array.isArray(body.history) ? body.history : [];

    debug.goal = goal;
    debug.experience = experience;
    debug.sessionType = sessionType;
    debug.timeMinutes = timeMinutes;

    if (!lastWorkoutRaw || !Array.isArray(lastWorkoutRaw.exercises)) {
      return res.status(400).json({
        error: "Missing last_workout with exercises[]. Needed to prescribe weights/reps.",
        debug,
      });
    }

    // Compact inputs (lower tokens / faster)
    const compactLast = compactWorkout(lastWorkoutRaw);
    const compactHist = historyRaw.slice(-3).map(compactWorkout);

    debug.hasLastWorkout = !!compactLast;
    debug.lastWorkoutExerciseCount = Array.isArray(compactLast?.exercises) ? compactLast.exercises.length : 0;

    // -----------------------------
    // OpenAI prompt (structure + exercise selection)
    // We still require exact sets, but we will "smart-correct" them afterwards.
    // -----------------------------
    const system = `
You are PJiFitness Workout Coach.
Return ONLY valid JSON (no markdown). No extra keys.

Goal:
Create the NEXT workout based on the last workout performance using progressive overload (reps-first).
Be consistent: keep most exercises the same as last workout unless there's a clear reason to swap.
Prescribe exact weight (lbs) + reps for EACH SET.

Coach Focus requirement:
coach_focus MUST be "amazing": 4–6 detailed bullets that explain:
- the purpose of today’s workout (the goal)
- the main lift focus & how to progress
- effort target (RPE / leaving reps in reserve)
- pacing/rest guidance
- one or two key form cues
Write each bullet as a complete sentence.

Safety notes: 2–4 clear bullets.

STRICT JSON schema:
{
  "title": "string",
  "session_type": "upper_body|lower_body|full_body",
  "duration_minutes": number,
  "exercises": [
    { "name": "string", "sets": [ { "w": number, "r": number } ], "rest_seconds": number, "notes": "string" }
  ],
  "coach_focus": ["string"],
  "safety_notes": ["string"]
}
`.trim();

    const user = `
Goal: ${goal}
Experience: ${experience}
Session type: ${sessionType}
Time (min): ${timeMinutes}
Equipment: ${equipment.length ? equipment.join(", ") : "typical gym"}
Notes: ${notes || "(none)"}

Last workout (completed sets only):
${JSON.stringify(compactLast)}

Recent history:
${compactHist.length ? JSON.stringify(compactHist) : "(none)"}

Return NEXT workout JSON now.
`.trim();

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
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          text: { format: { type: "json_object" } },
          max_output_tokens: 1200,
          temperature: 0.25,
        }),
      },
      28000
    );

    debug.openai_ms = Date.now() - started;
    debug.step = "after_openai";

    let workoutFromModel = null;

    if (!oaiResp.ok) {
      const errText = await oaiResp.text();
      debug.openaiStatus = oaiResp.status;
      debug.openaiError = errText?.slice(0, 2000);
      // We'll still return a deterministic fallback workout
      debug.fallbackReason = "openai_failed";
    } else {
      const data = await oaiResp.json();
      const outputText =
        data?.output_text ||
        data?.output?.[0]?.content?.find?.((c) => c?.type === "output_text")?.text ||
        "";

      if (!outputText || typeof outputText !== "string") {
        debug.noOutput = true;
        debug.fallbackReason = "openai_no_output";
      } else {
        try {
          workoutFromModel = JSON.parse(outputText);
        } catch (e) {
          debug.parseError = String(e);
          debug.outputPreview = outputText.slice(0, 1000);
          debug.fallbackReason = "openai_invalid_json";
        }
      }
    }

    // -----------------------------
    // Normalize model output
    // -----------------------------
    let workout = normalizeWorkout(workoutFromModel, {
      sessionType,
      timeMinutes,
    });

    // -----------------------------
    // SMART CORE: Apply deterministic progressive overload
    // - ensures weights/reps are actually based on last workout performance
    // - keeps workout stable and useful every time
    // -----------------------------
    const smart = applySmartProgression({
      workout,
      lastWorkout: compactLast,
      history: compactHist,
      goal,
      experience,
      sessionType,
      timeMinutes,
      notes,
    });

    workout = smart.workout;
    debug.smart = smart.debug;

    return res.status(200).json({ workout, debug });
  } catch (err) {
    const name = err?.name || "";
    const msg = String(err);

    if (name === "AbortError") {
      return res.status(504).json({
        error: "OpenAI timeout (took too long). Try again.",
        debug: { ...debug, name, message: msg },
      });
    }

    return res.status(500).json({
      error: "Unhandled error",
      debug: {
        ...debug,
        message: msg,
        name,
        stack: err?.stack ? String(err.stack).slice(0, 1200) : "",
      },
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

function normalizeSessionType(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("lower") || s.includes("leg")) return "lower_body";
  if (s.includes("upper") || s.includes("push") || s.includes("pull")) return "upper_body";
  return "full_body";
}

function compactWorkout(w) {
  try {
    const out = {
      date: w?.date || "",
      split: w?.split || w?.session_type || "",
      workout_name: w?.workout_name || w?.title || "",
      exercises: [],
    };

    const exs = Array.isArray(w?.exercises) ? w.exercises : [];
    out.exercises = exs.slice(0, 10).map((ex) => {
      const sets = Array.isArray(ex?.sets) ? ex.sets : [];
      // prefer completed sets if present
      const done = sets.filter((s) => s && (s.done === true || s.done === "true"));
      const use = done.length ? done : sets;
      return {
        name: String(ex?.name || ""),
        sets: use
          .filter(Boolean)
          .slice(0, 8)
          .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
          .filter((s) => s.w > 0 && s.r > 0),
      };
    });

    // remove exercises that have no usable sets
    out.exercises = out.exercises.filter((e) => e?.name && Array.isArray(e.sets) && e.sets.length);
    return out;
  } catch {
    return w;
  }
}

function normalizeWorkout(workout, { sessionType, timeMinutes }) {
  const w = workout && typeof workout === "object" ? workout : {};

  if (!w.title) w.title = "Next Workout";
  w.session_type = normalizeSessionType(w.session_type || sessionType || "full_body");
  if (!Number.isFinite(Number(w.duration_minutes))) w.duration_minutes = timeMinutes || 60;

  if (!Array.isArray(w.exercises)) w.exercises = [];
  if (!Array.isArray(w.coach_focus)) w.coach_focus = [];
  if (!Array.isArray(w.safety_notes)) w.safety_notes = [];

  // Keep list tight (UI + time)
  w.exercises = w.exercises
    .filter(Boolean)
    .slice(0, 8)
    .map((ex) => {
      const e = ex && typeof ex === "object" ? ex : {};
      e.name = String(e.name || "Exercise");
      e.rest_seconds = Number.isFinite(Number(e.rest_seconds)) ? Number(e.rest_seconds) : 90;
      e.notes = typeof e.notes === "string" ? e.notes : "";

      if (!Array.isArray(e.sets)) e.sets = [];
      e.sets = e.sets
        .filter(Boolean)
        .slice(0, 6)
        .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
        .filter((s) => s.w > 0 && s.r > 0);

      // If model gave nothing usable, fill with placeholder (will be replaced by smart progression)
      if (!e.sets.length) {
        e.sets = [{ w: 95, r: 8 }, { w: 95, r: 8 }, { w: 95, r: 8 }];
      }

      return e;
    });

  return w;
}

function applySmartProgression({
  workout,
  lastWorkout,
  history,
  goal,
  experience,
  sessionType,
  timeMinutes,
  notes,
}) {
  const dbg = {
    usedFallbackExercises: false,
    matchedExercises: 0,
    newExercises: 0,
    deloaded: false,
    progressionMode: "reps_first",
  };

  // If model returned nonsense exercise list, fallback to last workout exercise order
  if (!Array.isArray(workout.exercises) || workout.exercises.length < 3) {
    dbg.usedFallbackExercises = true;
    workout.exercises = (lastWorkout?.exercises || []).slice(0, 6).map((ex) => ({
      name: ex.name,
      sets: (ex.sets || []).slice(0, 4).map((s) => ({ w: s.w, r: s.r })),
      rest_seconds: defaultRestFor(ex.name),
      notes: "",
    }));
  }

  // Determine if deload is needed:
  // - lots of missed volume signal (we only receive completed sets; so if sets count very low OR reps crashed)
  const fatigueSignal = computeFatigueSignal(lastWorkout);
  if (fatigueSignal.shouldDeload) dbg.deloaded = true;

  // Build map for last workout exercises by normalized name
  const lastMap = new Map();
  (lastWorkout?.exercises || []).forEach((ex) => {
    lastMap.set(normName(ex.name), ex);
  });

  // Apply progression per exercise
  workout.exercises = workout.exercises.slice(0, 7).map((ex) => {
    const name = String(ex?.name || "Exercise");
    const key = normName(name);
    const lastEx = lastMap.get(key) || findFuzzyMatch(lastWorkout?.exercises || [], name);

    if (lastEx && Array.isArray(lastEx.sets) && lastEx.sets.length) {
      dbg.matchedExercises += 1;
      const nextSets = prescribeNextSets({
        name,
        lastSets: lastEx.sets,
        deload: fatigueSignal.shouldDeload,
      });
      return {
        name,
        sets: nextSets,
        rest_seconds: clamp(ex.rest_seconds || defaultRestFor(name), 30, 180),
        notes: improveExerciseNote(ex.notes, name, fatigueSignal.shouldDeload),
      };
    }

    dbg.newExercises += 1;
    // New exercise: pick a sensible baseline (light/moderate), reps-first
    const base = baselineForNewExercise(name, sessionType, experience);
    return {
      name,
      sets: base.sets,
      rest_seconds: base.rest_seconds,
      notes: improveExerciseNote(ex.notes, name, false) || base.notes,
    };
  });

  // Title: keep model title if good, otherwise build a stable one
  workout.title = String(workout.title || "").trim() || smartTitle(sessionType, dbg.deloaded);

  // Strong Coach Focus + Safety Notes (always)
  workout.coach_focus = buildCoachFocus({
    goal,
    experience,
    sessionType,
    title: workout.title,
    deload: dbg.deloaded,
    lastWorkout,
    workout,
    notes,
  });

  workout.safety_notes = buildSafetyNotes({ sessionType, deload: dbg.deloaded });

  // Keep schema clean
  workout.session_type = normalizeSessionType(workout.session_type || sessionType);
  workout.duration_minutes = clamp(Number(workout.duration_minutes || timeMinutes) || timeMinutes, 20, 120);

  // Ensure sets are valid
  workout.exercises = workout.exercises.map((ex) => ({
    ...ex,
    sets: (ex.sets || []).filter((s) => Number(s.w) > 0 && Number(s.r) > 0).slice(0, 6),
  }));

  return { workout, debug: dbg };
}

function computeFatigueSignal(lastWorkout) {
  // Heuristics:
  // - if any big exercise shows major rep drop OR very low volume overall, consider deload
  const exs = Array.isArray(lastWorkout?.exercises) ? lastWorkout.exercises : [];
  let totalSets = 0;
  let bigDropCount = 0;

  for (const ex of exs) {
    const sets = Array.isArray(ex?.sets) ? ex.sets : [];
    totalSets += sets.length;

    if (sets.length >= 3) {
      const first = sets[0]?.r || 0;
      const last = sets[sets.length - 1]?.r || 0;
      if (first >= 6 && last > 0 && first - last >= 3) bigDropCount += 1;
    }
  }

  const veryLowVolume = totalSets <= 6; // completed-only snapshot; if super low, likely fatigue/time issue
  const shouldDeload = veryLowVolume || bigDropCount >= 2;

  return { shouldDeload, totalSets, bigDropCount };
}

function prescribeNextSets({ name, lastSets, deload }) {
  const sets = (lastSets || []).filter((s) => Number(s.w) > 0 && Number(s.r) > 0).slice(0, 5);
  const isCompound = isCompoundLift(name);

  // If deload: reduce weight 7–12% and keep reps similar (slightly easier)
  if (deload) {
    const dropPct = isCompound ? 0.10 : 0.08;
    return sets.slice(0, isCompound ? 3 : 2).map((s) => ({
      w: roundToIncrement(s.w * (1 - dropPct), isCompound ? 5 : 2.5),
      r: clampInt(s.r, isCompound ? 5 : 8, isCompound ? 10 : 15),
    }));
  }

  // Reps-first progression with fatigue check
  const reps = sets.map((s) => s.r);
  const weight = sets[0]?.w || 0;

  const firstR = reps[0] || 0;
  const lastR = reps[reps.length - 1] || 0;
  const fatigueDrop = firstR >= 6 && lastR > 0 && firstR - lastR >= 2;

  const targetSetCount = isCompound ? 3 : 2;

  // If fatigue drop: keep weight, add +1 rep to early sets only
  if (fatigueDrop) {
    const out = [];
    for (let i = 0; i < Math.min(targetSetCount, sets.length); i++) {
      const baseR = reps[i] || firstR || 8;
      const bump = i < 2 ? 1 : 0;
      out.push({ w: weight, r: clampInt(baseR + bump, isCompound ? 4 : 8, isCompound ? 12 : 15) });
    }
    return out;
  }

  // If strong performance: either add reps or small weight bump
  // Strong = last set within 1 rep of first set AND average reps decent
  const avgR = Math.round(reps.reduce((a, b) => a + b, 0) / Math.max(1, reps.length));
  const strong = lastR >= firstR - 1 && avgR >= (isCompound ? 6 : 10);

  // Prefer reps-first until top of range, then add weight
  const repRange = isCompound ? [5, 10] : [10, 15];
  const atTop = avgR >= repRange[1];

  if (strong && atTop) {
    // add weight, keep reps at mid-range
    const inc = isCompound ? pickIncrement(weight, 5, 10) : pickIncrement(weight, 2.5, 5);
    const newW = roundToIncrement(weight + inc, isCompound ? 5 : 2.5);
    const targetR = isCompound ? 6 : 10;
    return Array.from({ length: targetSetCount }).map(() => ({ w: newW, r: targetR }));
  }

  // Otherwise: add reps across sets (small)
  const out = [];
  for (let i = 0; i < targetSetCount; i++) {
    const base = sets[i] || sets[0] || { w: weight || 95, r: isCompound ? 6 : 10 };
    const add = i < 2 ? 1 : 0; // push first sets
    out.push({
      w: base.w,
      r: clampInt((base.r || (isCompound ? 6 : 10)) + add, repRange[0], repRange[1]),
    });
  }
  return out;
}

function buildCoachFocus({ goal, experience, sessionType, title, deload, lastWorkout, workout, notes }) {
  const g = String(goal || "").toLowerCase();
  const goalText =
    g.includes("fat") ? "fat loss while keeping strength" :
    g.includes("maintenance") ? "maintenance and consistency" :
    "building muscle with steady progression";

  const mainLift = (workout?.exercises?.[0]?.name || "your first movement").trim();

  const fatigueLine = deload
    ? "Today is a controlled deload: move crisp, stop with 2–3 reps in reserve, and leave the gym feeling better than you arrived."
    : "This is a progressive overload day: earn progression by cleaner reps first, then small weight bumps only when reps stay strong across sets.";

  const sessionLine =
    sessionType === "lower_body"
      ? "Goal of today: drive lower-body strength and solid hinge/squat patterns without grinding reps."
      : sessionType === "upper_body"
      ? "Goal of today: build upper-body strength and tension through full range, no sloppy momentum."
      : "Goal of today: full-body stimulus with smart effort—strong reps, controlled breathing, and consistent pacing.";

  const rpeLine =
    experience === "beginner"
      ? "Effort target: most sets should feel like you could do 2–3 more reps (easy technique focus)."
      : experience === "advanced"
      ? "Effort target: main sets around 1–2 reps in reserve; accessories controlled with clean tempo."
      : "Effort target: work sets around 1–2 reps in reserve; if form breaks, stop the set and keep the weight.";

  const pacingLine =
    "Pacing: take the full rest listed for your main lift, then keep accessories moving with steady rest so the session fits your time window.";

  const formLine =
    `Form cue for ${mainLift}: control the lowering phase, keep a tight core/bracing, and make every rep look the same.`;

  const noteLine = notes ? `Coach note: ${notes}` : "";

  // 4–6 bullets, detailed sentences (your UI supports long strings)
  const bullets = [sessionLine, fatigueLine, rpeLine, pacingLine, formLine].filter(Boolean);
  if (noteLine) bullets.push(noteLine);

  return bullets.slice(0, 6);
}

function buildSafetyNotes({ sessionType, deload }) {
  const base = [
    "Warm up 5–8 minutes and do 2–3 ramp-up sets before your first working set.",
    "Stop sets if pain (sharp/unstable) shows up; adjust range of motion or swap the movement.",
  ];

  const extra =
    sessionType === "lower_body"
      ? ["Brace before each rep on squats/hinges and keep the spine neutral—no rushed reps."]
      : sessionType === "upper_body"
      ? ["For pressing, keep shoulder blades set and don’t flare elbows excessively at the bottom."]
      : ["Maintain controlled breathing and core tension so fatigue doesn’t turn reps sloppy."];

  if (deload) {
    extra.push("Keep everything smooth today—no max efforts; the win is recovery + perfect reps.");
  } else {
    extra.push("Progress only if reps stay clean—don’t chase weight at the expense of form.");
  }

  return base.concat(extra).slice(0, 4);
}

function smartTitle(sessionType, deload) {
  const base =
    sessionType === "lower_body" ? "Lower Body Strength" :
    sessionType === "upper_body" ? "Upper Body Strength" :
    "Full Body Strength";
  return deload ? `${base} (Deload / Technique)` : `${base} (Progressive Overload)`;
}

function improveExerciseNote(note, name, deload) {
  const n = String(note || "").trim();
  if (n) return n.slice(0, 160);

  // lightweight auto-notes to make workout feel coached
  const lower = String(name || "").toLowerCase();
  if (/(squat|deadlift|rdl|romanian|hinge|leg press)/.test(lower)) {
    return deload
      ? "Technique day: control the lowering, keep brace tight, and stop 2–3 reps before failure."
      : "Brace hard, control the eccentric, and keep reps consistent—no grinding.";
  }
  if (/(bench|press|overhead|incline)/.test(lower)) {
    return deload
      ? "Smooth reps: keep shoulder blades set and avoid pushing to failure today."
      : "Full range, shoulder blades retracted, and avoid bouncing—earn progression with clean reps.";
  }
  if (/(row|pulldown|pull[- ]?up)/.test(lower)) {
    return "Pull with the back, not momentum—pause briefly at peak contraction.";
  }
  return deload ? "Keep tempo controlled; stop with reps in reserve." : "Control tempo; aim for consistent reps.";
}

function baselineForNewExercise(name, sessionType, experience) {
  const compound = isCompoundLift(name);
  const rest = compound ? 90 : 60;

  // conservative baseline reps
  const reps = compound ? 6 : 12;
  const sets = compound ? 3 : 2;

  // weight left blank in UI if 0, but your API requires >0; so use a safe starter.
  // This is only for brand-new exercises not in history.
  const defaultW = compound ? 95 : 25;

  return {
    rest_seconds: rest,
    notes: "New movement: start conservative, keep form strict, and adjust weight so reps are smooth.",
    sets: Array.from({ length: sets }).map(() => ({ w: defaultW, r: reps })),
  };
}

function defaultRestFor(name) {
  return isCompoundLift(name) ? 120 : 75;
}

function isCompoundLift(name) {
  const lower = String(name || "").toLowerCase();
  return /(squat|deadlift|bench|press|row|pull[- ]?up|pulldown|rdl|romanian|lunge|leg press)/.test(lower);
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findFuzzyMatch(exercises, name) {
  const target = normName(name);
  if (!target) return null;
  for (const ex of exercises || []) {
    const n = normName(ex?.name);
    if (!n) continue;
    if (n === target) return ex;
    if (n.includes(target) || target.includes(n)) return ex;
  }
  return null;
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function roundToIncrement(w, inc) {
  const x = Number(w);
  const step = Number(inc) || 2.5;
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.round(x / step) * step;
}

function pickIncrement(currentW, lo, hi) {
  // choose smaller increments for lighter weights, larger for heavier
  const w = Number(currentW) || 0;
  if (w >= 225) return hi;
  return lo;
}
