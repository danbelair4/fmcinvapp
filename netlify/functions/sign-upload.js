/**
 * Netlify: signed PUT upload to Google Cloud Storage + stable public object URL.
 *
 * Env:
 *   GCS_BUCKET          — bucket name (required)
 *   GCP_SA_KEY_JSON     — optional JSON string of a service account with storage write (recommended on Netlify)
 *
 * If GCP_SA_KEY_JSON is unset, falls back to keyFilename 'service-account.json' (local dev only).
 *
 * Response JSON: { uploadUrl, publicUrl }
 * - uploadUrl: v4 signed URL for HTTP PUT of the file bytes
 * - publicUrl: https://storage.googleapis.com/{BUCKET}/{objectName}
 *   (object must be publicly readable for Shopify/csv to fetch — bucket IAM / object ACL as you configure)
 */

const { Storage } = require('@google-cloud/storage');

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(bodyObj),
  };
}

let storage;
function getStorage() {
  if (storage) return storage;
  const keyJson = process.env.GCP_SA_KEY_JSON && JSON.parse(process.env.GCP_SA_KEY_JSON);
  storage = new Storage(keyJson ? { credentials: keyJson } : { keyFilename: 'service-account.json' });
  return storage;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
      body: 'sign-upload is deployed',
    };
  }
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const BUCKET = (process.env.GCS_BUCKET || '').trim();
  if (!BUCKET) {
    return json(500, { ok: false, error: 'Missing GCS_BUCKET environment variable.' });
  }

  let objectName;
  let contentType;
  try {
    const body = JSON.parse(event.body || '{}');
    objectName = body.objectName;
    contentType = body.contentType || 'application/octet-stream';
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body.' });
  }
  if (!objectName || typeof objectName !== 'string') {
    return json(400, { ok: false, error: 'Missing objectName.' });
  }

  try {
    const [uploadUrl] = await getStorage()
      .bucket(BUCKET)
      .file(objectName)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + 15 * 60 * 1000,
        contentType,
      });

    const publicUrl = `https://storage.googleapis.com/${BUCKET}/${objectName}`;

    return json(200, { ok: true, uploadUrl, publicUrl });
  } catch (err) {
    return json(500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
};
