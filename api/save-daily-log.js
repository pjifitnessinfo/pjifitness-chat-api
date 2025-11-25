// /api/save-daily-log.js

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

async function shopifyAdminFetch(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL request failed");
  }

  return json.data;
}

async function getCustomerIdByEmail(email) {
  const query = `
    query getCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            email
          }
        }
      }
    }
  `;

  const data = await shopifyAdminFetch(query, {
    query: `email:${email}`,
  });

  const edges = data.customers.edges;
  if (!edges || edges.length === 0) return null;

  return edges[0].node.id;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const {
      email,
      date,
      weight,
      calories,
      steps,
      meals,
      mood,
      struggle,
      coach_focus,
      flag,
    } = req.body;

    if (!email || !date) {
      return res.status(400).json({ error: "Missing email or date" });
    }

    const customerId = await getCustomerIdByEmail(email);
    if (!customerId) {
      return res.status(404).json({ error: "Customer not found for email" });
    }

    // 1) Create Daily Log metaobject
    const createLogMutation = `
      mutation createDailyLog($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metaobjectInput = {
      type: "daily_log",
      fields: [
        { key: "date", value: date },
        { key: "weight", value: weight != null ? String(weight) : "" },
        { key: "calories", value: calories != null ? String(calories) : "" },
        { key: "steps", value: steps != null ? String(steps) : "" },
        { key: "meals", value: meals || "" },
        { key: "mood", value: mood || "" },
        { key: "struggle", value: struggle || "" },
        { key: "coach_focus", value: coach_focus || "" },
        { key: "flag", value: flag ? "true" : "false" },
        { key: "customer_id", value: email },
      ],
    };

    const createData = await shopifyAdminFetch(createLogMutation, {
      metaobject: metaobjectInput,
    });

    const newLogId = createData.metaobjectCreate.metaobject.id;

    // 2) Fetch the existing Daily Logs collection for this customer
    const getLogsQuery = `
      query getCustomerLogs($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "daily_logs") {
            references(first: 100) {
              nodes { id }
            }
          }
        }
      }
    `;

    const logsData = await shopifyAdminFetch(getLogsQuery, { id: customerId });
    const metafield = logsData.customer.metafield;

    let existingIds = [];
    if (metafield && metafield.references) {
      existingIds = metafield.references.nodes.map((node) => node.id);
    }

    const updatedIds = [...existingIds, newLogId];

    // 3) Update metafield
    const metafieldsSetMutation = `
      mutation setDailyLogs($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { message }
        }
      }
    `;

    await shopifyAdminFetch(metafieldsSetMutation, {
      metafields: [
        {
          ownerId: customerId,
          namespace: "custom",
          key: "daily_logs",
          type: "list.metaobject_reference",
          value: JSON.stringify(updatedIds),
        },
      ],
    });

    return res.status(200).json({ success: true, logId: newLogId });
  } catch (err) {
    console.error("save-daily-log error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
