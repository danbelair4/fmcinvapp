/**
 * Shopify mappings derived ONLY from the CSV export contract in index.html `exportToCSV`.
 * Do not add fields or marketing copy that the CSV does not define.
 *
 * Reference: index.html lines ~1186–1321 (exportToCSV parent row + image rows).
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/** Same as CSV `slugify` helper (exportToCSV). */
function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * CSV handle + supporting parts. `sequenceForBase` mirrors `handleSeq[base]` for one export
 * when `skuDigits` is empty (default 1 = first row for that base).
 * @param {Record<string, unknown>} item
 * @param {number} [sequenceForBase]
 */
function computeCsvHandleParts(item, sequenceForBase = 1) {
  const crystal = (item.crystalType || '').toString();
  const type = (item.productType || '').toString();
  const base = slugify([crystal, type].filter(Boolean).join('-')) || 'item';
  const seq = Math.max(1, parseInt(String(sequenceForBase), 10) || 1);
  const suffix4 = String(seq).padStart(4, '0');
  const skuDigits = (String(item.sku || '').match(/(\d+)\s*$/) || [])[1] || '';
  const handle = skuDigits ? `${base}-${skuDigits}` : `${base}-${suffix4}`;
  return { crystal, type, base, suffix4, skuDigits, handle };
}

/**
 * CSV Title column: (item.title && trim) || crystal + type || 'Crystal'
 * @param {Record<string, unknown>} item
 */
function buildCsvTitle(item) {
  const t = item.title != null ? trimStr(item.title) : '';
  if (t) return t;
  const crystal = (item.crystalType || '').toString();
  const type = (item.productType || '').toString();
  const joined = [crystal, type].filter(Boolean).join(' ').trim();
  return joined || 'Crystal';
}

/**
 * CSV tags string: [type, ...item.tags].join(', ')
 * @param {Record<string, unknown>} item
 */
function buildCsvTagsString(item) {
  const type = (item.productType || '').toString();
  const extra = Array.isArray(item.tags) ? item.tags : item.tags ? [item.tags] : [];
  return [type, ...extra].filter(Boolean).join(', ');
}

/**
 * GraphQL wants tag list; CSV stores one comma-space-joined cell (same join as export).
 * @param {Record<string, unknown>} item
 */
function buildCsvTagsArray(item) {
  const s = buildCsvTagsString(item);
  if (!s) return [];
  return s.split(', ').map((t) => t.trim()).filter(Boolean);
}

/**
 * CSV Body (HTML) column (exportToCSV): baseDesc + disclaimer, or disclaimer only.
 * Same template and strings as index.html — no extra rewriting.
 */
function buildCsvBodyHtml(item) {
  const disclaimer = 'Color and appearance may vary; each crystal is unique.';
  const baseDesc = trimStr(item.description);
  if (baseDesc) {
    return `${baseDesc}\n\n${disclaimer}`;
  }
  return disclaimer;
}

/**
 * Same URL filter as exportToCSV: only http(s) links from item.photos[].url.
 * @param {Record<string, unknown>} item
 * @returns {string[]}
 */
