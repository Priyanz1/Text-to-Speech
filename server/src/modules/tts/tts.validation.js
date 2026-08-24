import { z } from 'zod';

import { maxInputBytes } from '../../integrations/ttsProvider/index.js';

/**
 * Two independent limits on the input, both enforced here so a request that
 * cannot succeed is rejected before a Generation row exists or a single credit
 * moves.
 *
 *   bytes      - the provider's hard limit. Checked here because it is a
 *                property of the transport, not of the plan.
 *   characters - the plan's per-request cap. NOT checked here: it is read from
 *                the database per user, so tts.service.js enforces it.
 */
export const generateSchema = z.object({
  text: z
    .string()
    .min(1, 'Enter some text to convert')
    .refine((value) => value.trim().length > 0, { message: 'Enter some text to convert' })
    // Google measures its request limit in UTF-8 bytes, so this must too. For a
    // Hindi or Japanese input, bytes run two to three times the character count,
    // which is exactly the case a character-based check would let through and the
    // provider would then reject.
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxInputBytes, {
      message: `Text is too long: the limit is ${maxInputBytes} bytes of UTF-8 (non-English text uses more than one byte per character)`,
    }),

  // The provider's id, e.g. 'en-US-Neural2-F'. Validated against the catalog in
  // the service - a well-formed id for a voice we do not offer is still invalid.
  voiceId: z.string().trim().min(1, 'Choose a voice').max(120),

  /**
   * Optional, supplied by the client, one per submit attempt.
   *
   * This is what makes a double-clicked Generate button charge once. The unique
   * index on Generation.idempotencyKey is the actual guard; this only bounds the
   * length.
   */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
