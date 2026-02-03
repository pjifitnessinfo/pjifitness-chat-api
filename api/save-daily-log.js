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
  summary: "DAILY_SUMMARIES"
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

  // IMPORTANT: echo requested headers for preflight
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
  // 🔑 ALWAYS APPLY CORS FIRST
  applyCors(req, res);

  // 🔑 EXPLICITLY HANDLE PREFLIGHT
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { type, user_id, data, clientDate } = req.body;

    if (!type || !TAB_MAP[type]) {
      return res.status(400).json({ ok: false, error: "Invalid type" });
    }
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }
    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Missing data object" });
    }

    const date = todayYMD(clientDate);
    const sheets = await getSheets();
    const tab = TAB_MAP[type];
    const now = new Date().toISOString();

    // =============================
    // WEIGHT LOG
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
      const idx = rows.findIndex(r => r[0] === date && r[1] === user_id);

      if (idx >= 0) {
        const rowNum = idx + 2;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${tab}!C${rowNum}:E${rowNum}`,
          valueInputOption: "RAW",
          requestBody: { values: [[weight, "v3", now]] }
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${tab}!A:E`,
          valueInputOption: "RAW",
          requestBody: { values: [[date, user_id, weight, "v3", now]] }
        });
      }

      return res.json({ ok: true, saved: "weight", date, weight });
    }

    // =============================
    // MEAL LOG
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
            user_id,
            meal_id || `meal_${Date.now()}`,
            meal_text,
            ai_estimate || "",
            ai_swaps || "",
            now
          ]]
        }
      });

      return res.json({ ok: true, saved: "meal", date });
    }

    // =============================
    // SUMMARY
    // =============================
    if (type === "summary") {
      const {
        weight,
        weekly_avg,
        total_calories,
        ai_summary,
        coach_flag
      } = data;

      const read = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A2:G`
      });

      const rows = read.data.values || [];
      const idx = rows.findIndex(r => r[0] === date && r[1] === user_id);

      const row = [
        date,
        user_id,
        weight ?? "",
        weekly_avg ?? "",
        total_calories ?? "",
        ai_summary ?? "",
        coach_flag ?? ""
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

      return res.json({ ok: true, saved: "summary", date });
    }

  } catch (err) {
    console.error("[save-daily-log]", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err.message
    });
  }
}
