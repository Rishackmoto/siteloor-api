const express = require('express');
const router = express.Router();

const sql = require('mssql');
const { getPool } = require('../../../core/network/db');

function levelName(levelid) {
  return ({
    '1': 'Operator',
    '2': 'Supervisor',
    '3': 'Admin',
    '4': 'Approval',
    '5': 'Administrator',
  })[String(levelid || '').trim()] || '-';
}

router.post('/api/login', async (req, res) => {
  console.time('LOGIN');

  try {
    const { userid, pass } = req.body || {};

    if (!userid || !pass) {
      console.timeEnd('LOGIN');
      return res.status(400).json({
        success: false,
        message: 'User ID dan password wajib diisi',
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('userid', sql.VarChar(30), String(userid).trim())
      .query(`
        SELECT TOP 1
          noref,
          userid,
          username,
          pass,
          levelid,
          flag
        FROM muser
        WHERE userid = @userid
          AND ISNULL(flag, '1') = '1'
      `);

    const user = result.recordset[0];

    if (!user || String(user.pass || '').trim() !== String(pass).trim()) {
      console.timeEnd('LOGIN');
      return res.status(401).json({
        success: false,
        message: 'User ID atau password salah / user tidak aktif',
      });
    }

    const { pass: _pass, ...safeUser } = user;

    console.timeEnd('LOGIN');

    return res.json({
      success: true,
      message: 'Login berhasil',
      user: {
        ...safeUser,
        level_name: levelName(user.levelid),
      },
    });
  } catch (error) {
    console.timeEnd('LOGIN');
    console.error('LOGIN ERROR:', error);

    if (isDbLoginError && isDbLoginError(error)) {
      return res.status(503).json({
        success: false,
        message: `Login database gagal untuk ${getDbTarget()}`,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan server',
      error: error.message,
    });
  }
});

router.post('/api/users/:userid/foto-profile', upload.single('foto'), async (req, res) => {
    try {
        const { userid } = req.params;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Foto belum dipilih',
            });
        }

        const filename = `${Date.now()}-profile-${safeFilename(req.file.originalname)}`;
        const key = `profile/${userid}/${filename}`;

        const fileUrl = await uploadToB2({
            key,
            buffer: req.file.buffer,
            contentType: req.file.mimetype,
        });

        console.log('PROFILE URL:', fileUrl);

        const pool = await getPool();
        await maybeEnsureSchema(ensureMuserProfileColumn, pool);

        await pool.request()
            .input('userid', sql.VarChar, userid)
            .input('foto_profile', sql.VarChar, fileUrl)
            .query(`
        UPDATE muser
        SET foto_profile = @foto_profile
        WHERE userid = @userid
      `);

        res.json({
            success: true,
            message: 'Foto profile berhasil diperbarui',
            foto_profile: fileUrl,
        });
    } catch (err) {
        console.error('UPLOAD FOTO PROFILE ERROR:', err);

        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

module.exports = router;