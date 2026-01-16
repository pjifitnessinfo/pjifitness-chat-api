export default async function handler(req, res) {
  // ===== CORS HEADERS (CRITICAL) =====
  res.setHeader('Access-Control-Allow-Origin', 'https://www.pjifitness.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ reply: 'No message received.' });
    }

    // 🧠 TEMP COACH LOGIC (replace later)
    const reply =
      `Here’s a clean breakdown of what you shared:\n\n` +
      `• Protein shake breakfast — ~160 cal\n` +
      `• Chicken wrap lunch — ~300–350 cal\n` +
      `• Bread & cheese snack — ~300 cal\n` +
      `• Burger & fries dinner — ~700–800 cal\n\n` +
      `Quick coaching tips:\n` +
      `• Keep protein high earlier in the day (you did this well)\n` +
      `• Biggest calorie lever tonight is fries + condiments\n` +
      `• Air-fried potatoes or half fries saves ~200–300 cal\n\n` +
      `Overall: solid structure. Small swaps = big win.`;

    return res.status(200).json({ reply });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ reply: 'Server error. Try again.' });
  }
}
