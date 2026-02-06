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

  const read = await sheets.spreadsheets.values.get({
    auth: authClient,
    spreadsheetId: process.env.SHEET_ID,
    range: "users!A:D"
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

  res.json({ success: true, user_id: user[0] });
}