function csvHttpsPhotoUrls(item) {
  return (Array.isArray(item.photos) ? item.photos : [])
    .map((p) => (p && p.url) || '')
    .filter((u) => /^https?:\/\//i.test(String(u).trim()));
}

/**
 * CSV Image Alt Text base: `${title}${item.sku ? ' – ' + item.sku : ''}`
 * (exportToCSV uses template literal with title from same row).
 * @param {Record<string, unknown>} item
 */
function buildCsvImageAltBase(item) {
  const title = buildCsvTitle(item);
  const sku = trimStr(item.sku);
  return sku ? `${title} – ${sku}` : title;
}

/**
 * Reject Google Drive / Docs *view or share* links that are not direct image URLs.
 * CSV would still emit the string; Shopify cannot fetch those for product media.
 * @param {string} url
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validatePhotoUrlForShopify(url) {
  const raw = trimStr(url);
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }
  if (!/^https?:$/i.test(u.protocol)) {
    return { ok: false, reason: 'Only http(s) URLs are allowed (same filter as CSV export).' };
  }
  const host = u.hostname.toLowerCase();
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const href = u.href;
    const looksDirect =
      /export=download|uc\?[^#]*export=download|googleusercontent\.com\/|\/thumbnail|id=[^&]+&export=download/.test(
        href
      );
    const looksViewOrShare =
      /\/file\/d\/[^/]+\/view|\/file\/d\/[^/?]+\?|\/open\?id=|\/sharing/.test(href) ||
      (/\/file\/d\//.test(u.pathname) && !looksDirect);
    if (looksViewOrShare && !looksDirect) {
      return {
        ok: false,
        reason:
          'Google Drive sharing or view URL is not a direct image link. Use a public https URL that returns image bytes (same requirement as Shopify importing Image Src from CSV).',
      };
    }
  }
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} item
 * @returns {string|null} single error message or null if all listed https URLs are acceptable
 */
function validateCsvPhotosForShopify(item) {
  const urls = csvHttpsPhotoUrls(item);
  for (const url of urls) {
    const r = validatePhotoUrlForShopify(url);
    if (!r.ok) return `${r.reason} (${url})`;
  }
  return null;
}

/**
 * CreateMediaInput[] for productCreateMedia — alt text matches CSV parent + extra image rows.
 * @param {Record<string, unknown>} item
 * @returns {Array<{ alt: string, mediaContentType: string, originalSource: string }>}
 */
function buildProductCreateMediaInputsFromCsvItem(item) {
  const urls = csvHttpsPhotoUrls(item);
  const altBase = buildCsvImageAltBase(item);
  return urls.map((url, i) => ({
    alt: i === 0 ? altBase : `${altBase} (${i + 1})`,
    mediaContentType: 'IMAGE',
    originalSource: String(url).trim(),
  }));
}

/**
 * CSV Variant Grams: variantGrams if finite, else round(weight kg * 1000).
 */
function csvVariantGrams(item) {
  if (Number.isFinite(Number(item.variantGrams))) {
    return parseInt(String(item.variantGrams), 10);
  }
  return Math.round((Number(item.weight) || 0) * 1000);
}

/**
 * CSV Cost per item column.
 */
function csvCostPerItem(item) {
  return Number(
    item.costPerItem != null
      ? item.costPerItem
      : item.pricingMode === 'per_piece'
        ? Number(item.cost || 0)
        : (Number(item.weight) || 0) * Number(item.cost || 0)
  );
}

/**
 * CSV Variant Barcode column.
 */
function buildCsvBarcode(item, parts) {
  const fromItem = item.barcode && String(item.barcode).trim();
  if (fromItem) return fromItem;
  const fromSku = item.sku && String(item.sku).trim();
  if (fromSku) return fromSku;
  return `${parts.base.toUpperCase()}-${parts.suffix4}`;
}

/**
 * CSV Variant Price: money(Math.round(retailPrice)) → two decimals string.
 */
function csvVariantPriceString(item) {
  return Math.round(Number(item.retailPrice || 0)).toFixed(2);
}

/**
 * CSV Variant Inventory Qty: max(1, parseInt(quantity|qty|1)).
 */
function csvVariantInventoryQty(item) {
  return Math.max(1, parseInt(String(item.quantity ?? item.qty ?? 1), 10) || 1);
}

/**
 * UI stores lower-case publish status; Shopify expects enum strings.
 * Defaults to ACTIVE to preserve existing behavior when status is missing.
 * @param {Record<string, unknown>} item
 * @returns {'ACTIVE'|'DRAFT'}
 */
function csvProductStatus(item) {
  const raw = trimStr(item && item.status).toLowerCase();
  return raw === 'draft' ? 'DRAFT' : 'ACTIVE';
}

/**
 * ProductCreateInput aligned to CSV parent row (Handle, Title, Body, Vendor, Type, Tags, Status,
 * gift card FALSE, SEO title/description).
 * @param {Record<string, unknown>} item
 * @param {number} [handleSequenceForBase]
 */
function buildProductCreateInput(item, handleSequenceForBase = 1) {
  const parts = computeCsvHandleParts(item, handleSequenceForBase);
  const title = buildCsvTitle(item);
  const baseDesc = trimStr(item.description);
  /** CSV SEO Description column: raw slice, same as exportToCSV (not HTML-escaped). */
  const seoDescription = baseDesc.slice(0, 320);

  return {
    handle: parts.handle,
    title,
    descriptionHtml: buildCsvBodyHtml(item),
    vendor: trimStr(item.vendor) || undefined,
    productType: (item.productType || '').toString().trim() || undefined,
    tags: buildCsvTagsArray(item),
    status: csvProductStatus(item),
    giftCard: false,
    seo: {
      title,
      description: seoDescription,
    },
  };
}

/**
 * InventoryItem nested input for productVariantsBulkUpdate — CSV-implied variant/inventory fields.
 * @param {Record<string, unknown>} item
 */
function buildVariantInventoryItemInput(item) {
  const grams = csvVariantGrams(item);
  const cost = csvCostPerItem(item);
  const sku = trimStr(item.sku);

  /** @type {Record<string, unknown>} */
  const o = {
    tracked: true,
    requiresShipping: true,
  };
  if (sku) o.sku = sku;
  if (Number.isFinite(cost) && cost >= 0) {
    o.cost = cost;
  }
  o.measurement = {
    weight: {
      value: grams,
      unit: 'GRAMS',
    },
  };
  return o;
}

/**
 * Variant-level fields from CSV: price, barcode, taxable TRUE, inventory policy deny.
 * @param {Record<string, unknown>} item
 * @param {{ base: string, suffix4: string }} parts
 */
function buildCsvVariantBulkFields(item, parts) {
  return {
    price: csvVariantPriceString(item),
    barcode: buildCsvBarcode(item, parts),
    taxable: true,
    inventoryPolicy: 'DENY',
    inventoryItem: buildVariantInventoryItemInput(item),
  };
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

function formatMoneyAmount(n) {
  return csvVariantPriceString({ retailPrice: n });
}

function toLocationGid(raw) {
  const s = trimStr(raw);
  if (!s) return '';
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/Location/${s}`;
}

module.exports = {
  validateItemPayload,
  slugify,
  computeCsvHandleParts,
  buildCsvTitle,
  buildCsvTagsString,
  buildCsvTagsArray,
  buildCsvBodyHtml,
  csvHttpsPhotoUrls,
  buildCsvImageAltBase,
  validatePhotoUrlForShopify,
  validateCsvPhotosForShopify,
  buildProductCreateMediaInputsFromCsvItem,
  csvVariantGrams,
  csvCostPerItem,
  buildCsvBarcode,
  csvVariantPriceString,
  csvVariantInventoryQty,
  csvProductStatus,
  buildProductCreateInput,
  buildVariantInventoryItemInput,
  buildCsvVariantBulkFields,
  formatMoneyAmount,
  toLocationGid,
};
