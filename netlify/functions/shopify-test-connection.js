/**
 * Netlify: Shopify connection test (Dev Dashboard app).
 * Uses client credentials grant — no permanent Admin API token in env.
 *
 * Env:
 *   SHOPIFY_STORE_DOMAIN
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET
 *   SHOPIFY_LOCATION_ID   (numeric or gid; echoed + matched against sample locations)
 */

const {
  normalizeShopDomain,
  acquireClientCredentialsFromEnv,
  API_VERSION,
} = require('./_shopifyClient');

const QUERY = `#graphql
query ShopifyConnectionTest {
  shop {
    name
  }
  locations(first: 3) {
    nodes {
      id
      name
      isActive
    }
  }
}
`;

function toLocationGid(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return '';
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/Location/${s}`;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * @returns {{ ok: boolean, data?: any, errors?: string, httpStatus?: number }}
 */
async function adminGraphql(shopDomain, accessToken, query) {
  const endpoint = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    return {
      ok: false,
      errors: `GraphQL request failed (network): ${e && e.message ? e.message : String(e)}`,
    };
  }

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = payload?.errors?.[0]?.message || payload?.message || `HTTP ${res.status}`;
    return { ok: false, errors: String(msg), httpStatus: res.status, data: payload };
  }

  if (payload.errors && payload.errors.length) {
    return {
      ok: false,
      errors: payload.errors.map((e) => e.message).join('; '),
      httpStatus: res.status,
      data: payload,
    };
  }

  return { ok: true, data: payload.data, httpStatus: res.status };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, {
      ok: false,
      error: 'Method not allowed. Use GET or POST.',
      shopDomain: null,
      tokenAcquisition: { ok: false, error: 'Not attempted' },
      graphql: { ok: false, error: 'Not attempted' },
      locationIdFromEnv: process.env.SHOPIFY_LOCATION_ID || null,
      summary: 'Unsupported HTTP method.',
    });
  }

  const shopDomain = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN || '');
  const clientId = (process.env.SHOPIFY_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();
  const locationIdRaw = (process.env.SHOPIFY_LOCATION_ID || '').trim();
  const locationGid = toLocationGid(locationIdRaw);

  const missing = [];
  if (!shopDomain) missing.push('SHOPIFY_STORE_DOMAIN');
  if (!clientId) missing.push('SHOPIFY_CLIENT_ID');
  if (!clientSecret) missing.push('SHOPIFY_CLIENT_SECRET');
  if (!locationIdRaw) missing.push('SHOPIFY_LOCATION_ID');

  if (missing.length) {
    return json(503, {
      ok: false,
      shopDomain: shopDomain || null,
      tokenAcquisition: { ok: false, error: 'Not attempted (missing env).' },
      graphql: { ok: false, error: 'Not attempted (missing env).' },
      locationIdFromEnv: locationIdRaw || null,
      summary: `Missing Netlify environment variables: ${missing.join(', ')}`,
    });
  }

  const tokenResult = await acquireClientCredentialsFromEnv();

  const tokenAcquisition = {
    ok: tokenResult.ok,
    ...(tokenResult.ok
      ? {
          scope: tokenResult.scope,
          expiresIn: tokenResult.expiresIn,
        }
      : { error: tokenResult.error, httpStatus: tokenResult.httpStatus }),
  };

  if (!tokenResult.ok || !tokenResult.accessToken) {
    return json(200, {
      ok: false,
      shopDomain,
      tokenAcquisition,
      graphql: { ok: false, error: 'Skipped because token acquisition failed.' },
      locationIdFromEnv: locationIdRaw,
      summary: `Cannot reach Admin API without a token: ${tokenResult.error || 'unknown error'}`,
    });
  }

  const gql = await adminGraphql(shopDomain, tokenResult.accessToken, QUERY);

  const shop = gql.data?.shop;
  const locNodes = gql.data?.locations?.nodes || [];
  const locationIdsReturned = locNodes.map((n) => n.id).filter(Boolean);
  const configuredLocationFound =
    Boolean(locationGid) && locationIdsReturned.includes(locationGid);

  const graphqlBlock = gql.ok
    ? {
        ok: true,
        shopName: shop?.name || null,
        locationsFirst3: locNodes.map((n) => ({
          id: n.id,
          name: n.name,
          isActive: n.isActive,
        })),
        configuredLocationId: locationIdRaw,
        configuredLocationGid: locationGid,
        configuredLocationInSample: configuredLocationFound,
        note: configuredLocationFound
          ? 'Configured location appears in the first 3 locations returned.'
          : 'Configured location was not in the first 3 locations (shop may have more locations, or ID may be wrong).',
      }
    : {
        ok: false,
        error: gql.errors || 'GraphQL failed',
        httpStatus: gql.httpStatus,
      };

  const overallOk = tokenResult.ok && gql.ok;
  const summary = overallOk
    ? `Connected to ${shopDomain} as "${shop?.name || 'shop'}". Token OK. GraphQL OK. Sample: ${locNodes.length} location(s).`
    : !tokenResult.ok
      ? 'Token step failed.'
      : `Token OK; GraphQL failed: ${graphqlBlock.error || 'unknown'}`;

  return json(200, {
    ok: overallOk,
    shopDomain,
    tokenAcquisition,
    graphql: graphqlBlock,
    locationIdFromEnv: locationIdRaw,
    summary,
  });
};
