/**
 * Minimal Shopify Admin GraphQL client (server-side only).
 * Env: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN
 */

const API_VERSION = '2025-01';

function normalizeShopDomain(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d.endsWith('.myshopify.com') && !d.includes('.')) {
    d = `${d}.myshopify.com`;
  }
  return d;
}

function graphqlEndpoint() {
  const domain = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN || '');
  if (!domain) throw new Error('Missing SHOPIFY_STORE_DOMAIN');
  return `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
}

/**
 * @param {string} query
 * @param {Record<string, unknown>|undefined} variables
 * @returns {Promise<{ data: any, errors?: any[] }>}
 */
async function shopifyGraphql(query, variables) {
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
  if (!token) throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN');

  const res = await fetch(graphqlEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (json.errors && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    throw new Error(msg);
  }
  return json;
}

module.exports = { shopifyGraphql, normalizeShopDomain, API_VERSION };
