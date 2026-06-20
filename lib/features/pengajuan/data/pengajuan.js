const express = require('express');
const router = express.Router();

const multer = require('multer');
const path = require('path');
const sql = require('mssql');

const { getPool } = require('../../../core/network/db');
const { uploadToB2 } = require('../../../core/storage/backblaze');

function levelName(levelid) {
  return ({
    '1': 'Operator',
    '2': 'Supervisor',
    '3': 'Admin',
    '4': 'Approval',
    '5': 'Administrator',
  })[String(levelid || '').trim()] || '-';
}

function jabatanName(jabat) {
  return ({
    '11': 'Super User',
    '12': 'AO',
    '13': 'Admin Kredit',
    '14': 'Supervisor',
    '15': 'Manager',
    '16': 'Kepatuhan',
    '17': 'Direksi',
    '18': 'Komisaris',
    '19': 'SKAI',
  })[String(jabat || '').trim()] || '-';
}

function safeFilename(filename) {
  return String(filename || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function ensureMuserProfileColumn(pool) {
  await pool.request().query(`
    IF COL_LENGTH('dbo.muser', 'foto_profile') IS NULL
    BEGIN
      ALTER TABLE dbo.muser ADD foto_profile NVARCHAR(500) NULL
    END
  `);
}

async function hasTableColumn(pool, tableName, columnName) {
  const result = await pool.request()
    .input('tableName', sql.NVarChar(128), tableName)
    .input('columnName', sql.NVarChar(128), columnName)
    .query(`
      SELECT has_column =
        CASE WHEN COL_LENGTH(@tableName, @columnName) IS NULL THEN 0 ELSE 1 END
    `);

  return result.recordset[0]?.has_column === 1;
}

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();

    if (!allowedExtensions.has(extension)) {
      return callback(new Error('Foto hanya boleh JPG, PNG, JPEG, atau WEBP.'));
    }

    callback(null, true);
  },
});

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
    await ensureMuserProfileColumn(pool);
    const hasKdcab = await hasTableColumn(pool, 'dbo.muser', 'kdcab');

    const result = await pool.request()
      .input('userid', sql.VarChar(30), String(userid).trim())
      .query(`
        SELECT TOP 1
          noref,
          userid,
          username,
          pass,
          levelid,
          flag,
          email,
          nohp,
          jabat,
          ${hasKdcab ? 'kdcab' : 'CAST(NULL AS VARCHAR(30)) AS kdcab'},
          foto_profile
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
        jabatan_name: jabatanName(user.jabat),
      },
    });
  } catch (error) {
    console.timeEnd('LOGIN');
    console.error('LOGIN ERROR:', error);

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

    if (!userid) {
      return res.status(400).json({
        success: false,
        message: 'User ID kosong',
      });
    }

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

    const pool = await getPool();
    await ensureMuserProfileColumn(pool);

    await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .input('foto_profile', sql.NVarChar(500), fileUrl)
      .query(`
        UPDATE muser
        SET foto_profile = @foto_profile
        WHERE userid = @userid
      `);

    return res.json({
      success: true,
      message: 'Foto profile berhasil diperbarui',
      foto_profile: fileUrl,
    });
  } catch (error) {
    console.error('UPLOAD FOTO PROFILE ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal upload foto profile',
      error: error.message,
    });
  }
});

module.exports = router;
