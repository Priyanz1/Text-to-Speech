import { createHash, createHmac, randomUUID } from 'node:crypto';

import { env, s3Endpoint } from '../../config/env.js';

/**
 * Generated audio in any S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze
 * B2, MinIO. This is the permanent storage local.js is not.
 *
 * Signature Version 4 over plain fetch, rather than @aws-sdk/client-s3. The SDK
 * is roughly 15 MB of dependency to do what four functions do here, and the same
 * reasoning already applied to Google (integrations/ttsProvider/google.js signs
 * its own JWT) and to Resend. The signing algorithm is public, fixed, and about
 * sixty lines.
 *
 * The bytes always travel through this API - the browser never gets a bucket
 * URL, signed or otherwise. Audio is private, the object is served by
 * /api/tts/generations/:id/audio after an ownership check, and a presigned URL
 * would be a second, un-revokable way to reach it.
 */
const SERVICE = 's3';
const UNSIGNED_PAYLOAD_ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/**
 * Where a key lives, as a URL and the Host header that has to be signed with it.
 *
 * Two addressing styles, because implementations disagree:
 *   virtual-host  https://bucket.s3.region.amazonaws.com/key   (AWS)
 *   path          https://endpoint/bucket/key                  (R2, MinIO, B2)
 */
function resolveUrl(key) {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  if (!s3Endpoint) {
    const host = `${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
    return { url: `https://${host}/${encodedKey}`, host, path: `/${encodedKey}` };
  }

  const { host, protocol } = new URL(s3Endpoint);

  const path = env.S3_FORCE_PATH_STYLE
    ? `/${env.S3_BUCKET}/${encodedKey}`
    : `/${encodedKey}`;

  const requestHost = env.S3_FORCE_PATH_STYLE ? host : `${env.S3_BUCKET}.${host}`;

  return { url: `${protocol}//${requestHost}${path}`, host: requestHost, path };
}

/**
 * Builds the Authorization header for one request.
 *
 * The payload hash is included rather than sent as UNSIGNED-PAYLOAD, so a proxy
 * that altered the body in flight would produce a signature mismatch instead of
 * a silently corrupted audio file.
 */
function sign({ method, host, path, payload, contentType }) {
  // '20260824T131500Z' - SigV4's own format, not ISO 8601. A request more than
  // 15 minutes from the server's clock is rejected, which is why a wrong system
  // clock shows up here as an auth failure.
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(payload ?? '');

  // Signed headers must be sorted, lowercase, and exactly the ones sent.
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(contentType ? { 'content-type': contentType } : {}),
  };

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method,
    path,
    '', // No query string on any request this adapter makes.
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${env.S3_REGION}/${SERVICE}/aws4_request`;

  const stringToSign = [
    UNSIGNED_PAYLOAD_ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // The signing key is derived per day, per region, per service - which is what
  // limits the blast radius of one leaked signature.
  const dateKey = hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, dateStamp);
  const regionKey = hmac(dateKey, env.S3_REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, 'aws4_request');

  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `${UNSIGNED_PAYLOAD_ALGORITHM} Credential=${env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function s3Fetch({ method, key, body, contentType }) {
  const { url, host, path } = resolveUrl(key);

  const headers = sign({ method, host, path, payload: body, contentType });

  return fetch(url, { method, headers, body });
}

/**
 * Same key shape as local.js: <userHash>/<uuid>.<ext>
 *
 * Sharded by a hash of the user id rather than the id itself, so a bucket
 * listing does not enumerate account identifiers. Keeping the two adapters'
 * keys identical means switching STORAGE_PROVIDER does not invalidate the format
 * of keys already in the database - only where they resolve.
 */
export function buildKey({ userId, extension }) {
  const shard = createHash('sha256').update(String(userId)).digest('hex').slice(0, 8);
  return `${shard}/${randomUUID()}.${extension}`;
}

export async function put(key, buffer, { contentType = 'application/octet-stream' } = {}) {
  const response = await s3Fetch({ method: 'PUT', key, body: buffer, contentType });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // 403 here is nearly always the key pair or the bucket policy, and 301 on
    // AWS is the wrong region - both are setup problems, and the body says which.
    throw new Error(`S3 rejected the upload (${response.status}): ${detail.slice(0, 300)}`);
  }

  return { key, byteSize: buffer.byteLength };
}

/** Returns the bytes, or null when the object is gone - same contract as local.js. */
export async function get(key) {
  const response = await s3Fetch({ method: 'GET', key });

  if (response.status === 404) return null;

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`S3 rejected the download (${response.status}): ${detail.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Best-effort delete. A missing object is already the desired state. */
export async function remove(key) {
  const response = await s3Fetch({ method: 'DELETE', key });

  // S3 returns 204 for a delete whether or not the object existed.
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '');
    throw new Error(`S3 rejected the delete (${response.status}): ${detail.slice(0, 300)}`);
  }
}

export function describe() {
  return `s3 (${env.S3_BUCKET} @ ${s3Endpoint || `aws:${env.S3_REGION}`})`;
}
