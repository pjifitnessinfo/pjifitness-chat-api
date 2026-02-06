import bcrypt from "bcryptjs";
import { google } from "googleapis";

const sheets = google.sheets("v4");

async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return auth.getClient();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  const authClient = await getAuthClient();

  // Read users sheet
  const read = await sheets.spreadsheets.values.get({
    auth: authClient,
    spreadsheetId: process.env.SHEET_ID,
    range: "users!A:D"
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

  res.json({ success: true, user_id });
}
