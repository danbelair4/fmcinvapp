/**
 * Netlify Function: create one Shopify product from the inventory app's item JSON.
 *
 * Field mapping follows index.html `exportToCSV` (CSV = source of truth), including
 * description + disclaimer, photo URLs + alt text, then productCreateMedia + publishablePublish.
 *
 * Auth (Dev Dashboard — client credentials):
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 *
 * Inventory:
 *   SHOPIFY_LOCATION_ID   numeric or gid://shopify/Location/...
 *
 * Scopes: write_products, read_products, write_inventory, read_inventory,
 *         read_publications, write_publications (for channel publish)
 */

const {
  acquireClientCredentialsFromEnv,
  shopifyGraphqlWithToken,
} = require('./_shopifyClient');
const {
  validateItemPayload,
  buildProductCreateInput,
  toLocationGid,
  computeCsvHandleParts,
  buildCsvVariantBulkFields,
  csvVariantInventoryQty,
  validateCsvPhotosForShopify,
  buildProductCreateMediaInputsFromCsvItem,
} = require('./_shopifyItemMapper');

const MUTATION_PRODUCT_CREATE = `#graphql
mutation ProductCreate($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product {
      id
      title
      handle
      variants(first: 5) {
        nodes {
          id
          sku
          price
          inventoryItem {
            id
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const MUTATION_VARIANTS_BULK_UPDATE = `#graphql
mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants {
      id
      sku
      price
      taxable
      inventoryPolicy
      inventoryItem {
        id
        tracked
        unitCost {
          amount
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const MUTATION_INVENTORY_SET = `#graphql
mutation InventorySet($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup {
      id
    }
    userErrors {
      field
      message
    }
  }
}
`;

const MUTATION_PRODUCT_CREATE_MEDIA = `#graphql
mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media {
      id
      alt
      mediaContentType
      status
    }
    mediaUserErrors {
      field
      message
    }
    product {
      id
    }
  }
}
`;

/** Publication has no `channels` field in Admin API — use `catalog.title` for a human label when present. */
const QUERY_PUBLICATIONS = `#graphql
query PublicationsForPublish {
  publications(first: 50) {
    edges {
      node {
        id
        autoPublish
        catalog {
          title
        }
      }
    }
  }
}
`;

/** Fallback if `catalog { title }` is not permitted for this token/API version. */
const QUERY_PUBLICATIONS_IDS_ONLY = `#graphql
query PublicationsIdsOnly {
  publications(first: 50) {
    edges {
      node {
        id
        autoPublish
      }
    }
  }
}
`;

const MUTATION_PUBLISHABLE_PUBLISH = `#graphql
mutation PublishablePublish($id: ID!, $publicationInput: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $publicationInput) {
    publishable {
      ... on Product {
        id
        title
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

const QUERY_PRODUCT_VARIANT = `#graphql
query FirstVariant($id: ID!) {
  product(id: $id) {
    id
    variants(first: 1) {
      nodes {
        id
        sku
        price
        inventoryItem {
          id
          tracked
        }
      }
    }
  }
}
`;

function collectUserErrors(payload) {
  const list = payload?.userErrors || payload?.UserErrors;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((e) => e.message || String(e)).join(' | ');
}

function collectMediaUserErrors(payload) {
  const list = payload?.mediaUserErrors;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((e) => e.message || String(e)).join(' | ');
}

function firstVariantFromProduct(product) {
  const nodes = product?.variants?.nodes;
  if (Array.isArray(nodes) && nodes[0]) return nodes[0];
  const edges = product?.variants?.edges;
  if (Array.isArray(edges) && edges[0]?.node) return edges[0].node;
  return null;
}

function publicationNodesFromQuery(data) {
  const conn = data?.publications;
  if (!conn) return [];
  if (Array.isArray(conn.nodes) && conn.nodes.length) {
    return conn.nodes.filter((n) => n && n.id).map(normalizePublicationNode);
  }
  const edges = conn.edges;
  if (!Array.isArray(edges)) return [];
  return edges.map((e) => e && e.node).filter((n) => n && n.id).map(normalizePublicationNode);
}

function normalizePublicationNode(node) {
  const t = node.catalog && typeof node.catalog.title === 'string' ? node.catalog.title.trim() : '';
  return {
    id: node.id,
    name: t || null,
    autoPublish: Boolean(node.autoPublish),
  };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed. Use POST.' }),
    };
  }

  const missing = [];
  if (!process.env.SHOPIFY_STORE_DOMAIN) missing.push('SHOPIFY_STORE_DOMAIN');
  if (!process.env.SHOPIFY_CLIENT_ID) missing.push('SHOPIFY_CLIENT_ID');
  if (!process.env.SHOPIFY_CLIENT_SECRET) missing.push('SHOPIFY_CLIENT_SECRET');
  if (!process.env.SHOPIFY_LOCATION_ID) missing.push('SHOPIFY_LOCATION_ID');
  if (missing.length) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `Shopify is not configured. Set Netlify environment variables: ${missing.join(', ')}`,
      }),
    };
  }

  let item;
  try {
    item = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body.' }),
    };
  }

  const validationError = validateItemPayload(item);
  if (validationError) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: validationError }),
    };
  }

  const photoValidationError = validateCsvPhotosForShopify(item);
  if (photoValidationError) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: photoValidationError,
      }),
    };
  }

  const locationGid = toLocationGid(process.env.SHOPIFY_LOCATION_ID);
  if (!locationGid) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Invalid SHOPIFY_LOCATION_ID' }),
    };
  }

  const auth = await acquireClientCredentialsFromEnv();
  if (!auth.ok || !auth.accessToken || !auth.shopDomain) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `Shopify authentication failed: ${auth.error || 'unknown error'}`,
      }),
    };
  }

  const { shopDomain, accessToken } = auth;
  const gql = (query, variables) => shopifyGraphqlWithToken(shopDomain, accessToken, query, variables);

  const HANDLE_SEQ = 1;
  const handleParts = computeCsvHandleParts(item, HANDLE_SEQ);

  /** @type {{ mediaAttached: number, mediaError: string|null, publications: Array<{id: string, name: string|null, published: boolean, error?: string}>, publishQueryError: string|null }} */
  const meta = {
    mediaAttached: 0,
    mediaError: null,
    publications: [],
    publishQueryError: null,
  };

  try {
    const productInput = buildProductCreateInput(item, HANDLE_SEQ);
    const createRes = await gql(MUTATION_PRODUCT_CREATE, { product: productInput });
    const createPayload = createRes?.data?.productCreate;
    const createErr = collectUserErrors(createPayload);
    if (createErr) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: createErr }) };
    }
    let product = createPayload?.product;
    if (!product?.id) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: 'Shopify returned no product id.' }),
      };
    }

    let variant = firstVariantFromProduct(product);
    if (!variant?.id) {
      const q = await gql(QUERY_PRODUCT_VARIANT, { id: product.id });
      const p2 = q?.data?.product;
      variant = firstVariantFromProduct(p2);
    }

    if (!variant?.id) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          ok: false,
          error: 'Could not read default product variant from Shopify after create.',
          productId: product.id,
        }),
      };
    }

    const sku = String(item.sku || '').trim();
    const csvBulk = buildCsvVariantBulkFields(item, handleParts);
    const variantPatch = {
      id: variant.id,
      ...csvBulk,
    };

    const bulkRes = await gql(MUTATION_VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: [variantPatch],
    });

    const bulkPayload = bulkRes?.data?.productVariantsBulkUpdate;
    const bulkErr = collectUserErrors(bulkPayload);
    if (bulkErr) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          ok: false,
          error: `Variant update failed: ${bulkErr}`,
          productId: product.id,
          variantId: variant.id,
        }),
      };
    }

    const updatedList = bulkPayload?.productVariants;
    const updated =
      Array.isArray(updatedList) && updatedList.length ? updatedList[0] : variant;

    let inventoryItemId = updated?.inventoryItem?.id || variant.inventoryItem?.id;
    if (!inventoryItemId) {
      const refreshed = await gql(QUERY_PRODUCT_VARIANT, { id: product.id });
      const v2 = firstVariantFromProduct(refreshed?.data?.product);
      inventoryItemId = v2?.inventoryItem?.id;
    }

    const qty = csvVariantInventoryQty(item);

    if (inventoryItemId) {
      const invInput = {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `netlify://inventory-app/${Date.now()}`,
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId,
            locationId: locationGid,
            quantity: qty,
          },
        ],
      };

      const invRes = await gql(MUTATION_INVENTORY_SET, { input: invInput });
      const invPayload = invRes?.data?.inventorySetQuantities;
      const invErr = collectUserErrors(invPayload);
      if (invErr) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            ok: false,
            error: `Inventory update failed: ${invErr}`,
            productId: product.id,
            variantId: variant.id,
            inventoryItemId,
          }),
        };
      }
    }

    const mediaInputs = buildProductCreateMediaInputsFromCsvItem(item);
    if (mediaInputs.length) {
      try {
        const mRes = await gql(MUTATION_PRODUCT_CREATE_MEDIA, {
          productId: product.id,
          media: mediaInputs,
        });
        const mPayload = mRes?.data?.productCreateMedia;
        const mErr = collectMediaUserErrors(mPayload);
        if (mErr) {
          meta.mediaError = mErr;
        } else {
          meta.mediaAttached = Array.isArray(mPayload?.media) ? mPayload.media.length : mediaInputs.length;
        }
      } catch (me) {
        meta.mediaError = me && me.message ? me.message : String(me);
      }
    }

    let publicationNodes = [];
    try {
      const pubRes = await gql(QUERY_PUBLICATIONS, {});
      publicationNodes = publicationNodesFromQuery(pubRes?.data);
    } catch (pe) {
      try {
        const pubRes2 = await gql(QUERY_PUBLICATIONS_IDS_ONLY, {});
        publicationNodes = publicationNodesFromQuery(pubRes2?.data);
      } catch (pe2) {
        meta.publishQueryError = (pe && pe.message ? pe.message : String(pe)) || String(pe2);
      }
    }

    if (publicationNodes.length) {
      for (const n of publicationNodes) {
        try {
          const pubMut = await gql(MUTATION_PUBLISHABLE_PUBLISH, {
            id: product.id,
            publicationInput: [{ publicationId: n.id }],
          });
          const pubPayload = pubMut?.data?.publishablePublish;
          const pubErr = collectUserErrors(pubPayload);
          meta.publications.push({
            id: n.id,
            name: n.name || null,
            autoPublish: n.autoPublish,
            published: !pubErr,
            error: pubErr || undefined,
          });
        } catch (pme) {
          meta.publications.push({
            id: n.id,
            name: n.name || null,
            autoPublish: n.autoPublish,
            published: false,
            error: pme && pme.message ? pme.message : String(pme),
          });
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        productId: product.id,
        variantId: updated?.id || variant.id,
        inventoryItemId: inventoryItemId || null,
        handle: product.handle || handleParts.handle,
        title: product.title,
        sku,
        price: csvBulk.price,
        quantitySet: qty,
        inventoryTracked: Boolean(updated?.inventoryItem?.tracked),
        mediaAttached: meta.mediaAttached,
        mediaError: meta.mediaError,
        publications: meta.publications,
        publishQueryError: meta.publishQueryError,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }),
    };
  }
};
