// /api/generate-workouts.js
//
// PJiFitness - Generate NEXT workout prescription (V2 Smart)
// - Returns JSON: { workout, debug }
// - Uses OpenAI for structure/exercise selection
// - Then applies deterministic progressive overload logic so it's ALWAYS useful
//
// Requires POST with last_workout.exercises[] for real prescriptions.
// NEW: accepts current_workout (user-edited draft) to respect edits + improve coach_focus.

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

    const lastWorkoutRaw = body.last_workout || null;            // completed-only snapshot from History
    const historyRaw = Array.isArray(body.history) ? body.history : [];
    const currentWorkoutRaw = body.current_workout || null;      // user-edited draft from Today (may include uncompleted sets)

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
    const compactLast = compactWorkoutCompletedOnly(lastWorkoutRaw);
    const compactHist = historyRaw.slice(-3).map(compactWorkoutCompletedOnly);
    const compactCurrent = currentWorkoutRaw ? compactWorkoutAllSets(currentWorkoutRaw) : null;

    debug.hasLastWorkout = !!compactLast;
    debug.lastWorkoutExerciseCount = Array.isArray(compactLast?.exercises) ? compactLast.exercises.length : 0;

    debug.hasCurrentWorkout = !!compactCurrent;
    debug.currentWorkoutExerciseCount = Array.isArray(compactCurrent?.exercises) ? compactCurrent.exercises.length : 0;

    // -----------------------------
    // OpenAI prompt (structure + exercise selection)
    // We still require exact sets, but we will "smart-correct" them afterwards.
    // -----------------------------
    const system = `
You are PJiFitness Workout Coach.
Return ONLY valid JSON (no markdown). No extra keys.

Goal:
Create the NEXT workout based on last workout performance using progressive overload (reps-first).
Be consistent: keep most exercises the same as last workout unless there's a clear reason to swap.
If "Current edited workout draft" is provided, RESPECT it:
- Prefer the draft’s exercise list and order (the user edited it intentionally).
- If you swap an exercise, explain why briefly in that exercise's notes.

Prescribe exact weight (lbs) + reps for EACH SET.
IMPORTANT: If you are unsure of a weight (no data), you may set weight to 0 and keep reps.

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

Current edited workout draft (may include uncompleted sets; respect exercise list/order if present):
${compactCurrent ? JSON.stringify(compactCurrent) : "(none)"}

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
    // - respects user-edited draft (exercise list/order)
    // -----------------------------
    const smart = applySmartProgression({
      workout,
      lastWorkout: compactLast,
      history: compactHist,
      currentDraft: compactCurrent,
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

/**
 * Completed-only compacting (for History snapshots).
 * If sets include done flags, we keep only done sets.
 * If no done flags exist, we keep whatever is there.
 */
function compactWorkoutCompletedOnly(w) {
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

    out.exercises = out.exercises.filter((e) => e?.name && Array.isArray(e.sets) && e.sets.length);
    return out;
  } catch {
    return w;
  }
}

/**
 * All-sets compacting (for "Current edited workout draft")
 * Keeps all sets (including blanks) so we can respect user edits and preserve shape.
 */
function compactWorkoutAllSets(w) {
  try {
    const out = {
      date: w?.date || "",
      split: w?.split || w?.session_type || "",
      workout_name: w?.workout_name || w?.title || "",
      exercises: [],
    };

    const exs = Array.isArray(w?.exercises) ? w.exercises : [];
    out.exercises = exs.slice(0, 12).map((ex) => {
      const sets = Array.isArray(ex?.sets) ? ex.sets : [];
      return {
        name: String(ex?.name || ""),
        sets: sets
          .filter(Boolean)
          .slice(0, 10)
          .map((s) => ({
            w: Number(s?.w) || 0,
            r: Number(s?.r) || 0,
            done: !!s?.done,
          })),
      };
    });

    out.exercises = out.exercises.filter((e) => e?.name);
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

  w.exercises = w.exercises
    .filter(Boolean)
    .slice(0, 10)
    .map((ex) => {
      const e = ex && typeof ex === "object" ? ex : {};
      e.name = String(e.name || "Exercise");
      e.rest_seconds = Number.isFinite(Number(e.rest_seconds)) ? Number(e.rest_seconds) : 90;
      e.notes = typeof e.notes === "string" ? e.notes : "";

      if (!Array.isArray(e.sets)) e.sets = [];
      e.sets = e.sets
        .filter(Boolean)
        .slice(0, 8)
        .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }));

      // IMPORTANT: do NOT invent heavy weights.
      // If model omitted sets entirely, keep a sane blank template.
      if (!e.sets.length) {
        e.sets = [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }];
      }

      return e;
    });

  // If model returned nothing useful, at least return a minimal skeleton
  if (!w.exercises.length) {
    w.exercises = [
      { name: "Exercise 1", sets: [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }], rest_seconds: 90, notes: "" },
      { name: "Exercise 2", sets: [{ w: 0, r: 10 }, { w: 0, r: 10 }], rest_seconds: 75, notes: "" },
      { name: "Exercise 3", sets: [{ w: 0, r: 12 }, { w: 0, r: 12 }], rest_seconds: 60, notes: "" },
    ];
  }

  return w;
}

function applySmartProgression({
  workout,
  lastWorkout,
  history,
  currentDraft,
  goal,
  experience,
  sessionType,
  timeMinutes,
  notes,
}) {
  const dbg = {
    usedFallbackExercises: false,
    fallbackSource: "",
    respectedDraftOrder: false,
    matchedExercises: 0,
    newExercises: 0,
    deloaded: false,
    progressionMode: "reps_first",
    completionMode: false,
  };

  const fatigueSignal = computeFatigueSignal(lastWorkout, currentDraft);
  dbg.fatigueSignal = fatigueSignal;
  dbg.deloaded = !!fatigueSignal.shouldDeload;

  // Completion mode: when completed volume was very low, we bias toward finishing everything
  // (but we don't force deload if draft indicates a normal session was intended).
  dbg.completionMode = fatigueSignal.veryLowVolume === true;

  // If model returned nonsense exercise list, fallback:
  // Prefer currentDraft list/order (user edits), else lastWorkout.
  if (!Array.isArray(workout.exercises) || workout.exercises.length < 3) {
    dbg.usedFallbackExercises = true;

    if (currentDraft?.exercises?.length) {
      dbg.fallbackSource = "currentDraft";
      workout.exercises = currentDraft.exercises.slice(0, 8).map((ex) => ({
        name: ex.name,
        sets: cloneDraftSetsOrBlank(ex, { defaultReps: 8 }),
        rest_seconds: defaultRestFor(ex.name),
        notes: "Using your edited exercise list; weights/reps will be prescribed from last performance when available.",
      }));
    } else {
      dbg.fallbackSource = "lastWorkout";
      workout.exercises = (lastWorkout?.exercises || []).slice(0, 8).map((ex) => ({
        name: ex.name,
        sets: (ex.sets || []).slice(0, 6).map((s) => ({ w: s.w, r: s.r })),
        rest_seconds: defaultRestFor(ex.name),
        notes: "",
      }));
    }
  }

  // Build map for last workout exercises by normalized name
  const lastMap = new Map();
  (lastWorkout?.exercises || []).forEach((ex) => {
    lastMap.set(normName(ex.name), ex);
  });

  // Respect draft order/names if present
  if (currentDraft?.exercises?.length) {
    const draftOrder = currentDraft.exercises
      .map((ex) => String(ex?.name || "").trim())
      .filter(Boolean)
      .slice(0, 8);

    if (draftOrder.length) {
      const modelMap = new Map();
      for (const ex of workout.exercises || []) {
        modelMap.set(normName(ex?.name), ex);
      }

      const rebuilt = [];
      for (const draftName of draftOrder) {
        const k = normName(draftName);
        const fromModel = modelMap.get(k) || findFuzzyMatch(workout.exercises || [], draftName);

        // pull draft sets (including blanks) so we preserve the user's shape
        const draftEx = (currentDraft.exercises || []).find((e) => normName(e?.name) === k) || null;
        const draftSets = draftEx ? cloneDraftSetsOrBlank(draftEx, { defaultReps: 8 }) : null;

        if (fromModel) {
          rebuilt.push({
            ...fromModel,
            name: draftName,
            sets: draftSets || fromModel.sets || [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }],
          });
        } else {
          rebuilt.push({
            name: draftName,
            sets: draftSets || [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }],
            rest_seconds: defaultRestFor(draftName),
            notes: "From your edited plan.",
          });
        }
      }

      workout.exercises = rebuilt;
      dbg.respectedDraftOrder = true;
    }
  }

  // Apply progression per exercise
  workout.exercises = workout.exercises.slice(0, 8).map((ex) => {
    const name = String(ex?.name || "Exercise");
    const key = normName(name);
    const lastEx = lastMap.get(key) || findFuzzyMatch(lastWorkout?.exercises || [], name);

    // If we have performance data, prescribe from it
    if (lastEx && Array.isArray(lastEx.sets) && lastEx.sets.length) {
      dbg.matchedExercises += 1;

      const nextSets = prescribeNextSets({
        name,
        lastSets: lastEx.sets,
        deload: dbg.deloaded,
      });

      return {
        name,
        sets: nextSets,
        rest_seconds: clamp(ex.rest_seconds || defaultRestFor(name), 30, 180),
        notes: improveExerciseNote(ex.notes, name, dbg.deloaded, dbg.completionMode),
      };
    }

    // Otherwise: DO NOT invent heavy weights.
    // Keep draft shape if it exists; otherwise baseline with w:0.
    dbg.newExercises += 1;

    const draftSets = Array.isArray(ex?.sets) ? ex.sets : [];
    const hasAnyNumbers = draftSets.some((s) => Number(s?.r) > 0 || Number(s?.w) > 0);

    const base = baselineForNewExercise(name, sessionType, experience, {
      preferSetCount: draftSets.length || null,
    });

    const setsToUse = hasAnyNumbers
      ? draftSets.map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || base.defaultReps }))
      : base.sets;

    return {
      name,
      sets: setsToUse,
      rest_seconds: clamp(ex.rest_seconds || base.rest_seconds, 30, 180),
      notes: improveExerciseNote(ex.notes, name, false, dbg.completionMode) || base.notes,
    };
  });

  workout.title = String(workout.title || "").trim() || smartTitle(sessionType, dbg.deloaded);

  workout.coach_focus = buildCoachFocus({
    goal,
    experience,
    sessionType,
    title: workout.title,
    deload: dbg.deloaded,
    completionMode: dbg.completionMode,
    lastWorkout,
    workout,
    notes,
    currentDraft,
  });

  workout.safety_notes = buildSafetyNotes({ sessionType, deload: dbg.deloaded });

  workout.session_type = normalizeSessionType(workout.session_type || sessionType);
  workout.duration_minutes = clamp(Number(workout.duration_minutes || timeMinutes) || timeMinutes, 20, 120);

  // IMPORTANT: do NOT filter out blank sets.
  // UI needs blanks to show "— x reps" and allow user entry.
  workout.exercises = workout.exercises.map((ex) => ({
    ...ex,
    sets: (ex.sets || []).slice(0, 8).map((s) => ({
      w: Number(s?.w) || 0,
      r: Number(s?.r) || 0,
    })),
  }));

  return { workout, debug: dbg };
}

function cloneDraftSetsOrBlank(draftEx, { defaultReps = 8 } = {}) {
  const sets = Array.isArray(draftEx?.sets) ? draftEx.sets : [];
  if (!sets.length) return [{ w: 0, r: defaultReps }, { w: 0, r: defaultReps }, { w: 0, r: defaultReps }];
  return sets.slice(0, 8).map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || defaultReps }));
}

function computeFatigueSignal(lastWorkout, currentDraft) {
  const exs = Array.isArray(lastWorkout?.exercises) ? lastWorkout.exercises : [];
  let totalSets = 0;
  let bigDropCount = 0;

  for (const ex of exs) {
    const sets = Array.isArray(ex?.sets) ? ex.sets : [];
    totalSets += sets.length;

    if (sets.length >= 3) {
      const first = Number(sets[0]?.r) || 0;
      const last = Number(sets[sets.length - 1]?.r) || 0;
      if (first >= 6 && last > 0 && first - last >= 3) bigDropCount += 1;
    }
  }

  const veryLowVolume = totalSets <= 6;

  const draftSetCount = countDraftSets(currentDraft);
  const draftLooksNormal = draftSetCount >= 10;

  const shouldDeload = bigDropCount >= 2 || (veryLowVolume && !draftLooksNormal);

  return { shouldDeload, totalSets, bigDropCount, veryLowVolume, draftSetCount, draftLooksNormal };
}

function countDraftSets(currentDraft) {
  try {
    const exs = Array.isArray(currentDraft?.exercises) ? currentDraft.exercises : [];
    let n = 0;
    for (const ex of exs) {
      const sets = Array.isArray(ex?.sets) ? ex.sets : [];
      n += sets.length;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Smarter progression:
 * - Preserves per-set weights (important for ramp sets like 45/50/75)
 * - Reps-first: +1 rep on first 1–2 work sets if not deloading
 * - Never regresses reps/weight unless deload
 */
function prescribeNextSets({ name, lastSets, deload }) {
  const cleaned = (lastSets || [])
    .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
    .filter((s) => s.w > 0 && s.r > 0)
    .slice(0, 6);

  const isCompound = isCompoundLift(name);
  const targetSetCount = isCompound ? 3 : 2;

  // If no valid sets, return blanks
  if (!cleaned.length) {
    const reps = isCompound ? 6 : 12;
    const sets = isCompound ? 3 : 2;
    return Array.from({ length: sets }).map(() => ({ w: 0, r: reps }));
  }

  // Deload: reduce each set weight but keep reps in a safe range
  if (deload) {
    const dropPct = isCompound ? 0.10 : 0.08;
    const take = Math.min(targetSetCount, cleaned.length);
    return cleaned.slice(0, take).map((s) => ({
      w: roundToIncrement(s.w * (1 - dropPct), isCompound ? 5 : 2.5),
      r: clampInt(s.r, isCompound ? 5 : 8, isCompound ? 10 : 15),
    }));
  }

  // Determine if this looks like a ramp (weights vary meaningfully)
  const ws = cleaned.map((s) => s.w);
  const wMin = Math.min(...ws);
  const wMax = Math.max(...ws);
  const isRamp = (wMax - wMin) >= 5; // dumbbell reality: 5+ lbs difference means ramp/top set

  const out = [];
  const take = Math.min(targetSetCount, cleaned.length);

  for (let i = 0; i < take; i++) {
    const base = cleaned[i] || cleaned[0];
    const bump = i < 2 ? 1 : 0; // reps-first on first 2 sets
    const newR = clampInt(base.r + bump, isCompound ? 4 : 8, isCompound ? 12 : 15);

    // For ramp sets, do not change weights automatically (keep per-set w)
    out.push({ w: base.w, r: newR });
  }

  // If NOT ramp and reps are at the top of range, allow a small weight bump
  if (!isRamp) {
    const repRangeTop = isCompound ? 10 : 15;
    const avgR = Math.round(cleaned.slice(0, take).reduce((a, b) => a + b.r, 0) / Math.max(1, take));
    const atTop = avgR >= repRangeTop;

    if (atTop) {
      const baseW = cleaned[0].w;
      const inc = isCompound ? pickIncrement(baseW, 5, 10) : pickIncrement(baseW, 2.5, 5);
      const newW = roundToIncrement(baseW + inc, isCompound ? 5 : 2.5);
      const targetR = isCompound ? 6 : 10;
      return Array.from({ length: take }).map(() => ({ w: newW, r: targetR }));
    }
  }

  return out;
}

function buildCoachFocus({ goal, experience, sessionType, title, deload, completionMode, lastWorkout, workout, notes, currentDraft }) {
  const g = String(goal || "").toLowerCase();
  const goalText =
    g.includes("fat") ? "fat loss while keeping strength" :
    g.includes("maintenance") ? "maintenance and consistency" :
    "building muscle with steady progression";

  const mainLift = (workout?.exercises?.[0]?.name || "your first movement").trim();

  const fatigueLine = deload
    ? "Today is a controlled deload: move crisp, stop with 2–3 reps in reserve, and leave the gym feeling better than you arrived."
    : completionMode
    ? "Today is completion-focused: keep loads honest, finish every planned set, and make every rep look the same before chasing heavier weight."
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
    `Pacing: rest fully on ${mainLift}, then keep accessories moving so you finish in ~${workout?.duration_minutes || 60} minutes.`;

  const formLine =
    `Form cue for ${mainLift}: control the lowering phase, keep a tight core/bracing, and make every rep look the same.`;

  const draftLine =
    currentDraft?.exercises?.length
      ? "Your edits were respected: the exercise order is based on your current workout draft so the plan matches what you actually want to do."
      : "";

  const noteLine = notes ? `Coach note: ${notes}` : "";

  const bullets = [sessionLine, `Overall goal: ${goalText}, so we’re prioritizing high-quality reps and consistency over ego-lifting.`, fatigueLine, rpeLine, pacingLine, formLine, draftLine, noteLine]
    .filter(Boolean);

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

function improveExerciseNote(note, name, deload, completionMode) {
  const n = String(note || "").trim();
  if (n) return n.slice(0, 160);

  const lower = String(name || "").toLowerCase();
  if (completionMode) return "Completion focus: keep loads realistic and finish every set with clean form before progressing.";

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

function baselineForNewExercise(name, sessionType, experience, { preferSetCount = null } = {}) {
  const compound = isCompoundLift(name);
  const rest = compound ? 90 : 60;

  const reps = compound ? 6 : 12;
  const defaultSets = compound ? 3 : 2;

  const sets = clampInt(preferSetCount || defaultSets, 1, 6);

  // IMPORTANT: default weight for new/unmatched exercise should be blank (0), not invented.
  const defaultW = 0;

  return {
    rest_seconds: rest,
    notes: "New/untracked movement: start conservative, keep form strict, and enter a weight you can complete cleanly for all sets.",
    defaultReps: reps,
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
  const w = Number(currentW) || 0;
  if (w >= 225) return hi;
  return lo;
}
