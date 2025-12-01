// /api/save-daily-log.js
// Append a log object to customer.metafields.custom.daily_logs (JSON array).

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    try {
      if (req.body && typeof req.body === "object") {
        return resolve(req.body);
      }
      let data = "";
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error("Invalid JSON body", e);
          resolve({});
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function shopifyAdminFetch(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_TOKEN) {
    throw new Error("Missing Shopify env vars");
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  if (json.errors) {
    console.error("Shopify GraphQL errors:", JSON.stringify(json.errors, null, 2));
    throw new Error("Shopify GraphQL error");
  }
  return json;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error("Error parsing body", e);
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { customerId, log } = body || {};
  if (!customerId || !log) {
    res.status(400).json({ error: "Missing customerId or log" });
    return;
  }

  // Build Shopify global ID from numeric ID
  const gid = customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;

  try {
    // 1) Get existing daily_logs metafield for this customer
    const getQuery = `
      query GetDailyLogs($id: ID!) {
        customer(id: $id) {
          id
          metafield(namespace: "custom", key: "daily_logs") {
            id
            value
          }
        }
      }
    `;

    const getResp = await shopifyAdminFetch(getQuery, { id: gid });
    const customer = getResp.data?.customer;

    let existingLogs = [];
    let metafieldId = null;

    if (customer?.metafield?.value) {
      try {
        existingLogs = JSON.parse(customer.metafield.value) || [];
      } catch (e) {
        console.warn("Could not parse existing daily_logs JSON, resetting.", e);
        existingLogs = [];
      }
      metafieldId = customer.metafield.id;
    }

    // 2) Append new log
    const newLog = {
      date: log.date || new Date().toISOString().slice(0, 10),
      weight: log.weight ?? null,
      calories: log.calories ?? null,
      steps: log.steps ?? null,
      meals: Array.isArray(log.meals) ? log.meals : [],
      total_calories: log.total_calories ?? log.calories ?? null,
      mood: log.mood ?? null,
      struggle: log.struggle ?? null,
      coach_focus: log.coach_focus || "Daily check-in saved."
    };

    const updatedLogs = [...existingLogs, newLog];

    // 3) Save back to Shopify metafield
    const setMutation = `
      mutation SetDailyLogs($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            namespace
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldsInput = [
      {
        ownerId: gid,
        namespace: "custom",
        key: "daily_logs",
        type: "json",
        value: JSON.stringify(updatedLogs)
      }
    ];

    const setResp = await shopifyAdminFetch(setMutation, {
      metafields: metafieldsInput
    });

    const userErrors = setResp.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("Shopify metafieldsSet userErrors:", userErrors);
      res.status(500).json({ error: "Failed to save daily_logs", details: userErrors });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("save-daily-log error:", e);
    res.status(500).json({ error: "Server error" });
  }
}
