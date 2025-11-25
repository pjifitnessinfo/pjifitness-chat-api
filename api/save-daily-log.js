// /api/save-daily-log.js

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { customerId, log } = req.body;

    if (!customerId || !log) {
      return res.status(400).json({ error: "Missing customerId or log" });
    }

    const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const accessToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";

    const baseUrl = `https://${storeDomain}/admin/api/${apiVersion}`;

    // 1️⃣ Get existing metafield
    const existing = await fetch(
      `${baseUrl}/customers/${customerId}/metafields.json?namespace=progress&key=daily_logs`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    let metafield = null;
    let logs = [];

    if (existing.ok) {
      const data = await existing.json();
      if (data.metafields?.length > 0) {
        metafield = data.metafields[0];
        try {
          logs = JSON.parse(metafield.value) || [];
        } catch {
          logs = [];
        }
      }
    }

    // 2️⃣ Add the new log
    logs.push(log);
    const updatedValue = JSON.stringify(logs);

    let saveResp;

    if (metafield) {
      // Update old metafield
      saveResp = await fetch(`${baseUrl}/metafields/${metafield.id}.json`, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metafield: {
            id: metafield.id,
            value: updatedValue,
            type: "json",
          },
        }),
      });
    } else {
      // Create new one
      saveResp = await fetch(`${baseUrl}/metafields.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metafield: {
            namespace: "progress",
            key: "daily_logs",
            owner_resource: "customer",
            owner_id: Number(customerId),
            type: "json",
            value: updatedValue,
          },
        }),
      });
    }

    if (!saveResp.ok) {
      const msg = await saveResp.text();
      console.error("Error saving metafield:", msg);
      return res.status(500).json({ error: "Failed to save daily logs" });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("save-daily-log error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
