import { env } from '../../config/env.js';

/**
 * The only way the rest of the codebase touches stored audio.
 *
 * One transport today, so this is a re-export rather than a switch - a dispatch
 * over a single case would be pretending to a choice that does not exist.
 * STORAGE_PROVIDER is already an enum in config/env.js, so adding s3.js means
 * turning these five lines into the same `const provider = ...` shape that
 * integrations/ttsProvider uses.
 */
export { buildKey, put, get, remove, describe } from './local.js';

export const providerName = env.STORAGE_PROVIDER;
