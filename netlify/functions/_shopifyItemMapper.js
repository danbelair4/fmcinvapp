/**
 * Maps the single-page app's inventory item shape to Shopify GraphQL inputs.
 * Keep in sync with index.html `item` object built in addItem().
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
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
  toLocationGid,
};
