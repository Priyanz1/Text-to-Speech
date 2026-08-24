import * as adminService from './admin.service.js';

/** Same defensive query reading as generations.controller.js - validate() only parses bodies. */
function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readString(value, max = 120) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export async function listUsers(req, res) {
  const result = await adminService.listUsers({
    search: readString(req.query.search),
    page: readPositiveInt(req.query.page, 1),
    limit: readPositiveInt(req.query.limit, adminService.DEFAULT_PAGE_SIZE),
  });

  res.status(200).json({ success: true, data: result });
}

export async function listPlans(req, res) {
  const plans = await adminService.listPlans();

  res.status(200).json({ success: true, data: { plans } });
}

export async function listVoices(req, res) {
  const result = await adminService.listVoices({
    page: readPositiveInt(req.query.page, 1),
    limit: readPositiveInt(req.query.limit, adminService.DEFAULT_PAGE_SIZE),
  });

  res.status(200).json({ success: true, data: result });
}

export async function getOverview(req, res) {
  const overview = await adminService.getOverview();

  res.status(200).json({ success: true, data: overview });
}
