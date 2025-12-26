// /api/create-workout-plan.js
//
// PJiFitness — Initial AI Workout Program Generator (V1)
// Used ONLY after onboarding
// Returns a structured starter plan (no history required)
//
// Improvements:
// ✅ Always returns exactly days_per_week workouts
// ✅ Enforces equipment constraints (basic filtering)
// ✅ Normalizes starter weights to 0 so UI shows blanks
// ✅ Timeout + richer debug

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
    "Content-Type, Authorization, X-Requested-With, Accept, x-pj-smoke"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  // PING
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "create-workout-plan",
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
  const started = Date.now();

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    debug.hasOpenAIKey = !!OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY", debug });
    }

    debug.vercelEnv = process.env.VERCEL_ENV || "unknown";

    const body = req.body || {};

    const goal = String(body.goal || "fat_loss");
    const experience = String(body.experience || "intermediate");
    const days = clampInt(Number(body.days_per_week || 4) || 4, 1, 6);
    const equipmentRaw = Array.isArray(body.equipment) ? body.equipment : [];
    const equipment = equipmentRaw.map((x) => String(x || "").toLowerCase()).filter(Boolean).slice(0, 50);
    const timeMinutes = clampInt(Number(body.time_minutes || 60) || 60, 20, 120);
    const age = String(body.age || "").trim();

    debug.goal = goal;
    debug.experience = experience;
    debug.days = days;
    debug.timeMinutes = timeMinutes;
    debug.equipment = equipment;

    // Determine equipment mode:
    // - full_gym: "full_gym"
    // - dumbbells: contains "dumbbells"
    // - home_gym: contains "home_gym" + list of selected items
    const equipmentMode = inferEquipmentMode(equipment);
    debug.equipmentMode = equipmentMode;

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
- Keep exercises realistic for the equipment provided
- No junk volume
- Clear titles
- Use "session_type" as one of: "upper_body", "lower_body", "full_body"
- Include short coach_focus bullets (3–5) and safety_notes bullets (2–4) for each workout
- Prefer common gym movements and simple programming (repeatable)

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

Important:
- If equipment includes "dumbbells", avoid barbells unless "full_gym" is present.
- If equipment includes "home_gym", ONLY use items listed after it (example: rack, bench, barbell, bands, pullup_bar, etc.).

