import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import * as storage from '../../integrations/storage/index.js';
import { ApiError } from '../../utils/ApiError.js';

import { GENERATION_STATUS, Generation } from './generation.model.js';

/**
 * Reading and deleting one user's own generation history.
 *
 * Every query in this file carries `userId` in the filter rather than fetching by
 * id and comparing afterwards. The two are equivalent right up until someone
 * edits the comparison out, and a history row holds the text the user submitted.
 *
 * Nothing here moves credits. Deleting a generation removes the record and the
 * audio, but the charge already happened and the ledger keeps its row - history
 * is a view of the past, not a way to undo it.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * How long a pending row is assumed to still be generating.
 *
 * Deleting a row mid-generation would pull the document out from under the
 * generate path, whose next save() would then fail *after* credits were reserved
 * and before the refund path could run. A pending row older than this is instead
 * a leftover from a process that died mid-request, and refusing to delete that
 * forever would leave junk in the list with no way to clear it.
 */
const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * A route parameter is an arbitrary string, and Mongoose casting a non-id string
 * throws - which the error handler would turn into a 500. A malformed id is a
 * request for something that cannot exist, so it is a 404 like any other miss.
 */
function assertObjectId(generationId) {
  if (!mongoose.isValidObjectId(generationId)) {
    throw new ApiError(404, 'That generation does not exist.');
  }
}

/**
 * One page of history, newest first. Backed by the { userId, createdAt: -1 }
 * index the model already declares.
 *
 * Offset pagination, which is the right shape for a screen with page numbers and
 * the wrong one for very deep pages - skip() still walks what it skips. At the
 * volumes one account generates it will not matter; if it ever does, the fix is a
 * createdAt cursor rather than a bigger index.
 */
export async function list({ userId, page = 1, limit = DEFAULT_PAGE_SIZE }) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const safePage = Math.max(Math.trunc(page) || 1, 1);

  const filter = { userId };

  const [rows, total] = await Promise.all([
    Generation.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    Generation.countDocuments(filter),
  ]);

  return {
    generations: rows.map((row) => row.toListJSON()),
    page: safePage,
    limit: safeLimit,
    total,
    // At least 1, so an empty history reports "page 1 of 1" rather than "of 0".
    totalPages: Math.max(Math.ceil(total / safeLimit), 1),
    hasMore: safePage * safeLimit < total,
  };
}

/** One generation, including the full submitted text. */
export async function getOne({ userId, generationId }) {
  assertObjectId(generationId);

  const generation = await Generation.findOne({ _id: generationId, userId });

  // 404 rather than 403 for someone else's id, so this cannot be used to find
  // out which generation ids exist.
  if (!generation) throw new ApiError(404, 'That generation does not exist.');

  return generation;
}

/**
 * Deletes a generation and its audio file.
 *
 * The record goes first and the file second: a row whose file is already gone is
 * a state the audio endpoint handles (410, "generate it again"), while a file
 * whose row is gone is invisible and unreachable. So if the second step fails,
 * the user still got what they asked for and the leak is logged.
 */
export async function remove({ userId, generationId }) {
  assertObjectId(generationId);

  const inFlight = await Generation.findOne({
    _id: generationId,
    userId,
    status: GENERATION_STATUS.PENDING,
    createdAt: { $gt: new Date(Date.now() - IN_FLIGHT_GRACE_MS) },
  }).select('_id');

  if (inFlight) {
    throw new ApiError(409, 'That generation is still running. Try again in a moment.');
  }

  const deleted = await Generation.findOneAndDelete({ _id: generationId, userId });

  if (!deleted) throw new ApiError(404, 'That generation does not exist.');

  /**
   * The ledger is deliberately left alone.
   *
   * CreditTransaction is append-only and is the source of truth the cached
   * balance is reconciled against, so removing its rows would make the two
   * disagree and would misreport what the account actually spent. The
   * generationId on those rows becomes a dangling reference, which is the
   * intended trade: the money record outlives the content record.
   */
  if (deleted.audio?.storageKey) {
    try {
      await storage.remove(deleted.audio.storageKey);
    } catch (error) {
      logger.error('Could not delete stored audio for a removed generation', {
        generationId: deleted._id.toString(),
        error: error.message,
      });
    }
  }

  logger.info('Generation deleted', { generationId: deleted._id.toString() });

  return { id: deleted._id.toString() };
}
