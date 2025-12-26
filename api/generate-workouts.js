// /api/generate-workouts.js
//
// PJiFitness - Generate NEXT workout prescription (V2 Smart)
// - Returns JSON: { workout, debug }
// - Uses OpenAI for structure/exercise selection
// - Then applies deterministic progressive overload logic so it's ALWAYS useful
//
// Requires POST with last_workout.exercises[].
// Accepts current_workout (user-edited draft).
// NEW:
//   - Uses more history (-10) for matching
//   - If no history match, uses current draft weights as baseline (if present)
//   - Adds coaching explanation fields (overall + per exercise)
//   - Adds "last_time" per exercise (matched sets + date) so UI can show trust-building context

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
    let sessionType = normalizeSessionType(sessionTypeIn);
    const equipment = Array.isArray(body.equipment) ? body.equipment : [];
    const timeMinutes = Number.isFinite(Number(body.time_minutes)) ? Number(body.time_minutes) : 60;
    const notes = String(body.notes || "");

    const lastWorkoutRaw = body.last_workout || null;
    const historyRaw = Array.isArray(body.history) ? body.history : [];
    const currentWorkoutRaw = body.current_workout || null;

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

    // -----------------------------
    // Compact inputs
    // -----------------------------
    const compactLast = compactWorkoutCompletedOnly(lastWorkoutRaw);

    // ✅ Use MORE history so matches actually happen
    const compactHist = historyRaw.slice(-10).map(compactWorkoutCompletedOnly);

    const compactCurrent = currentWorkoutRaw ? compactWorkoutAllSets(currentWorkoutRaw) : null;

    debug.hasLastWorkout = !!compactLast;
    debug.lastWorkoutExerciseCount = Array.isArray(compactLast?.exercises) ? compactLast.exercises.length : 0;

    debug.hasCurrentWorkout = !!compactCurrent;
    debug.currentWorkoutExerciseCount = Array.isArray(compactCurrent?.exercises) ? compactCurrent.exercises.length : 0;

    // ✅ Auto-correct session type if draft clearly contains upper + lower
    if (compactCurrent?.exercises?.length) {
      const names = compactCurrent.exercises.map((e) => normNameLoose(e?.name)).join(" ");
      const hasUpper = /(press|row|pull|cleanpress)/.test(names);
      const hasLower = /(squat|lunge|deadlift|rdl)/.test(names);
      if (hasUpper && hasLower) sessionType = "full_body";
    }
    debug.sessionType = sessionType;

    // -----------------------------
    // OpenAI prompt (structure + exercise selection)
    // -----------------------------
    // IMPORTANT:
    // - We still allow the model to propose structure/exercises/sets counts
    // - But we do NOT trust model weights; smart logic overwrites weights deterministically
    const system = `
You are PJiFitness Workout Coach.
Return ONLY valid JSON (no markdown). No extra keys.

Goal:
Create the NEXT workout using progressive overload (reps-first).
If "Current edited workout draft" is provided, RESPECT it:
- Prefer the draft’s exercise list and order.
- If you swap an exercise, explain why briefly in that exercise's notes.

Prescribe weight (lbs) + reps for EACH SET.
IMPORTANT: If you are unsure of a weight (no data), set weight to 0 and keep reps.

Coach Focus: 4–6 complete-sentence bullets.
Safety notes: 2–4 bullets.

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

Current edited workout draft (may include blanks; respect list/order):
${compactCurrent ? JSON.stringify(compactCurrent) : "(none)"}

Recent history (completed sets only):
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
          max_output_tokens: 1400,
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

    // Normalize model output
    let workout = normalizeWorkout(workoutFromModel, { sessionType, timeMinutes });

    // SMART CORE
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

function collapseSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normNameStrict(s) {
  return collapseSpaces(String(s || ""))
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normNameLoose(s) {
  const base = normNameStrict(s);
  return base
    .replace(/\b(dumbbell|dumbbells|db|barbell|bb|kettlebell|kb|machine|cable)\b/g, "")
    .replace(/\b(one arm|single arm)\b/g, "onearm")
    .replace(/\b(clean and press)\b/g, "cleanpress")
    .replace(/\b(clean press)\b/g, "cleanpress")
    .replace(/\b(farmers|farmer's|farmer)\b/g, "farmer")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLoose(name) {
  const n = normNameLoose(name);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

function tokenOverlapScore(aName, bName) {
  const a = new Set(tokenizeLoose(aName));
  const b = new Set(tokenizeLoose(bName));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter;
}

// Builds a performance library with metadata so we can power "last_time" in UI
function buildPerformanceLibrary(compactLast, compactHist) {
  const workouts = [compactLast].concat(compactHist || []).filter(Boolean);

  const entries = [];
  for (const w of workouts) {
    const date = w?.date || "";
    const workoutName = w?.workout_name || w?.split || "";
    const exs = Array.isArray(w?.exercises) ? w.exercises : [];
    for (const ex of exs) {
      const sets = Array.isArray(ex?.sets) ? ex.sets : [];
      if (!ex?.name || !sets.length) continue;
      const cleaned = sets
        .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
        .filter((s) => s.w > 0 && s.r > 0);

      if (!cleaned.length) continue;

      entries.push({
        name: collapseSpaces(ex.name),
        sets: cleaned,
        date,
        workoutName,
      });
    }
  }
  return entries;
}

function findBestInLibrary(libraryEntries, targetName) {
  const targetS = normNameStrict(targetName);
  const targetL = normNameLoose(targetName);

  for (const e of libraryEntries || []) {
    if (normNameStrict(e?.name) === targetS) return { entry: e, score: 999 };
  }
  for (const e of libraryEntries || []) {
    if (normNameLoose(e?.name) === targetL) return { entry: e, score: 500 };
  }

  let best = null;
  let bestScore = 0;
  for (const e of libraryEntries || []) {
    const sc = tokenOverlapScore(e?.name, targetName);
    if (sc > bestScore) {
      bestScore = sc;
      best = e;
    }
  }
  if (best && bestScore >= 2) return { entry: best, score: bestScore };
  return { entry: null, score: 0 };
}

function draftHasUsablePerformance(ex) {
  const sets = Array.isArray(ex?.sets) ? ex.sets : [];
  const cleaned = sets
    .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
    .filter((s) => s.w > 0 && s.r > 0);
  return cleaned.length ? cleaned : null;
}

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
        name: collapseSpaces(ex?.name || ""),
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
        name: collapseSpaces(ex?.name || ""),
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

  // NEW: rationale fields (filled by smart logic)
  if (typeof w.rationale_overall !== "string") w.rationale_overall = "";
  if (!Array.isArray(w.rationale_bullets)) w.rationale_bullets = [];

  w.exercises = w.exercises
    .filter(Boolean)
    .slice(0, 10)
    .map((ex) => {
      const e = ex && typeof ex === "object" ? ex : {};
      e.name = collapseSpaces(e.name || "Exercise");
      e.rest_seconds = Number.isFinite(Number(e.rest_seconds)) ? Number(e.rest_seconds) : 90;
      e.notes = typeof e.notes === "string" ? e.notes : "";

      // NEW: per exercise rationale + last_time (filled by smart logic)
      if (typeof e.rationale !== "string") e.rationale = "";
      if (typeof e.last_time !== "object" || e.last_time === null) e.last_time = null;

      if (!Array.isArray(e.sets)) e.sets = [];
      e.sets = e.sets
        .filter(Boolean)
        .slice(0, 8)
        .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }));

      if (!e.sets.length) e.sets = [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }];
      return e;
    });

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
    matchedExercises: 0,
    newExercises: 0,
    deloaded: false,
    completionMode: false,
    matchMode: "history_library + current_draft_fallback",
    matchPreview: { libraryNames: [], resolved: [] },
    fatigueSignal: null,
    respectedDraftOrder: false,
  };

  const fatigueSignal = computeFatigueSignal(lastWorkout, currentDraft);
  dbg.fatigueSignal = fatigueSignal;
  dbg.deloaded = !!fatigueSignal.shouldDeload;
  dbg.completionMode = fatigueSignal.veryLowVolume === true;

  const perfLib = buildPerformanceLibrary(lastWorkout, history);
  dbg.matchPreview.libraryNames = perfLib.map((e) => `${e.date || ""} • ${e.name}`).slice(0, 40);

  // Respect draft order if present
  if (currentDraft?.exercises?.length) {
    const draftOrder = currentDraft.exercises
      .map((ex) => collapseSpaces(ex?.name || ""))
      .filter(Boolean)
      .slice(0, 8);

    if (draftOrder.length) {
      const rebuilt = [];
      for (const draftName of draftOrder) {
        const draftEx =
          (currentDraft.exercises || []).find((e) => normNameLoose(e?.name) === normNameLoose(draftName)) || null;

        rebuilt.push({
          name: draftName,
          sets: draftEx
            ? cloneDraftSetsOrBlank(draftEx, { defaultReps: 8 })
            : [{ w: 0, r: 8 }, { w: 0, r: 8 }, { w: 0, r: 8 }],
          rest_seconds: defaultRestFor(draftName),
          notes: "",
          rationale: "",
          last_time: null,
        });
      }
      workout.exercises = rebuilt;
      dbg.respectedDraftOrder = true;
    }
  }

  // Build overall rationale header now (we’ll fill more below)
  const overallBits = [];
  const bulletBits = [];

  if (dbg.deloaded) {
    overallBits.push("Deload mode triggered based on fatigue signals from the last workout.");
    bulletBits.push("Deload applied: loads reduced slightly and reps kept in a safer range to recover while still training.");
  } else {
    overallBits.push("Progression mode: reps-first progressive overload.");
    bulletBits.push("Reps-first progression: keep weight stable and add reps before increasing load (safer + consistent).");
  }

  if (dbg.completionMode) {
    bulletBits.push("Completion focus: the priority is finishing every set with clean form before chasing heavier weight.");
  }

  if (dbg.respectedDraftOrder) {
    bulletBits.push("Your edited exercise order was respected (AI won’t reshuffle your routine).");
  }

  // Apply sets + add exercise rationale + add last_time
  workout.exercises = (workout.exercises || []).slice(0, 8).map((ex) => {
    const name = collapseSpaces(ex?.name || "Exercise");

    // 1) try history library
    const { entry: matched, score } = findBestInLibrary(perfLib, name);

    // 2) fallback: use current draft values if present
    const draftPerf = draftHasUsablePerformance(ex);

    const isCompound = isCompoundLift(name);

    if (matched && matched.sets?.length) {
      dbg.matchedExercises += 1;
      dbg.matchPreview.resolved.push({
        current: name,
        matchedName: matched.name,
        matchedFrom: matched.date || matched.workoutName || "",
        score,
      });

      const nextSets = prescribeNextSets({
        name,
        lastSets: matched.sets,
        deload: dbg.deloaded,
      });

      const rationale = buildExerciseRationale({
        name,
        source: "history",
        sourceLabel: matched.date ? `your last logged ${matched.date}` : "your last logged workout",
        lastSets: matched.sets,
        nextSets,
        deload: dbg.deloaded,
        completionMode: dbg.completionMode,
      });

      return {
        name,
        sets: nextSets,
        rest_seconds: clamp(ex.rest_seconds || defaultRestFor(name), 30, 180),
        notes: improveExerciseNote(ex.notes, name, dbg.deloaded, dbg.completionMode),
        rationale,
        last_time: {
          date: matched.date || "",
          workout_name: matched.workoutName || "",
          sets: matched.sets.slice(0, 6).map((s) => ({ w: s.w, r: s.r })),
        },
      };
    }

    if (draftPerf && draftPerf.length) {
      dbg.matchedExercises += 1;
      dbg.matchPreview.resolved.push({
        current: name,
        matchedName: name,
        matchedFrom: "current_draft",
        score: 100,
      });

      const nextSets = prescribeNextSets({
        name,
        lastSets: draftPerf,
        deload: dbg.deloaded,
      });

      const rationale = buildExerciseRationale({
        name,
        source: "current_draft",
        sourceLabel: "your current draft",
        lastSets: draftPerf,
        nextSets,
        deload: dbg.deloaded,
        completionMode: dbg.completionMode,
      });

      return {
        name,
        sets: nextSets,
        rest_seconds: clamp(ex.rest_seconds || defaultRestFor(name), 30, 180),
        notes: improveExerciseNote(ex.notes, name, dbg.deloaded, dbg.completionMode),
        rationale,
        last_time: {
          date: "",
          workout_name: "current draft",
          sets: draftPerf.slice(0, 6).map((s) => ({ w: s.w, r: s.r })),
        },
      };
    }

    // Otherwise: new exercise -> keep weights blank (0)
    dbg.newExercises += 1;
    dbg.matchPreview.resolved.push({
      current: name,
      matchedName: "",
      matchedFrom: "",
      score: 0,
    });

    const base = baselineForNewExercise(name, sessionType, experience, {
      preferSetCount: (ex?.sets || []).length || null,
    });

    const setsOut = (ex?.sets?.length ? ex.sets : base.sets).slice(0, 8).map((s) => ({
      w: 0,
      r: Number(s?.r) || base.defaultReps,
    }));

    const rationale =
      "No prior performance found for this movement. Weight is left blank (0) by design — start conservative at a load you can complete cleanly for all sets, then we’ll progress from your logged numbers next time.";

    return {
      name,
      sets: setsOut,
      rest_seconds: clamp(ex.rest_seconds || base.rest_seconds, 30, 180),
      notes: improveExerciseNote(ex.notes, name, false, dbg.completionMode) || base.notes,
      rationale,
      last_time: null,
    };
  });

  workout.session_type = normalizeSessionType(workout.session_type || sessionType);
  workout.duration_minutes = clamp(Number(workout.duration_minutes || timeMinutes) || timeMinutes, 20, 120);

  // Final overall rationale
  bulletBits.push(
    `Matched ${dbg.matchedExercises} exercise(s) to your history/draft; ${dbg.newExercises} new movement(s) left blank until you log them.`
  );

  if (dbg.fatigueSignal) {
    bulletBits.push(
      `Fatigue check: totalSets=${dbg.fatigueSignal.totalSets}, bigDropCount=${dbg.fatigueSignal.bigDropCount}, veryLowVolume=${dbg.fatigueSignal.veryLowVolume}.`
    );
  }

  workout.rationale_overall = overallBits.join(" ");
  workout.rationale_bullets = bulletBits.slice(0, 8);

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

// --- NEW: explanation builder (deterministic) ---
function buildExerciseRationale({
  name,
  source,
  sourceLabel,
  lastSets,
  nextSets,
  deload,
  completionMode,
}) {
  const isCompound = isCompoundLift(name);

  const last = normalizeSets(lastSets).slice(0, 3);
  const next = normalizeSets(nextSets).slice(0, 3);

  const last0 = last[0] || { w: 0, r: 0 };
  const next0 = next[0] || { w: 0, r: 0 };

  const wDelta = next0.w - last0.w;
  const rDelta = next0.r - last0.r;

  const parts = [];
  parts.push(`Based on ${sourceLabel}, we prescribed ${describeSets(next)}.`);

  if (deload) {
    parts.push(
      `Deload applied: weight reduced slightly (${formatDelta(wDelta)} lbs vs last set 1) to manage fatigue while keeping quality reps.`
    );
  } else {
    // reps-first
    if (wDelta > 0) {
      parts.push(
        `Weight increase (${formatDelta(wDelta)} lbs) because you were at/near the top of the rep range last time — progressing load is the next step.`
      );
    } else if (wDelta < 0) {
      parts.push(
        `Weight decrease (${formatDelta(wDelta)} lbs) to improve completion and keep form clean (better long-term progression).`
      );
    } else {
      parts.push(
        `Same weight as last time; goal is to add reps first (safer and more consistent than jumping weight too soon).`
      );
    }

    if (rDelta > 0 && wDelta === 0) {
      parts.push(`Reps nudged up first (${formatDelta(rDelta)} reps on set 1) — once you hit the top end, we bump weight next time.`);
    }
  }

  if (completionMode) {
    parts.push("Completion focus: stop 1–2 reps shy of failure and finish every prescribed set before adding load.");
  } else {
    parts.push(isCompound ? "Keep 1–2 reps in reserve on compounds." : "Use controlled tempo and full range of motion.");
  }

  return parts.join(" ");
}

function normalizeSets(sets) {
  return (Array.isArray(sets) ? sets : [])
    .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
    .filter((s) => s.w > 0 && s.r > 0);
}

function describeSets(sets) {
  const s = normalizeSets(sets);
  if (!s.length) return "blank weights until you log a baseline";
  return s.map((x) => `${x.w}×${x.r}`).join(", ");
}

function formatDelta(n) {
  const x = Number(n) || 0;
  return (x >= 0 ? "+" : "") + Math.round(x * 10) / 10;
}

function prescribeNextSets({ name, lastSets, deload }) {
  const cleaned = (lastSets || [])
    .map((s) => ({ w: Number(s?.w) || 0, r: Number(s?.r) || 0 }))
    .filter((s) => s.w > 0 && s.r > 0)
    .slice(0, 6);

  const isCompound = isCompoundLift(name);
  const targetSetCount = isCompound ? 3 : 2;

  if (!cleaned.length) {
    const reps = isCompound ? 6 : 12;
    const sets = isCompound ? 3 : 2;
    return Array.from({ length: sets }).map(() => ({ w: 0, r: reps }));
  }

  if (deload) {
    const dropPct = isCompound ? 0.10 : 0.08;
    const take = Math.min(targetSetCount, cleaned.length);
    return cleaned.slice(0, take).map((s) => ({
      w: roundToIncrement(s.w * (1 - dropPct), isCompound ? 5 : 2.5),
      r: clampInt(s.r, isCompound ? 5 : 8, isCompound ? 10 : 15),
    }));
  }

  const ws = cleaned.map((s) => s.w);
  const wMin = Math.min(...ws);
  const wMax = Math.max(...ws);
  const isRamp = wMax - wMin >= 5;

  const take = Math.min(targetSetCount, cleaned.length);
  const out = [];
  for (let i = 0; i < take; i++) {
    const base = cleaned[i] || cleaned[0];
    const bump = i < 2 ? 1 : 0;
    const newR = clampInt(base.r + bump, isCompound ? 4 : 8, isCompound ? 12 : 15);
    out.push({ w: base.w, r: newR });
  }

  if (!isRamp) {
    const repRangeTop = isCompound ? 10 : 15;
    const avgR = Math.round(out.reduce((a, b) => a + b.r, 0) / Math.max(1, out.length));
    if (avgR >= repRangeTop) {
      const baseW = cleaned[0].w;
      const inc = isCompound ? pickIncrement(baseW, 5, 10) : pickIncrement(baseW, 2.5, 5);
      const newW = roundToIncrement(baseW + inc, isCompound ? 5 : 2.5);
      const targetR = isCompound ? 6 : 10;
      return Array.from({ length: take }).map(() => ({ w: newW, r: targetR }));
    }
  }

  return out;
}

function improveExerciseNote(note, name, deload, completionMode) {
  const n = String(note || "").trim();
  if (n) return n.slice(0, 160);
  if (completionMode) return "Completion focus: keep loads realistic and finish every set with clean form before progressing.";
  return deload ? "Keep tempo controlled; stop with reps in reserve." : "Control tempo; aim for consistent reps.";
}

function baselineForNewExercise(name, sessionType, experience, { preferSetCount = null } = {}) {
  const compound = isCompoundLift(name);
  const rest = compound ? 90 : 60;

  const reps = compound ? 6 : 12;
  const defaultSets = compound ? 3 : 2;

  const sets = clampInt(preferSetCount || defaultSets, 1, 6);
  return {
    rest_seconds: rest,
    notes: "New/untracked movement: start conservative, keep form strict, and enter a weight you can complete cleanly for all sets.",
    defaultReps: reps,
    sets: Array.from({ length: sets }).map(() => ({ w: 0, r: reps })),
  };
}

function defaultRestFor(name) {
  return isCompoundLift(name) ? 120 : 75;
}

function isCompoundLift(name) {
  const lower = String(name || "").toLowerCase();
  return /(squat|deadlift|bench|press|row|pull[- ]?up|pulldown|rdl|romanian|lunge|leg press|clean)/.test(lower);
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
