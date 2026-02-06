import bcrypt from "bcryptjs";
import { google } from "googleapis";

export const config = {
  api: { bodyParser: true }
};

const sheets = google.sheets("v4");

/* =============================
   CORS
   ============================= */
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const ALLOWED = new Set([
    "https://www.pjifitness.com",
    "https://pjifitness.com"
  ]);

  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Origin",
    ALLOWED.has(origin) ? origin : "*"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* =============================
   GOOGLE AUTH (HARDENED)
   ============================= */
async function getAuthClient() {
  const creds =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT;

  if (!creds) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var");
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(creds),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return auth.getClient();
}

/* =============================
   HANDLER
   ============================= */
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const authClient = await getAuthClient();

    const read = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "users!A2:D" // ⬅️ SKIP HEADER ROW
    });

    const rows = read.data.values || [];
    const exists = rows.find(r => r[1] === email);

    if (exists) {
      return res.status(400).json({ error: "User already exists" });
    }

    const user_id = `usr_${Date.now()}`;
    const password_hash = await bcrypt.hash(password, 10);

    await sheets.spreadsheets.values.append({
      auth: authClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "users!A:D",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          user_id,
          email,
          password_hash,
          new Date().toISOString()
        ]]
      }
    });

    return res.json({ user_id });

  } catch (err) {
    console.error("[REGISTER ERROR]", err);
    return res.status(500).json({
      error: "Register failed",
      details: err.message
    });
  }
}
