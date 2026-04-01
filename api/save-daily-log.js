import { google } from "googleapis";

export const config = {
  api: { bodyParser: true }
};

// =============================
// ENV
// =============================
const SHEET_ID = process.env.SHEET_ID;
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// =============================
// TAB MAP
// =============================
const TAB_MAP = {
  weight: "WEIGHT_LOGS",
  meal: "MEAL_LOGS",
  summary: "DAILY_SUMMARIES",
  coach_review: "COACH_DAILY_REVIEW"
};

// =============================
// CORS (FIXED + PREFLIGHT SAFE)
// =============================
function applyCors(req, res) {
  const origin = req.headers.origin || "";

  const ALLOWED = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
  ]);

  res.setHeader("Vary", "Origin");

  if (ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders || "Content-Type, Authorization"
  );

  res.setHeader("Access-Control-Max-Age", "86400");
}

// =============================
// HELPERS
// =============================
function todayYMD(clientDate) {
  if (typeof clientDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(clientDate)) {
    return clientDate;
  }
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function cleanCell(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function cleanNumberOrBlank(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return "";
}

async function getSheets() {
  const auth = new google.auth.JWT(
    SERVICE_ACCOUNT.client_email,
    null,
    SERVICE_ACCOUNT.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

// =============================
// HANDLER
// =============================
export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { type, user_id, data, clientDate } = req.body || {};

    // =============================
    // IDENTITY GUARD
    // =============================
    if (!user_id || user_id === "guest") {
      return res.status(401).json({
        ok: false,
        error: "Missing or invalid user_id"
      });
    }

    if (!type || !TAB_MAP[type]) {
      return res.status(400).json({ ok: false, error: "Invalid type" });
    }

    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Missing data object" });
    }

    const date = todayYMD(clientDate);
    const sheets = await getSheets();
    const tab = TAB_MAP[type];
    const now = new Date().toISOString();

    // =============================
    // WEIGHT LOG (overwrite per day)
    // =============================
    if (type === "weight") {
      const weight = Number(data.weight);
      if (!Number.isFinite(weight)) {
        return res.status(400).json({ ok: false, error: "Invalid weight" });
      }

      const read = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A2:E`
      });

      const rows = read.data.values || [];
      const idx = rows.findIndex(
        r => r[0] === date && r[1] === String(user_id)
      );

      if (idx >= 0) {
        const rowNum = idx + 2;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${tab}!C${rowNum}:E${rowNum}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[weight, "v4", now]]
          }
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${tab}!A:E`,
          valueInputOption: "RAW",
          requestBody: {
            values: [[date, String(user_id), weight, "v4", now]]
          }
        });
      }

      return res.json({ ok: true, saved: "weight", date, weight });
    }

    // =============================
    // MEAL LOG (append-only)
    // =============================
    if (type === "meal") {
      const { meal_id, meal_text, ai_estimate, ai_swaps } = data;

      if (!meal_text) {
        return res.status(400).json({ ok: false, error: "Missing meal_text" });
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A:G`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            date,
            String(user_id),
            meal_id || `meal_${Date.now()}`,
            cleanCell(meal_text),
            cleanCell(ai_estimate),
            cleanCell(ai_swaps),
            now
          ]]
        }
      });

      return res.json({ ok: true, saved: "meal", date });
    }

    // =============================
    // DAILY SUMMARY + COACH REVIEW
    // =============================
    if (type === "summary") {
      const {
              const {
        // base summary fields
        weight,
        weekly_avg,
        total_calories,
        ai_summary,
        coach_flag,
        last_meal_text,

        // coach review fields
        name,
        calorie_target,
        protein_target,
        protein_logged,
        protein_total,
        meals_summary,
        flags,
        coaching_opportunities,
        user_questions,
        coach_notes,
        status,

        // onboarding/profile fields
        sex,
        age,
        height_in,
        start_weight,
        goal_weight,
        activity_level,
        phone,
        text_opt_in,
        history_experience,
        history_state,
        history_patterns,
        history_notes,

        // safe fallbacks if frontend uses different names
        phone_number,
        phoneNumber,
        mobile,
        text_ok,
        wants_text
      } = data;

      const coachTab = TAB_MAP.coach_review;

      const resolvedPhone = firstNonEmpty(
        phone,
        phone_number,
        phoneNumber,
        mobile
      );

      const resolvedTextOptIn = firstNonEmpty(
        text_opt_in,
        text_ok,
        wants_text
      );

      const resolvedProteinLogged =
        cleanNumberOrBlank(protein_logged) !== ""
          ? cleanNumberOrBlank(protein_logged)
          : cleanNumberOrBlank(protein_total);

      const resolvedCoachingOpportunities = firstNonEmpty(
        coaching_opportunities,
        coach_flag,
        flags,
        "None"
      );

      const resolvedUserQuestions = firstNonEmpty(
        user_questions,
        last_meal_text,
        ""
      );

      const resolvedCoachNotes = firstNonEmpty(
        coach_notes,
        ai_summary,
        ""
      );

      // =============================
      // DAILY_SUMMARIES (keep simple)
      // A date
      // B user_id
      // C weight
      // D weekly_avg
      // E total_calories
      // F ai_summary
      // G coach_flag
      // =============================
      const read = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A2:G`
      });

      const rows = read.data.values || [];
      const idx = rows.findIndex(
        r => r[0] === date && r[1] === String(user_id)
      );

      const row = [
        date,
        String(user_id),
        cleanNumberOrBlank(weight),
        cleanNumberOrBlank(weekly_avg),
        cleanNumberOrBlank(total_calories),
        cleanCell(ai_summary),
        cleanCell(coach_flag || flags)
      ];

      if (idx >= 0) {
        const rowNum = idx + 2;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${tab}!A${rowNum}:G${rowNum}`,
          valueInputOption: "RAW",
          requestBody: { values: [row] }
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${tab}!A:G`,
          valueInputOption: "RAW",
          requestBody: { values: [row] }
        });
      }

      // =============================
      // COACH_DAILY_REVIEW
      // A  date
      // B  user_id
      // C  name
      // D  calorie_target
      // E  protein_target
      // F  calories_logged
      // G  protein_logged
      // H  weight_today
      // I  avg_7d_weight
      // J  meals_summary
      // K  flags
      // L  coaching_opportunities
      // M  user_questions
      // N  coach_notes
      // O  status
      // P  timestamp
      // Q  sex
      // R  age
      // S  height_in
      // T  start_weight
      // U  goal_weight
      // V  activity_level
      // W  phone
      // X  text_ok
      // Y  ai_summary
      // =============================
      const coachRead = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${coachTab}!A2:AC`
      });

      const coachRows = coachRead.data.values || [];
      const coachIdx = coachRows.findIndex(
        r => r[0] === date && r[1] === String(user_id)
      );

      const coachRow = [
        date,                               // A
        String(user_id),                    // B
        cleanCell(name),                    // C
        cleanNumberOrBlank(calorie_target), // D
        cleanNumberOrBlank(protein_target), // E
        cleanNumberOrBlank(total_calories), // F
        resolvedProteinLogged,              // G
        cleanNumberOrBlank(weight),         // H
        cleanNumberOrBlank(weekly_avg),     // I
        cleanCell(meals_summary),           // J
        cleanCell(flags || coach_flag),     // K
        cleanCell(resolvedCoachingOpportunities), // L
        cleanCell(resolvedUserQuestions),   // M
        cleanCell(resolvedCoachNotes),      // N
        cleanCell(status),                  // O
        now,                                // P
        cleanCell(sex),                     // Q
        cleanNumberOrBlank(age),            // R
        cleanNumberOrBlank(height_in),      // S
        cleanNumberOrBlank(start_weight),   // T
        cleanNumberOrBlank(goal_weight),    // U
        cleanCell(activity_level),          // V
        cleanCell(resolvedPhone),           // W
        cleanCell(resolvedTextOptIn),       // X
        cleanCell(ai_summary)               // Y
      ];

      if (coachIdx >= 0) {
        const coachRowNum = coachIdx + 2;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${coachTab}!A${coachRowNum}:Y${coachRowNum}`,
          valueInputOption: "RAW",
          requestBody: { values: [coachRow] }
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${coachTab}!A:Y`,
          valueInputOption: "RAW",
          requestBody: { values: [coachRow] }
        });
      }

      return res.json({ ok: true, saved: "summary", date });
    }

    return res.status(400).json({ ok: false, error: "Unhandled type" });
  } catch (err) {
    console.error("[save-daily-log]", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err.message
    });
  }
}
