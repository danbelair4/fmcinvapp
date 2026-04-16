/**
 * Netlify: signed PUT upload to Google Cloud Storage + stable public object URL.
 *
 * Env:
 *   GCS_BUCKET          — bucket name (required)
 *   GCP_SA_KEY_JSON     — optional JSON string of a service account with storage write (recommended on Netlify)
 *   SIGN_UPLOAD_DEBUG=1 — optional: log non-secret diagnostics (no secrets, no signed URL)
 *
 * If GCP_SA_KEY_JSON is unset, falls back to keyFilename 'service-account.json' (local dev only).
 *
 * Success JSON: { uploadUrl, publicUrl }
 *
 * V4 write signing: when the client sends a non-empty contentType, it is embedded in the
 * signature — the browser PUT must send the same Content-Type string and no other signed headers.
 * When contentType is "" (empty string), contentType is omitted from signing so PUT must not
 * send a Content-Type header (matches File.type === "").
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

function debugLog(payload) {
  if (String(process.env.SIGN_UPLOAD_DEBUG || '').trim() !== '1') return;
  try {
    console.log('[sign-upload]', JSON.stringify({ ...payload, at: new Date().toISOString() }));
  } catch (_) {
    console.log('[sign-upload]', payload);
  }
}

let storage;
function getStorage() {
  if (storage) return storage;
  const raw = process.env.GCP_SA_KEY_JSON;
  if (raw && String(raw).trim()) {
    let creds;
    try {
      creds = JSON.parse(String(raw).trim());
    } catch {
      throw new Error(
        'GCP_SA_KEY_JSON is set but is not valid JSON. Fix the Netlify env value (single line, escaped quotes).'
      );
    }
    if (!creds.client_email || !creds.private_key) {
      throw new Error('GCP_SA_KEY_JSON must be a full service account JSON object (client_email, private_key).');
    }
    storage = new Storage({ credentials: creds });
    return storage;
  }
  storage = new Storage({ keyFilename: 'service-account.json' });
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
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const BUCKET = (process.env.GCS_BUCKET || '').trim();
  if (!BUCKET) {
    return json(500, { error: 'Missing GCS_BUCKET environment variable.' });
  }

  let objectName;
  let contentType;
  try {
    const body = JSON.parse(event.body || '{}');
    objectName = body.objectName;
    contentType = body.contentType;
  } catch {
    return json(400, { error: 'Invalid JSON body.' });
  }
  if (!objectName || typeof objectName !== 'string') {
    return json(400, { error: 'Missing objectName.' });
  }
  if (typeof contentType !== 'string') {
    return json(400, { error: 'Missing contentType (must be File.type string, possibly empty).' });
  }

  const hasKeyEnv = Boolean(process.env.GCP_SA_KEY_JSON && String(process.env.GCP_SA_KEY_JSON).trim());
  debugLog({
    phase: 'request',
    bucket: BUCKET,
    objectName,
    contentTypeLen: contentType.length,
    signWithContentType: contentType.length > 0,
    credentialsSource: hasKeyEnv ? 'GCP_SA_KEY_JSON' : 'service-account.json',
  });

  try {
    getStorage();
  } catch (e) {
    debugLog({ phase: 'credentials', ok: false, error: e.message });
    return json(500, { error: e.message || String(e) });
  }

  const signOpts = {
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
  };
  if (contentType.length > 0) {
    signOpts.contentType = contentType;
  }

  try {
    const [uploadUrl] = await getStorage()
      .bucket(BUCKET)
      .file(objectName)
      .getSignedUrl(signOpts);

    const publicUrl = `https://storage.googleapis.com/${BUCKET}/${objectName}`;

    debugLog({
      phase: 'signed',
      bucket: BUCKET,
      objectName,
      signWithContentType: contentType.length > 0,
      signOk: true,
    });

    return json(200, { uploadUrl, publicUrl });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    debugLog({ phase: 'sign-error', bucket: BUCKET, objectName, error: msg });
    return json(500, { error: msg });
  }
};
