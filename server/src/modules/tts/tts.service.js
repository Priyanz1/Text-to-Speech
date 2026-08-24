import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import * as storage from '../../integrations/storage/index.js';
import * as ttsProvider from '../../integrations/ttsProvider/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { quote } from '../credits/credits.calc.js';
import * as creditsService from '../credits/credits.service.js';
import { GENERATION_STATUS, Generation } from '../generations/generation.model.js';
import { getPlanForUser } from '../plans/plans.service.js';
import * as voicesService from '../voices/voices.service.js';

/**
 * The generate path, and the only place credits and the provider meet.
 *
 * The ordering below is deliberate and is the whole design:
 *
 *   1. validate everything that can be validated for free
 *   2. create the Generation row, pending
 *   3. reserve credits
 *   4. call the provider
 *   5. store the audio
 *   6. mark it completed
 *
 * Step 2 before step 3 is the part worth explaining. Generation.idempotencyKey is
 * uniquely indexed, so creating the row first means a retried request collides on
 * the index *before* any credits move, and we hand back the original generation
 * instead of charging twice. Reserving first would put the money outside the
 * guard.
 *
 * Every failure after step 3 refunds. A user who was charged and got no audio is
 * the one outcome this file exists to prevent.
 */

async function markFailed(generation, reason) {
  generation.status = GENERATION_STATUS.FAILED;
  generation.failureReason = reason;
  await generation.save();
}

/**
 * Charged, then failed: put the credits back and report the failure.
 *
 * The refund is attempted before the error propagates, and a refund that itself
 * fails is logged rather than thrown - the user needs to hear about the
 * generation failing, not about the bookkeeping, and reconcile() will surface the
 * discrepancy.
 */
async function failAndRefund(generation, { reason, status, message }) {
  await markFailed(generation, reason);

  try {
    await creditsService.refund({ generation, note: `Refund: ${reason}` });
  } catch (refundError) {
    logger.error('Refund failed after a failed generation', {
      generationId: generation._id.toString(),
      error: refundError.message,
    });
  }

  return new ApiError(status, message);
}

