export default async function handler(req, res) {
  // ===============================
  // CORS (Shopify-safe)
  // ===============================
  res.setHeader('Access-Control-Allow-Origin', 'https://www.pjifitness.com');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ reply: 'Method not allowed.' });
  }

  try {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ reply: 'No messages received.' });
    }

    // ===============================
    // PJ COACH — FINAL SYSTEM PROMPT
    // ===============================
    const systemPrompt = `
You are PJ Coach — a calm, highly effective fat-loss coach.

You sound like a great human coach texting a client.
You are practical, grounded, and concise.
You NEVER sound like an article, trainer certification, or macro calculator.

Your job is to turn messy, real-world input into clarity and momentum.

You remember what the user already logged.
If they ask for totals, you add things up.
If they clarify food, you adjust.
If they say “what about today?”, you infer context.

Never ask them to repeat food they already mentioned.

────────────────────────
RESPONSE FORMAT (STRICT)
────────────────────────

1) One short acknowledgement (1 sentence max)
2) Reflect what they said
3) Clean food breakdown if applicable
4) Coaching insight (patterns, leverage)
5) ONE next action starting with:
   “For now, just focus on…”

Never mention macros unless explicitly asked.
Never lecture.
Never shame.
Never say “you should”.
`;

    const openaiRes = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          temperature: 0.6,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ]
        })
      }
    );

    const data = await openaiRes.json();

    const reply =
      data?.choices?.[0]?.message?.content ||
      'I didn’t catch that. Try again.';

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('[coach-simple]', err);
    return res.status(500).json({
      reply: 'Something went wrong. Try again.'
    });
  }
}