Build the program now.
`.trim();

    const model = process.env.OPENAI_WORKOUT_MODEL || "gpt-4.1-mini";
    debug.model = model;

    debug.step = "before_openai";
    const resp = await fetchWithTimeout(
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
          temperature: 0.4,
          max_output_tokens: 1600,
        }),
      },
      28000
    );

    debug.step = "after_openai";
    debug.openai_ms = Date.now() - started;

    if (!resp.ok) {
      const t = await resp.text();
      return res.status(500).json({ error: "OpenAI failed", detail: t?.slice(0, 2000), debug });
    }

    const data = await resp.json();

    const outputText =
      data?.output_text ||
      data?.output?.[0]?.content?.find?.((c) => c?.type === "output_text")?.text ||
      "";

    if (!outputText) {
      return res.status(500).json({ error: "No output from model", debug });
    }

    let plan;
    try {
      plan = JSON.parse(outputText);
    } catch (e) {
      return res.status(500).json({
        error: "Invalid JSON from model",
        preview: outputText.slice(0, 800),
        debug,
      });
    }

    // -----------------------------
    // Normalize + enforce days + equipment
    // -----------------------------
    plan = normalizePlan(plan, { days, timeMinutes, equipmentMode, equipment });

    // If model returned too few workouts, fill deterministically
    plan.workouts = ensureWorkoutCount(plan.workouts, days, timeMinutes, equipmentMode);

    // Enforce equipment constraints post-hoc (basic but effective)
    plan.workouts = plan.workouts.map((w, idx) => enforceEquipmentOnWorkout(w, equipmentMode, equipment, idx, timeMinutes));

    debug.planWorkoutCount = plan.workouts.length;

    return res.status(200).json({
      plan,
      debug: { ...debug, ms: Date.now() - started },
    });
  } catch (err) {
    const name = err?.name || "";
    const msg = String(err?.message || err);

    if (name === "AbortError") {
      return res.status(504).json({
        error: "OpenAI timeout (took too long). Try again.",
        debug: { ...debug, name, message: msg, ms: Date.now() - started },
      });
    }

    return res.status(500).json({
      error: "Unhandled error",
      message: msg,
      debug: { ...debug, name, ms: Date.now() - started, stack: String(err?.stack || "").slice(0, 1200) },
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

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function inferEquipmentMode(equipment) {
  const hasFull = equipment.includes("full_gym");
  const hasDbs = equipment.includes("dumbbells");
  const hasHome = equipment.includes("home_gym");
  if (hasFull) return "full_gym";
  if (hasHome) return "home_gym";
  if (hasDbs) return "dumbbells";
  return "full_gym";
}

function normalizeSessionType(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("lower") || s.includes("leg")) return "lower_body";
  if (s.includes("full")) return "full_body";
  if (s.includes("upper") || s.includes("push") || s.includes("pull")) return "upper_body";
  return "full_body";
}

function isCompoundLift(name) {
  const lower = String(name || "").toLowerCase();
  return /(squat|deadlift|bench|press|row|pull[- ]?up|pulldown|rdl|romanian|lunge|leg press)/.test(lower);
}

/**
 * Normalize plan shape and sets:
 * - weights -> 0 (starter plan; user fills real numbers)
 * - compounds: 3 sets, accessories: 2 sets
 */
function normalizePlan(plan, { days, timeMinutes }) {
  let p = plan && typeof plan === "object" ? plan : {};
  if (!Array.isArray(p.workouts)) p.workouts = [];

  p.plan_title = String(p.plan_title || "Workout Program");
  p.days_per_week = clampInt(Number(p.days_per_week || days) || days, 1, 6);

  p.workouts = p.workouts.slice(0, days).map((w, idx) => {
    const session_type = normalizeSessionType(w?.session_type);
    const title = String(w?.title || `Day ${idx + 1}`);
    const duration_minutes = clampInt(Number(w?.duration_minutes || timeMinutes) || timeMinutes, 20, 120);

    let exercises = Array.isArray(w?.exercises) ? w.exercises.slice(0, 10) : [];

    exercises = exercises.map((ex) => {
      const name = String(ex?.name || "Exercise");
      const compound = isCompoundLift(name);

      let sets = (Array.isArray(ex?.sets) ? ex.sets : [{ w: 0, r: compound ? 6 : 10 }])
        .slice(0, 6)
        .map((s) => ({
          // ✅ starter plan weights are blank in UI -> always 0 here
          w: 0,
          r: clampInt(Number(s?.r || (compound ? 6 : 10)), compound ? 4 : 8, compound ? 12 : 20),
        }));

      const targetSets = compound ? 3 : 2;

      // enforce set count
      if (sets.length < targetSets) {
        const base = sets[0] || { w: 0, r: compound ? 6 : 10 };
        while (sets.length < targetSets) sets.push({ w: 0, r: base.r });
      } else if (sets.length > targetSets) {
        sets = sets.slice(0, targetSets);
      }

      const restDefault = compound ? 90 : 60;

      return {
        name,
        sets,
        rest_seconds: clampInt(Number(ex?.rest_seconds || restDefault) || restDefault, 30, 180),
        notes: String(ex?.notes || "").slice(0, 160),
      };
    });

    const coach_focus = Array.isArray(w?.coach_focus) ? w.coach_focus.slice(0, 5).map(String) : [];
    const safety_notes = Array.isArray(w?.safety_notes) ? w.safety_notes.slice(0, 5).map(String) : [];

    return {
      session_type,
      title,
      duration_minutes,
      exercises,
      coach_focus,
      safety_notes,
    };
  });

  return p;
}

/**
 * Ensure exactly N workouts.
 * If OpenAI returns fewer workouts (common), we fill missing days with simple templates.
 */
function ensureWorkoutCount(workouts, days, timeMinutes, equipmentMode) {
  const out = Array.isArray(workouts) ? workouts.slice(0, days) : [];

  // pick a sensible rotation
  const rotation =
    days <= 3 ? ["full_body", "upper_body", "lower_body"] :
    days === 4 ? ["upper_body", "lower_body", "upper_body", "lower_body"] :
    days === 5 ? ["upper_body", "lower_body", "upper_body", "lower_body", "full_body"] :
    ["upper_body", "lower_body", "upper_body", "lower_body", "upper_body", "lower_body"];

  while (out.length < days) {
    const idx = out.length;
    const st = rotation[idx] || "full_body";
    out.push(buildFallbackWorkout(st, idx, timeMinutes, equipmentMode));
  }

  return out.slice(0, days);
}

function buildFallbackWorkout(session_type, idx, timeMinutes, equipmentMode) {
  const title =
    session_type === "upper_body" ? "Upper Body (Starter)" :
    session_type === "lower_body" ? "Lower Body (Starter)" :
    "Full Body (Starter)";

  const exs = fallbackExercisesFor(session_type, equipmentMode);

  return {
    session_type,
    title: `${title} — Day ${idx + 1}`,
    duration_minutes: timeMinutes,
    exercises: exs.map((name) => ({
      name,
      sets: isCompoundLift(name)
        ? [{ w: 0, r: 6 }, { w: 0, r: 6 }, { w: 0, r: 6 }]
        : [{ w: 0, r: 12 }, { w: 0, r: 12 }],
      rest_seconds: isCompoundLift(name) ? 90 : 60,
      notes: "",
    })),
    coach_focus: [
      "This is a starter day: prioritize clean form and consistent effort over heavy loading.",
      "Pick weights that feel smooth and controlled since the plan starts with blank weights.",
      "Stop most sets with 2–3 reps in reserve so you recover well and build consistency.",
    ],
    safety_notes: [
      "Warm up 5–8 minutes and do 1–2 lighter ramp-up sets before work sets.",
      "Stop if sharp pain shows up; adjust range of motion or swap the movement.",
    ],
  };
}

function fallbackExercisesFor(sessionType, equipmentMode) {
  // ultra safe defaults
  if (equipmentMode === "dumbbells") {
    if (sessionType === "lower_body") return ["Goblet Squat", "Dumbbell Romanian Deadlift", "Dumbbell Split Squat", "Calf Raise"];
    if (sessionType === "upper_body") return ["Dumbbell Bench Press", "One-Arm Dumbbell Row", "Dumbbell Shoulder Press", "Dumbbell Curl"];
    return ["Goblet Squat", "Dumbbell Bench Press", "One-Arm Dumbbell Row", "Dumbbell Romanian Deadlift"];
  }

  // full_gym / home_gym (we'll filter later for home selections)
  if (sessionType === "lower_body") return ["Back Squat", "Romanian Deadlift", "Leg Press", "Leg Curl"];
  if (sessionType === "upper_body") return ["Barbell Bench Press", "Lat Pulldown", "Seated Cable Row", "Triceps Pushdown"];
  return ["Back Squat", "Barbell Bench Press", "Lat Pulldown", "Romanian Deadlift"];
}

/**
 * Enforce equipment rules:
 * - dumbbells: remove barbell/cables/machines
 * - home_gym: keep only movements that match selected items
 */
function enforceEquipmentOnWorkout(w, equipmentMode, equipment, idx, timeMinutes) {
  const workout = w && typeof w === "object" ? w : {};
  workout.session_type = normalizeSessionType(workout.session_type);
  workout.duration_minutes = clampInt(Number(workout.duration_minutes || timeMinutes) || timeMinutes, 20, 120);

  if (!Array.isArray(workout.exercises)) workout.exercises = [];
  workout.exercises = workout.exercises.slice(0, 10).map((ex) => ({
    name: String(ex?.name || "Exercise"),
    sets: Array.isArray(ex?.sets) ? ex.sets : [],
    rest_seconds: clampInt(Number(ex?.rest_seconds || 60) || 60, 30, 180),
    notes: String(ex?.notes || ""),
  }));

  // filter exercises
  let filtered = workout.exercises;

  if (equipmentMode === "dumbbells") {
    filtered = filtered.filter((ex) => isAllowedForDumbbells(ex.name));
    if (filtered.length < 4) {
      const fallback = buildFallbackWorkout(workout.session_type, idx, workout.duration_minutes, "dumbbells");
      filtered = fallback.exercises;
    }
  }

  if (equipmentMode === "home_gym") {
    // equipment looks like: ["home_gym","rack","bench","barbell","bands",...]
    const allowedItems = new Set(equipment.filter((x) => x !== "home_gym"));
    filtered = filtered.filter((ex) => isAllowedForHomeGym(ex.name, allowedItems));
    if (filtered.length < 4) {
      // fallback to "home gym safe" but still filtered by allowedItems
      const fallback = buildFallbackWorkout(workout.session_type, idx, workout.duration_minutes, "full_gym");
      filtered = fallback.exercises.filter((ex) => isAllowedForHomeGym(ex.name, allowedItems));
      if (filtered.length < 3) {
        // if user selected almost nothing, worst-case: bands/bodyweight safe
        filtered = [
          { name: "Bodyweight Squat", sets: [{ w: 0, r: 12 }, { w: 0, r: 12 }], rest_seconds: 60, notes: "" },
          { name: "Push-up", sets: [{ w: 0, r: 10 }, { w: 0, r: 10 }], rest_seconds: 60, notes: "" },
          { name: "Band Row", sets: [{ w: 0, r: 12 }, { w: 0, r: 12 }], rest_seconds: 60, notes: "" },
        ];
      }
    }
  }

  // normalize sets again (weights -> 0, enforce set count)
  workout.exercises = filtered.slice(0, 8).map((ex) => {
    const name = String(ex.name || "Exercise");
    const compound = isCompoundLift(name);
    const targetSets = compound ? 3 : 2;

    let sets = (Array.isArray(ex.sets) ? ex.sets : [])
      .slice(0, 6)
      .map((s) => ({
        w: 0,
        r: clampInt(Number(s?.r || (compound ? 6 : 12)), compound ? 4 : 8, compound ? 12 : 20),
      }));

    if (!sets.length) {
      sets = compound ? [{ w: 0, r: 6 }, { w: 0, r: 6 }, { w: 0, r: 6 }] : [{ w: 0, r: 12 }, { w: 0, r: 12 }];
    }

    if (sets.length < targetSets) {
      const baseR = sets[0]?.r || (compound ? 6 : 12);
      while (sets.length < targetSets) sets.push({ w: 0, r: baseR });
    } else if (sets.length > targetSets) {
      sets = sets.slice(0, targetSets);
    }

    return {
      name,
      sets,
      rest_seconds: clampInt(Number(ex.rest_seconds || (compound ? 90 : 60)) || (compound ? 90 : 60), 30, 180),
      notes: String(ex.notes || "").slice(0, 160),
    };
  });

  if (!Array.isArray(workout.coach_focus)) workout.coach_focus = [];
  if (!Array.isArray(workout.safety_notes)) workout.safety_notes = [];

  workout.coach_focus = workout.coach_focus.slice(0, 5).map(String);
  workout.safety_notes = workout.safety_notes.slice(0, 4).map(String);

  // ensure at least some guidance
  if (!workout.coach_focus.length) {
    workout.coach_focus = [
      "Starter plan: choose weights that allow smooth reps and perfect form.",
      "Stop sets with 2–3 reps in reserve so recovery stays easy.",
      "Write down the weights you used so the next workout can progress.",
    ];
  }
  if (!workout.safety_notes.length) {
    workout.safety_notes = [
      "Warm up 5–8 minutes and do 1–2 ramp-up sets before work sets.",
      "Stop if sharp pain shows up; adjust range of motion or swap the movement.",
    ];
  }

  return workout;
}

function isAllowedForDumbbells(name) {
  const n = String(name || "").toLowerCase();
  // block common gym-only stuff
  if (/(barbell|smith|cable|machine|leg press|hack squat|lat pulldown|pulldown|seated cable|pec deck)/.test(n)) return false;
  // allow dumbbell/bodyweight/bands-ish
  return true;
}

function isAllowedForHomeGym(name, allowedItems) {
  const n = String(name || "").toLowerCase();

  // If they have rack+barbell, allow barbell compounds
  const hasBarbell = allowedItems.has("barbell") || allowedItems.has("barbell + plates");
  const hasRack = allowedItems.has("rack");
  const hasBench = allowedItems.has("bench");
  const hasCables = allowedItems.has("cables");
  const hasLegPress = allowedItems.has("leg_press");
  const hasPullup = allowedItems.has("pullup_bar");
  const hasBands = allowedItems.has("bands");
  const hasDbs = allowedItems.has("adjustable_dbs") || allowedItems.has("fixed_dbs");

  // Machines
  if (/(leg press)/.test(n)) return hasLegPress;
  if (/(cable|pulldown|functional trainer)/.test(n)) return hasCables;

  // Pullups
  if (/(pull[- ]?up|chin[- ]?up)/.test(n)) return hasPullup;

  // Bench press needs bench; barbell bench also needs barbell
  if (/(bench press)/.test(n)) {
    if (!hasBench) return false;
    if (/(barbell)/.test(n)) return hasBarbell;
    return hasDbs || hasBarbell || true;
  }

  // Barbell lifts generally need barbell; squat/deadlift ideally need rack for squat
  if (/(barbell)/.test(n)) return hasBarbell;
  if (/(back squat|front squat)/.test(n)) return hasBarbell && hasRack;
  if (/(deadlift|rdl|romanian)/.test(n)) return hasBarbell || hasDbs;

  // Dumbbell movements need dumbbells
  if (/(dumbbell|db )/.test(n)) return hasDbs;

  // Bands movements need bands
  if (/(band)/.test(n)) return hasBands;

  // Bodyweight is always OK
  if (/(push[- ]?up|bodyweight|air squat|plank)/.test(n)) return true;

  // Default: allow (to avoid deleting too much), but you can tighten this later
  return true;
}
