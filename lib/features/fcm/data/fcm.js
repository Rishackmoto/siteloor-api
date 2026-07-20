const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../../core/network/db');

const router = express.Router();

const clean = (value) => String(value ?? '').trim();

/**
 * POST /api/fcm/register
 *
 * Body:
 * {
 *   "userid": "ADMIN",
 *   "token": "fcm-token...",
 *   "device": "Samsung S22",
 *   "platform": "android"
 * }
 */
router.post('/register', async (req, res) => {
  try {
    console.log('================================');
    console.log('FCM REGISTER DIPANGGIL');
    console.log('CONTENT-TYPE:', req.headers['content-type']);
    console.log('BODY:', req.body);
    console.log('================================');

    const userid = clean(req.body?.userid);
    const token = clean(req.body?.token);
    const device = clean(req.body?.device) || 'Unknown Device';
    const platform = clean(req.body?.platform) || 'unknown';

    if (!userid) {
      return res.status(400).json({
        success: false,
        message: 'Userid wajib diisi.',
        body_received: req.body,
      });
    }

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token FCM wajib diisi.',
      });
    }

/**
 * POST /api/fcm/unregister
 *
 * Dipakai saat user logout.
 */
router.post('/unregister', async (req, res) => {
  try {
    const token = clean(req.body.token);

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token FCM wajib diisi.',
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('token', sql.NVarChar(sql.MAX), token)
      .query(`
        UPDATE user_fcm
        SET
          aktif = 0,
          updated_at = GETDATE()
        WHERE token = @token;

        SELECT @@ROWCOUNT AS affected_rows;
      `);

    const affectedRows = result.recordset?.[0]?.affected_rows ?? 0;

    return res.json({
      success: true,
      message:
        affectedRows > 0
          ? 'Token FCM berhasil dinonaktifkan.'
          : 'Token FCM tidak ditemukan.',
      affected_rows: affectedRows,
    });
  } catch (error) {
    console.error('UNREGISTER FCM TOKEN ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal menonaktifkan token FCM.',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : undefined,
    });
  }
});

/**
 * GET /api/fcm/tokens/:userid
 *
 * Untuk pengecekan token aktif milik user.
 * Token sengaja tidak ditampilkan penuh.
 */
router.get('/tokens/:userid', async (req, res) => {
  try {
    const userid = clean(req.params.userid);

    if (!userid) {
      return res.status(400).json({
        success: false,
        message: 'Userid wajib diisi.',
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('userid', sql.VarChar(100), userid)
      .query(`
        SELECT
          id,
          userid,
          device,
          platform,
          aktif,
          created_at,
          updated_at,
          CASE
            WHEN LEN(token) > 20
              THEN LEFT(token, 10) + '...' + RIGHT(token, 8)
            ELSE token
          END AS token_preview
        FROM user_fcm
        WHERE userid = @userid
        ORDER BY aktif DESC, updated_at DESC;
      `);

    return res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
    });
  } catch (error) {
    console.error('GET USER FCM TOKENS ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil token FCM.',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : undefined,
    });
  }
});

module.exports = router;