export async function generate({ user, text, voiceId, idempotencyKey = null }) {
  const [voice, plan] = await Promise.all([
    voicesService.findActiveByVoiceId(voiceId),
    getPlanForUser(user),
  ]);

  if (!voice) {
    throw new ApiError(404, 'That voice is not available. Pick another from the list.');
  }

  // Re-checked here even though /api/voices already filters by plan: the list the
  // client renders is a convenience, and the request is what has to be right.
  if (plan.allowedVoiceTiers.length > 0 && !plan.allowedVoiceTiers.includes(voice.tier)) {
    throw new ApiError(403, `The ${plan.name} plan does not include ${voice.tier} voices.`);
  }

  const { charCount, byteLength, credits } = quote({ text, voice });

  // The plan's cap, in characters. The provider's byte cap was already enforced
  // by the validator; this one needs the database, so it lands here.
  if (charCount > plan.maxCharsPerRequest) {
    throw new ApiError(
      400,
      `Text is too long for the ${plan.name} plan: ${charCount} characters, limit ${plan.maxCharsPerRequest}.`,
      { charCount, maxCharsPerRequest: plan.maxCharsPerRequest },
    );
  }

  let generation;

  try {
    generation = await Generation.create({
      userId: user._id,
      text,
      charCount,
      byteLength,
      voice: {
        // A snapshot, not a reference. costMultiplier will be recalibrated, and a
        // history row has to show the multiplier the charge was actually made at.
        voiceId: voice.providerVoiceId,
        provider: voice.provider,
        name: voice.name,
        languageCode: voice.languageCode,
        tier: voice.tier,
        costMultiplier: voice.costMultiplier,
      },
      creditsCharged: credits,
      status: GENERATION_STATUS.PENDING,
      // Omitted rather than nulled, so the sparse unique index does not index
      // this document at all. See the field's comment on the model.
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      // A retry or a double-click. Return what the first attempt produced.
      const existing = await Generation.findOne({ idempotencyKey, userId: user._id });

      if (existing) {
        logger.info('Returning an existing generation for a repeated idempotency key', {
          generationId: existing._id.toString(),
        });

        return { generation: existing, credits: await creditsService.getBalance(user._id) };
      }
    }

    throw error;
  }

  // From here on the row exists, so every exit either completes it or fails it.
  let reserved;

  try {
    reserved = await creditsService.reserve({
      userId: user._id,
      credits,
      generationId: generation._id,
      note: `${charCount} characters with ${voice.providerVoiceId}`,
    });
  } catch (error) {
    // Nothing was charged, so this is a mark-failed and not a refund.
    await markFailed(generation, error instanceof ApiError ? error.message : 'Could not reserve credits');
    throw error;
  }

  generation.creditSplit = reserved.split;
  await generation.save();

  let result;

  try {
    result = await ttsProvider.synthesize({
      text,
      voiceId: voice.providerVoiceId,
      languageCode: voice.languageCode,
    });
  } catch (error) {
    // The provider's own message, logged in full and not returned: it can carry
    // project ids and quota details that the user cannot act on.
    logger.error('Provider synthesis failed', {
      generationId: generation._id.toString(),
      provider: ttsProvider.providerName,
      error: error.message,
    });

    throw await failAndRefund(generation, {
      reason: 'The speech provider rejected the request',
      status: 502,
      message: 'Speech generation failed and your credits have been returned. Please try again.',
    });
  }

  try {
    const key = storage.buildKey({ userId: user._id, extension: result.extension });
    const stored = await storage.put(key, result.audio);

    generation.audio = {
      storageKey: stored.key,
      mimeType: result.mimeType,
      encoding: result.encoding,
      byteSize: stored.byteSize,
    };
  } catch (error) {
    logger.error('Could not store generated audio', {
      generationId: generation._id.toString(),
      error: error.message,
    });

    throw await failAndRefund(generation, {
      reason: 'Could not save the generated audio',
      status: 500,
      message: 'The audio could not be saved and your credits have been returned. Please try again.',
    });
  }

  generation.status = GENERATION_STATUS.COMPLETED;
  await generation.save();

  logger.info('Generation completed', {
    generationId: generation._id.toString(),
    charCount,
    credits,
    provider: ttsProvider.providerName,
  });

  return { generation, credits: { ...reserved.balanceAfter, planSlug: plan.slug } };
}

/**
 * The audio bytes for one generation.
 *
 * Ownership is checked by putting userId in the query rather than comparing after
 * the fetch - the two are equivalent until someone edits the comparison out.
 * There are no signed URLs: the client sends its access token, same as every
 * other request.
 */
export async function getAudio({ userId, generationId }) {
  // A malformed id would otherwise reach Mongoose, throw a CastError, and be
  // reported as a 500. It is a request for something that cannot exist.
  if (!mongoose.isValidObjectId(generationId)) {
    throw new ApiError(404, 'That audio is not available.');
  }

  const generation = await Generation.findOne({ _id: generationId, userId });

  if (!generation || !generation.audio?.storageKey) {
    // 404 rather than 403 for someone else's id, so this endpoint cannot be used
    // to discover which generation ids exist.
    throw new ApiError(404, 'That audio is not available.');
  }

  const buffer = await storage.get(generation.audio.storageKey);

  if (!buffer) {
    // Local storage on an ephemeral disk: a deploy wipes it. Worth its own
    // message, because "try generating it again" is the actual remedy.
    throw new ApiError(410, 'That audio file is no longer on the server. Generate it again.');
  }

  return {
    buffer,
    mimeType: generation.audio.mimeType,
    filename: `speech-${generation._id.toString()}.${generation.audio.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`,
  };
}

/**
 * The limits the form needs in order to stop a request that cannot succeed.
 *
 * Behind auth because maxCharsPerRequest is per plan. Sending it rather than
 * hard-coding it in the client is what keeps the counter in the UI and the check
 * on the server from drifting apart.
 */
export async function getConfig(user) {
  const plan = await getPlanForUser(user);

  return {
    maxInputBytes: ttsProvider.maxInputBytes,
    maxCharsPerRequest: plan.maxCharsPerRequest,
    planSlug: plan.slug,
    planName: plan.name,
  };
}
