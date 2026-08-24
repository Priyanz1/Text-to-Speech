import * as creditsService from './credits.service.js';

export async function getBalance(req, res) {
  const balance = await creditsService.getBalance(req.user._id);

  res.status(200).json({ success: true, data: { credits: balance } });
}

/**
 * The user's own ledger. Answers "where did my credits go" without anyone having
 * to open the database.
 */
export async function getLedger(req, res) {
  const limit = Number.parseInt(req.query.limit, 10);

  const entries = await creditsService.listLedger({
    userId: req.user._id,
    limit: Number.isFinite(limit) ? limit : 50,
  });

  res.status(200).json({ success: true, data: { entries } });
}
