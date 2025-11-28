// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

function assertEnv() {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_TOKEN) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_ACCESS_TOKEN env vars"
    );
  }
}

async function shopifyAdminFetch(query, variables = {}) {
  assertEnv();

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    console.error("Network error when calling Shopify:", err);
    throw new Error("Network error contacting Shopify");
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error("Failed to parse Shopify response JSON:", err);
    throw new Error("Bad JSON from Shopify");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error raw:", JSON.stringify(json, null, 2));
    const msg = json.errors ? JSON.stringify(json.errors) : JSON.stringify(json);
    throw new Error(msg);
  }

  return json.data;
}

// Very simple: append the new log to existing array
function appendLog(existingLogs, incomingLog) {
  const logs = Array.isArray(existingLogs) ? [...existingLogs] : [];
  logs.push(incomingLog);
  return logs;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const email = (body.email || "").toLowerCase(); // debug only
    const log = body.log;
    const customerId = body.customerId;          // numeric or gid
    const existingLogs = Array.isArray(body.existingLogs)
      ? body.existingLogs
      : [];

    if (!customerId || !log) {
      res.status(400).json({
        error: "Missing required fields 'customerId' or 'log'",
      });
      return;
    }

    console.log("save-daily-log incoming email:", email);
    console.log("save-daily-log incoming customerId:", customerId);
    console.log("save-daily-log incoming log:", JSON.stringify(log));

    const updatedLogs = appendLog(existingLogs, log);

    // ✅ Ensure ownerId is a valid Shopify global ID (gid)
    const ownerGid = String(customerId).startsWith("gid://")
      ? String(customerId)
      : `gid://shopify/Customer/${customerId}`;

    const mutation = `
      mutation SaveDailyLogs($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            namespace
            type
            value
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const metafields = [
      {
        ownerId: ownerGid,
        namespace: "custom",
        key: "daily_logs",
        type: "json",
        value: JSON.stringify(updatedLogs),
      },
    ];

    const data = await shopifyAdminFetch(mutation, { metafields });

    const errors = data?.metafieldsSet?.userErrors || [];
    if (errors.length > 0) {
      console.error("Error saving daily_logs metafield:", errors);
      res.status(500).json({
        error: "Shopify metafieldsSet userErrors",
        details: errors,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      count: updatedLogs.length,
    });
  } catch (err) {
    console.error("Error in /api/save-daily-log:", err);
    res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err),
    });
  }
}
