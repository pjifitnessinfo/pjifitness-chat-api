// /api/save-onboarding.js
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
      startWeight,
      goalWeight,
      age,
      heightFeet,
      heightInches,
      avgSteps,
      alcoholNights,
      mealsOut,
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. "pjifitness.myshopify.com"
    const SHOPIFY_ADMIN_API_ACCESS_TOKEN =
      process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
    const SHOPIFY_API_VERSION =
      process.env.SHOPIFY_API_VERSION || "2024-01";

    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
      return res
        .status(500)
        .json({ error: "Missing Shopify env vars" });
    }

    const shopifyEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    // 1) Find customer by email
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

    const queryRes = await fetch(shopifyEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query,
        variables: { query: `email:${email}` },
      }),
    });

    const queryJson = await queryRes.json();
    const edges = queryJson?.data?.customers?.edges || [];
    if (!edges.length) {
      return res
        .status(404)
        .json({ error: "Customer not found for email " + email });
    }

    const customerId = edges[0].node.id;

    // Build metafields from whatever we have
    // 🔴 IMPORTANT: type must match Shopify metafield definition type:
    //   - Integer → number_integer
    //   - Text (single line) → single_line_text_field
    const metafields = [];

    if (startWeight != null) {
      metafields.push({
        namespace: "custom",
        key: "start_weight",
        type: "number_integer",
        value: String(startWeight),
      });
    }

    if (goalWeight != null) {
      metafields.push({
        namespace: "custom",
        key: "goal_weight",
        type: "number_integer",
        value: String(goalWeight),
      });
    }

    if (age != null) {
      metafields.push({
        namespace: "custom",
        key: "age",
        type: "number_integer",
        value: String(age),
      });
    }

    if (heightFeet != null || heightInches != null) {
      const hFeet = heightFeet ?? 0;
      const hInches = heightInches ?? 0;
      const heightString = `${hFeet}'${hInches}"`;
      metafields.push({
        namespace: "custom",
        key: "height",
        type: "single_line_text_field",
        value: heightString,
      });
    }

    if (avgSteps != null) {
      metafields.push({
        namespace: "custom",
        key: "avg_steps",
        type: "number_integer",
        value: String(avgSteps),
      });
    }

    if (alcoholNights != null) {
      metafields.push({
        namespace: "custom",
        key: "alcohol_nights",
        type: "number_integer",
        value: String(alcoholNights),
      });
    }

    if (mealsOut != null) {
      metafields.push({
        namespace: "custom",
        key: "meals_out",
        type: "number_integer",
        value: String(mealsOut),
      });
    }

    if (!metafields.length) {
      return res
        .status(400)
        .json({ error: "No onboarding fields to save" });
    }

    const mutation = `
      mutation updateCustomerOnboarding($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const mutationRes = await fetch(shopifyEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            id: customerId,
            metafields,
          },
        },
      }),
    });

    const mutationJson = await mutationRes.json();
    const errors =
      mutationJson?.data?.customerUpdate?.userErrors || [];
    if (errors.length) {
      console.error("Shopify metafield errors:", errors);
      return res
        .status(400)
        .json({ error: "Shopify userErrors", details: errors });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("save-onboarding error:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: String(err) });
  }
}
