import bcrypt from "bcryptjs";
import { google } from "googleapis";

export const config = {
  api: { bodyParser: true }
};

const sheets = google.sheets("v4");

/* =============================
   CORS (SHOPIFY-SAFE)
   ============================= */
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

  // 🔑 MUST echo requested headers (Shopify sends many)
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqHeaders || "Content-Type, Authorization"
  );

  res.setHeader("Access-Control-Max-Age", "86400");
}

/* =============================
   GOOGLE AUTH (HARDENED)
   ============================= */
async function getAuthClient() {
  const creds =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT;

  if (!creds) {
    throw new Error("Missing Google service account env var");
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
  // 🔑 APPLY CORS FIRST
  applyCors(req, res);

  // 🔑 PREFLIGHT MUST EXIT
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const authClient = await getAuthClient();

    const read = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: process.env.SHEET_ID,
      range: "users!A2:D" // skip header row
    });

    const rows = read.data.values || [];
    const user = rows.find(r => r[1] === email);

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user[2]);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    return res.json({ user_id: user[0] });

  } catch (err) {
    console.error("[LOGIN ERROR]", err);
    return res.status(500).json({
      error: "Login failed",
      details: err.message
    });
  }
}
