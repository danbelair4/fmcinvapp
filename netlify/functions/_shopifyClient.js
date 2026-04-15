/**
 * Shopify Admin GraphQL (server-side only).
 *
 * Auth options:
 *   1) Dev Dashboard — client credentials (recommended for this app):
 *      SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 *   2) Legacy — single long-lived Admin API token:
 *      SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN
 *
 * See: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
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

function adminGraphqlUrlForDomain(shopDomain) {
  const d = normalizeShopDomain(shopDomain);
  if (!d) throw new Error('Missing or invalid shop domain');
  return `https://${d}/admin/api/${API_VERSION}/graphql.json`;
}

/**
 * @param {string} shopDomain normalized .myshopify.com host
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ ok: true, accessToken: string, scope?: string, expiresIn?: number } | { ok: false, error: string, httpStatus?: number }>}
 */
async function acquireClientCredentialsToken(shopDomain, clientId, clientSecret) {
  const domain = normalizeShopDomain(shopDomain);
  const url = `https://${domain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Token request failed (network): ${e && e.message ? e.message : String(e)}`,
    };
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data?.error_description ||
      data?.error ||
      (typeof data === 'string' ? data : null) ||
      `HTTP ${res.status}`;
    return { ok: false, error: String(msg), httpStatus: res.status };
  }

  const accessToken = data.access_token;
  if (!accessToken) {
    return { ok: false, error: 'Token response missing access_token.', httpStatus: res.status };
  }

  return {
    ok: true,
    accessToken,
    scope: data.scope || '',
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
  };
}

/**
 * Client credentials using process.env (Dev Dashboard app).
 * @returns {Promise<{ ok: true, accessToken: string, shopDomain: string, scope?: string, expiresIn?: number } | { ok: false, error: string, httpStatus?: number }>}
 */
async function acquireClientCredentialsFromEnv() {
  const shopDomain = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN || '');
  const clientId = (process.env.SHOPIFY_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();

  if (!shopDomain || !clientId || !clientSecret) {
    return {
      ok: false,
      error:
        'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET (client credentials).',
    };
  }

  const r = await acquireClientCredentialsToken(shopDomain, clientId, clientSecret);
  if (!r.ok) return r;
  return { ...r, shopDomain };
}

/**
 * @param {string} shopDomain
 * @param {string} accessToken
 * @param {string} query
 * @param {Record<string, unknown>|undefined} variables
 * @returns {Promise<{ data: any, errors?: any[] }>}
 */
async function shopifyGraphqlWithToken(shopDomain, accessToken, query, variables) {
  const token = accessToken || '';
  if (!token) throw new Error('Missing access token for GraphQL');

  const res = await fetch(adminGraphqlUrlForDomain(shopDomain), {
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

/**
 * GraphQL using SHOPIFY_ADMIN_ACCESS_TOKEN from env (legacy custom app token).
 * @param {string} query
 * @param {Record<string, unknown>|undefined} variables
 * @returns {Promise<{ data: any, errors?: any[] }>}
 */
async function shopifyGraphql(query, variables) {
  const shopDomain = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN || '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
  if (!shopDomain) throw new Error('Missing SHOPIFY_STORE_DOMAIN');
  if (!token) throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN');
  return shopifyGraphqlWithToken(shopDomain, token, query, variables);
}

module.exports = {
  API_VERSION,
  normalizeShopDomain,
  acquireClientCredentialsToken,
  acquireClientCredentialsFromEnv,
  shopifyGraphqlWithToken,
  shopifyGraphql,
};
