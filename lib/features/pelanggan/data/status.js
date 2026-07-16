const express = require('express');
const pengajuanRoute = require('./pengajuan');
const { getDbTarget } = require('../../../core/network/db');

const router = express.Router();

router.get('/api/status/pengajuan', (req, res) => {
  res.json({
    success: true,
    db_target: getDbTarget(),
    ensure_on_request: pengajuanRoute.runDbEnsureOnRequest === true,
    manual_ensure_endpoint: '/api/status/pengajuan/ensure',
  });
});

router.post('/api/status/pengajuan/ensure', async (req, res) => {
  try {
    const startedAt = Date.now();
    const steps = await pengajuanRoute.ensureDatabase();
    res.json({
      success: true,
      message: 'Ensure database pengajuan selesai.',
      duration_ms: Date.now() - startedAt,
      steps,
    });
  } catch (error) {
    console.error('ENSURE PENGAJUAN ERROR:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
