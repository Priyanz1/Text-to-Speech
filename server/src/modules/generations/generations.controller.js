import * as generationsService from './generations.service.js';

/**
 * Query strings are not covered by validate(), which only parses req.body.
 *
 * So they are read defensively here: a repeated ?page=1&page=2 arrives as an
 * array, and anything non-numeric has to fall back rather than reach the query as
 * NaN. The service clamps the range; this only guarantees the type.
 */
function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function list(req, res) {
  const result = await generationsService.list({
    // From the access token, never from the request - there is no route or query
    // parameter that can ask for someone else's history.
    userId: req.user._id,
    page: readPositiveInt(req.query.page, 1),
    limit: readPositiveInt(req.query.limit, generationsService.DEFAULT_PAGE_SIZE),
  });

  res.status(200).json({ success: true, data: result });
}

export async function getOne(req, res) {
  const generation = await generationsService.getOne({
    userId: req.user._id,
    generationId: req.params.id,
  });

  // toPublicJSON, not toListJSON: the point of fetching one is the full text.
  res.status(200).json({ success: true, data: { generation: generation.toPublicJSON() } });
}

export async function remove(req, res) {
  const { id } = await generationsService.remove({
    userId: req.user._id,
    generationId: req.params.id,
  });

  // 200 with the envelope every other endpoint uses, rather than a bare 204: the
  // client's error handling reads `success`, and an empty body has none.
  res.status(200).json({ success: true, data: { id, message: 'Generation deleted.' } });
}
