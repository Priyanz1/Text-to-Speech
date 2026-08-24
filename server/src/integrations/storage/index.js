import { env } from '../../config/env.js';

import * as local from './local.js';
import * as s3 from './s3.js';

/**
 * The only way the rest of the codebase touches stored audio.
 *
 * Two transports chosen by one env var, the same shape as
 * integrations/ttsProvider and integrations/email:
 *
 *   local - files on this machine's disk. Right for development, and wrong for
 *           any host with an ephemeral filesystem (Render's free plan included):
 *           a deploy takes every file and leaves the Generation rows pointing at
 *           nothing.
 *   s3    - any S3-compatible bucket. The permanent one.
 *
 * The key format is identical in both, so switching providers does not
 * invalidate keys already in the database - only where they resolve. Migrating
 * existing audio means copying the files across; the records need no change.
 *
 * Note that put() takes an optional { contentType }. local.js ignores it (the
 * filesystem has no such concept) and s3.js defaults it, because what is served
 * back to a browser is Generation.audio.mimeType from the database, not whatever
 * the object store thinks it holds.
 */
const provider = env.STORAGE_PROVIDER === 's3' ? s3 : local;

export const { buildKey, put, get, remove, describe } = provider;

export const providerName = env.STORAGE_PROVIDER;
