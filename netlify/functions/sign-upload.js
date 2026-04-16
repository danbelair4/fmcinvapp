/**
 * Netlify: signed PUT upload to Google Cloud Storage + stable public object URL.
 *
 * Env:
 *   GCS_BUCKET          — bucket name (required)
 *   GCP_SA_KEY_JSON     — optional JSON string of a service account with storage write (recommended on Netlify)
 *   SIGN_UPLOAD_DEBUG=1 — optional: log non-secret diagnostics (no secrets, no full signed URL)
 *
 * If GCP_SA_KEY_JSON is unset, falls back to keyFilename 'service-account.json' (local dev only).
 *
 * Success JSON: { uploadUrl, publicUrl }
 *
 * V4 write: when JSON body contentType is a non-empty string, it is passed to getSignedUrl and
 * appears in X-Goog-SignedHeaders — the browser PUT MUST include the same Content-Type value.
 * When contentType is "", signing omits contentType — PUT must not send Content-Type.
 *
 * Bucket CORS must allow PUT and typically list Content-Type in allowed request headers so the
 * browser is permitted to send it after preflight.
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

/** Extract X-Goog-SignedHeaders query value only (for logs; not the full URL). */
function signedHeadersFromUrl(href) {
  try {
    const m = String(href).match(/[?&]X-Goog-SignedHeaders=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
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

  const signWithContentType = contentType.length > 0;
  const hasKeyEnv = Boolean(process.env.GCP_SA_KEY_JSON && String(process.env.GCP_SA_KEY_JSON).trim());
  debugLog({
    phase: 'request',
    bucket: BUCKET,
    objectName,
    contentTypeLen: contentType.length,
    signWithContentType,
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
  if (signWithContentType) {
    signOpts.contentType = contentType;
  }

  try {
    const [uploadUrl] = await getStorage()
      .bucket(BUCKET)
      .file(objectName)
      .getSignedUrl(signOpts);

    const signedHeadersParam = signedHeadersFromUrl(uploadUrl);
    debugLog({
      phase: 'signed',
      bucket: BUCKET,
      objectName,
      signWithContentType,
      signedHeadersParam,
      signedUrlIncludesContentType: signedHeadersParam.toLowerCase().split(';').includes('content-type'),
      signOk: true,
    });

    const publicUrl = `https://storage.googleapis.com/${BUCKET}/${objectName}`;

    return json(200, { uploadUrl, publicUrl });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    debugLog({ phase: 'sign-error', bucket: BUCKET, objectName, error: msg });
    return json(500, { error: msg });
  }
};
