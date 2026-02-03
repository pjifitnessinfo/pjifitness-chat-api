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
// CORS
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
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const { user_id, clientDate } = req.body;

    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    const date = todayYMD(clientDate);
    const sheets = await getSheets();

    // =============================
    // READ WEIGHTS (last 7)
    // =============================
    const weightRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "WEIGHT_LOGS!A2:E"
    });

    const weightRows = (weightRes.data.values || [])
      .filter(r => r[1] === user_id)
      .slice(-7);

    const weights = weightRows.map(r => ({
      date: r[0],
      weight: Number(r[2])
    }));

    const weekly_avg =
      weights.length
        ? Math.round(
            (weights.reduce((s, w) => s + w.weight, 0) / weights.length) * 10
          ) / 10
        : null;

    const today_weight =
      weights.find(w => w.date === date)?.weight ?? null;

    // =============================
    // READ TODAY MEALS
    // =============================
    const mealRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "MEAL_LOGS!A2:G"
    });

    const todayMeals = (mealRes.data.values || [])
      .filter(r => r[0] === date && r[1] === user_id)
      .map(r => ({
        meal_id: r[2],
        meal_text: r[3],
        ai_estimate: r[4],
        ai_swaps: r[5]
      }));

    // =============================
    // CALORIE TOTAL (best effort)
    // =============================
    let total_calories = null;

    const calorieMatches = todayMeals
      .map(m => m.ai_estimate)
      .filter(Boolean)
      .map(t => {
        const m = String(t).match(/(\d+)\s*-\s*(\d+)/);
        if (!m) return null;
        return (Number(m[1]) + Number(m[2])) / 2;
      })
      .filter(n => Number.isFinite(n));

    if (calorieMatches.length) {
      total_calories = Math.round(
        calorieMatches.reduce((a, b) => a + b, 0)
      );
    }

    // =============================
    // RESPONSE
    // =============================
    return res.json({
      ok: true,
      user_id,
      date,
      today_weight,
      weekly_avg,
      meals: todayMeals,
      total_calories
    });

  } catch (err) {
    console.error("[get-user-context]", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err.message
    });
  }
}

