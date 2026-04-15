/**
 * Maps the single-page app's inventory item shape to Shopify GraphQL inputs.
 * Keep in sync with index.html `item` object built in addItem().
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/** @type {Record<string, string>} lowercase name → ISO 3166-1 alpha-2 */
const COUNTRY_NAME_TO_CODE = {
  afghanistan: 'AF',
  australia: 'AU',
  bolivia: 'BO',
  brazil: 'BR',
  burma: 'MM',
  canada: 'CA',
  chile: 'CL',
  china: 'CN',
  colombia: 'CO',
  france: 'FR',
  germany: 'DE',
  india: 'IN',
  indonesia: 'ID',
  madagascar: 'MG',
  mexico: 'MX',
  morocco: 'MA',
  myanmar: 'MM',
  namibia: 'NA',
  nepal: 'NP',
  pakistan: 'PK',
  peru: 'PE',
  russia: 'RU',
  'south africa': 'ZA',
  'sri lanka': 'LK',
  tanzania: 'TZ',
  thailand: 'TH',
  turkey: 'TR',
  uk: 'GB',
  usa: 'US',
  us: 'US',
  'united states': 'US',
  'united states of america': 'US',
  'united kingdom': 'GB',
  uruguay: 'UY',
  zambia: 'ZM',
  zimbabwe: 'ZW',
};

function escapeHtml(s) {
  return trimStr(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Map free-text origin to Shopify CountryCode, or null if unknown.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeCountryCodeForShopify(raw) {
  const s = trimStr(raw);
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (COUNTRY_NAME_TO_CODE[key]) return COUNTRY_NAME_TO_CODE[key];
  const compact = key.replace(/[^a-z]/g, '');
  for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
    if (name.replace(/[^a-z]/g, '') === compact) return code;
  }
  return null;
}

/**
 * Simple factual HTML body for the product (admin + Online Store).
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function buildDescriptionHtml(item) {
  const crystal = escapeHtml(item.crystalType);
  const ptype = escapeHtml(item.productType);
  const vendor = trimStr(item.vendor);
  const origin = trimStr(item.originCountry);
  const mode = escapeHtml(item.pricingMode || '');

  const parts = [
    `<p><strong>Crystal type:</strong> ${crystal}</p>`,
    `<p><strong>Product type:</strong> ${ptype}</p>`,
  ];
  if (vendor) parts.push(`<p><strong>Vendor:</strong> ${escapeHtml(vendor)}</p>`);
  if (origin) parts.push(`<p><strong>Country of origin:</strong> ${escapeHtml(origin)}</p>`);
  if (mode) parts.push(`<p><strong>Pricing mode:</strong> ${mode}</p>`);
  return parts.join('\n');
}

/**
 * InventoryItem fields for productVariantsBulkUpdate (nested under variant).
 * Enables tracking, unit cost, origin (when mappable), weight only when weight kg is positive.
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function buildVariantInventoryItemInput(item) {
  const sku = trimStr(item.sku);
  const cost = Number(item.cost);
  /** @type {Record<string, unknown>} */
  const o = {
    tracked: true,
    requiresShipping: true,
  };
  if (sku) o.sku = sku;
  if (Number.isFinite(cost) && cost > 0) {
    o.cost = cost;
  }

  const cc = normalizeCountryCodeForShopify(item.originCountry);
  if (cc) o.countryCodeOfOrigin = cc;

  const w = Number(item.weight);
  if (Number.isFinite(w) && w > 0) {
    o.measurement = {
      weight: {
        value: w,
        unit: 'KILOGRAMS',
      },
    };
  }

  return o;
}

/**
 * @param {Record<string, unknown>} item
 * @returns {string|null} error message or null if ok
 */
function validateItemPayload(item) {
  if (!item || typeof item !== 'object') return 'Request body must be a JSON object (inventory item).';
  const crystal = trimStr(item.crystalType);
  const productType = trimStr(item.productType);
  const cost = Number(item.cost);
  const pricingMode = trimStr(item.pricingMode) || 'per_kilo';
  const weight = Number(item.weight);

  if (!crystal) return 'crystalType is required.';
  if (!productType) return 'productType is required.';
  if (!Number.isFinite(cost) || cost <= 0) return 'cost must be a positive number.';

  if (pricingMode === 'per_kilo') {
    if (!Number.isFinite(weight) || weight <= 0) return 'weight (kg) is required for per_kilo pricing.';
  }

  const sku = trimStr(item.sku);
  if (!sku) return 'sku is required (use generated SKU or manual override).';

  const qty = parseInt(String(item.quantity ?? '1'), 10);
  if (!Number.isFinite(qty) || qty < 0) return 'quantity must be a non-negative integer.';

  const price = Number(item.retailPrice);
  if (!Number.isFinite(price) || price < 0) return 'retailPrice must be a valid number.';

  return null;
}

function buildTitle(item) {
  const t = `${trimStr(item.crystalType)} ${trimStr(item.productType)}`.replace(/\s+/g, ' ').trim();
  return t || 'Inventory item';
}

function buildTags(item) {
  const tags = new Set();
  const add = (v) => {
    const s = trimStr(v);
    if (s) tags.add(s);
  };
  add(item.crystalType);
  add(item.productType);
  add(item.originCountry);
  add(item.pricingMode);
  const cc = normalizeCountryCodeForShopify(item.originCountry);
  if (cc) tags.add(`origin:${cc}`);
  return Array.from(tags);
}

function shopifyStatus(item) {
  const s = (trimStr(item.status) || 'active').toLowerCase();
  return s === 'draft' ? 'DRAFT' : 'ACTIVE';
}

function formatMoneyAmount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0.00';
  return x.toFixed(2);
}

/**
 * @param {Record<string, unknown>} item
 */
function buildProductCreateInput(item) {
  return {
    title: buildTitle(item),
    descriptionHtml: buildDescriptionHtml(item),
    vendor: trimStr(item.vendor) || undefined,
    productType: trimStr(item.productType) || undefined,
    status: shopifyStatus(item),
    tags: buildTags(item),
  };
}

function toLocationGid(raw) {
  const s = trimStr(raw);
  if (!s) return '';
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/Location/${s}`;
}

module.exports = {
  validateItemPayload,
  buildTitle,
  buildTags,
  shopifyStatus,
  formatMoneyAmount,
  buildProductCreateInput,
  buildDescriptionHtml,
  buildVariantInventoryItemInput,
  normalizeCountryCodeForShopify,
  toLocationGid,
};
