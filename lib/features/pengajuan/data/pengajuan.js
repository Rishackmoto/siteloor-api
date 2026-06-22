const express = require('express');
const router = express.Router();

const multer = require('multer');
const path = require('path');
const sql = require('mssql');

const { getPool } = require('../../../core/network/db');
const { uploadToB2, getB2Object, getSignedB2Url } = require('../../../core/storage/backblaze');

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

function requestBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${protocol}://${req.get('host')}`;
}

async function ensureMuserProfileColumn(pool) {
  await pool.request().query(`
    IF COL_LENGTH('dbo.muser', 'foto_profile') IS NULL
    BEGIN
      ALTER TABLE dbo.muser ADD foto_profile NVARCHAR(500) NULL
    END
  `);
}

async function getTableColumns(pool, tableName) {
  const result = await pool.request()
    .input('tableName', sql.NVarChar(128), tableName)
    .query(`
      SELECT name
      FROM sys.columns
      WHERE object_id = OBJECT_ID(@tableName)
    `);

  return new Set(result.recordset.map((column) => String(column.name).toLowerCase()));
}

function selectColumn(columns, columnName, fallbackExpression) {
  return columns.has(columnName.toLowerCase())
    ? columnName
    : `${fallbackExpression} AS ${columnName}`;
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
    const muserColumns = await getTableColumns(pool, 'dbo.muser');
    const activeUserFilter = muserColumns.has('flag')
      ? "AND ISNULL(flag, '1') = '1'"
      : '';

    const result = await pool.request()
      .input('userid', sql.VarChar(30), String(userid).trim())
      .query(`
        SELECT TOP 1
          ${selectColumn(muserColumns, 'noref', 'CAST(NULL AS VARCHAR(30))')},
          userid,
          ${selectColumn(muserColumns, 'username', 'userid')},
          pass,
          ${selectColumn(muserColumns, 'levelid', 'CAST(NULL AS VARCHAR(10))')},
          ${selectColumn(muserColumns, 'flag', 'CAST(NULL AS VARCHAR(1))')},
          ${selectColumn(muserColumns, 'email', 'CAST(NULL AS VARCHAR(100))')},
          ${selectColumn(muserColumns, 'nohp', 'CAST(NULL AS VARCHAR(30))')},
          ${selectColumn(muserColumns, 'jabat', 'CAST(NULL AS VARCHAR(10))')},
          ${selectColumn(muserColumns, 'kdcab', 'CAST(NULL AS VARCHAR(30))')},
          foto_profile
        FROM muser
        WHERE userid = @userid
          ${activeUserFilter}
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
    const key = `siteloor/profile/${userid}/${filename}`;

    await uploadToB2({
      key,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
    });

    const pool = await getPool();
    await ensureMuserProfileColumn(pool);

    await pool.request()
      .input('userid', sql.VarChar(30), userid)
      .input('foto_profile', sql.NVarChar(500), key)
      .query(`
        UPDATE muser
        SET foto_profile = @foto_profile
        WHERE userid = @userid
      `);

    return res.json({
      success: true,
      message: 'Foto profile berhasil diperbarui',
      foto_profile: key,
      foto_profile_url: `${requestBaseUrl(req)}/api/files/view?key=${encodeURIComponent(key)}`,
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

router.get('/api/files/signed-url', async (req, res) => {
  try {
    const { key } = req.query;

    if (!key) {
      return res.status(400).json({
        success: false,
        message: 'Key file kosong',
      });
    }

    const signedUrl = await getSignedB2Url(key, 300);

    return res.json({
      success: true,
      url: signedUrl,
    });
  } catch (error) {
    console.error('B2 SIGNED URL ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal membuat signed URL',
      error: error.message,
    });
  }
});

router.get('/api/files/view', async (req, res) => {
  try {
    const { key } = req.query;

    if (!key) {
      return res.status(400).json({
        success: false,
        message: 'Key file kosong',
      });
    }

    const { result } = await getB2Object(key);

    if (result.ContentType) {
      res.setHeader('Content-Type', result.ContentType);
    }

    res.setHeader('Cache-Control', 'private, max-age=300');
    result.Body.pipe(res);
  } catch (error) {
    console.error('B2 VIEW FILE ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal membuka file',
      error: error.message,
    });
  }
});

router.get('/api/dashboard/stok-telur-kecil', async (req, res) => {
  try {
    const { tgl1, tgl2 } = req.query;

    if (!tgl1 || !tgl2) {
      return res.status(400).json({
        success: false,
        message: 'tgl1 dan tgl2 wajib diisi',
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2)
      .input('jns', sql.VarChar, '13')
      .query(`
        WITH kalender AS (
          SELECT CAST(@tgl1 AS date) AS tgl
          UNION ALL
          SELECT DATEADD(day, 1, tgl)
          FROM kalender
          WHERE tgl < CAST(@tgl2 AS date)
        ),
        telur_masuk AS (
          SELECT 
            CAST(tgl AS date) AS tgl,
            SUM(ISNULL(kecil, 0)) AS masuk
          FROM transaksi_telur
          WHERE tgl BETWEEN @tgl1 AND @tgl2
          GROUP BY CAST(tgl AS date)
        ),
        telur_total AS (
          SELECT 
            CAST(tgl AS date) AS tgl,
            SUM(ISNULL(kecil, 0)) AS total
          FROM transaksi_telur
          WHERE tgl <= @tgl2
          GROUP BY CAST(tgl AS date)
        ),
        telur_keluar AS (
          SELECT 
            CAST(tgl AS date) AS tgl,
            SUM(ISNULL(jmlh, 0)) * 30 AS total
          FROM transaksi_jual
          WHERE flag = 'JTL'
            AND jns = @jns
            AND tgl BETWEEN @tgl1 AND @tgl2
          GROUP BY CAST(tgl AS date)
        )
        SELECT
          k.tgl,

          ISNULL(tm.masuk, 0) AS btr_masuk,
          ROUND(ISNULL(tm.masuk, 0) / 30.0, 0) AS rak_masuk,

          ISNULL(tk.total, 0) AS btr_keluar,
          ROUND(ISNULL(tk.total, 0) / 30.0, 2) AS rak_keluar,

         (
  SELECT SUM(ISNULL(tt.total, 0))
  FROM telur_total tt
  WHERE tt.tgl <= k.tgl
)
-
ISNULL((
  SELECT SUM(ISNULL(j.jmlh, 0)) * 30
  FROM transaksi_jual j
  WHERE j.flag = 'JTL'
    AND j.jns = @jns
    AND CAST(j.tgl AS date) <= k.tgl
), 0) AS btr_saldo

         ROUND(
  (
    (
      SELECT SUM(ISNULL(tt.total, 0))
      FROM telur_total tt
      WHERE tt.tgl <= k.tgl
    )
    -
    ISNULL((
      SELECT SUM(ISNULL(j.jmlh, 0)) * 30
      FROM transaksi_jual j
      WHERE j.flag = 'JTL'
        AND j.jns = @jns
        AND CAST(j.tgl AS date) <= k.tgl
    ), 0)
  ) / 30.0,
  2
) AS rak_saldo

        FROM kalender k
        LEFT JOIN telur_masuk tm ON tm.tgl = k.tgl
        LEFT JOIN telur_keluar tk ON tk.tgl = k.tgl
        ORDER BY k.tgl
        OPTION (MAXRECURSION 0);
      `);

    res.json({
      success: true,
      title: 'TELUR KECIL',
      jns: '13',
      data: result.recordset,
    });
  } catch (err) {
    console.error('DASHBOARD STOK TELUR KECIL ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal memuat stok telur kecil',
      error: err.message,
    });
  }
});

router.get('/api/dashboard/stok-telur', async (req, res) => {
  try {
    const { jenis = 'kecil', tgl1, tgl2 } = req.query;

    if (!tgl1 || !tgl2) {
      return res.status(400).json({
        success: false,
        message: 'tgl1 dan tgl2 wajib diisi',
      });
    }

    const config = jenisMap[String(jenis).trim().toLowerCase()];

    if (!config) {
      return res.status(400).json({
        success: false,
        message: 'Jenis telur tidak valid',
        allowed: Object.keys(jenisMap),
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2)
      .input('jns', sql.VarChar, config.kode)
      .query(`
        WITH kalender AS (
          SELECT CAST(@tgl1 AS date) AS tgl
          UNION ALL
          SELECT DATEADD(day, 1, tgl)
          FROM kalender
          WHERE tgl < CAST(@tgl2 AS date)
        ),
        telur_masuk AS (
          SELECT 
            CAST(tgl AS date) AS tgl,
            SUM(ISNULL(${config.kolom}, 0)) AS masuk
          FROM transaksi_telur
          WHERE tgl BETWEEN @tgl1 AND @tgl2
          GROUP BY CAST(tgl AS date)
        ),
        telur_total AS (
          SELECT 
            CAST(tgl AS date) AS tgl,
            SUM(ISNULL(${config.kolom}, 0)) AS total
          FROM transaksi_telur
          WHERE tgl <= @tgl2
          GROUP BY CAST(tgl AS date)
        ),
        telur_keluar AS (
          SELECT 
            CAST(tgl AS date) AS tgl,
            SUM(ISNULL(jmlh, 0)) * 30 AS total   -- dalam butir
          FROM transaksi_jual
          WHERE flag = 'JTL'
            AND jns = @jns
            AND tgl BETWEEN @tgl1 AND @tgl2
          GROUP BY CAST(tgl AS date)
        ),
        opening_outgoing AS (
          SELECT ISNULL(SUM(ISNULL(jmlh, 0) * 30), 0) AS total
          FROM transaksi_jual
          WHERE flag = 'JTL'
            AND jns = @jns
            AND tgl < @tgl1
        ),
        -- 🔥 total masuk dan keluar dari AWAL sampai tgl2 (akumulasi)
        total_masuk AS (
          SELECT ISNULL(SUM(ISNULL(${config.kolom}, 0)), 0) AS total
          FROM transaksi_telur
          WHERE tgl <= @tgl2
        ),
        total_keluar AS (
          SELECT ISNULL(SUM(ISNULL(jmlh, 0) * 30), 0) AS total
          FROM transaksi_jual
          WHERE flag = 'JTL'
            AND jns = @jns
            AND tgl <= @tgl2
        )
        SELECT
          k.tgl,
          ISNULL(tm.masuk, 0) AS btr_masuk,
          ROUND(ISNULL(tm.masuk, 0) / 30.0, 0) AS rak_masuk,

          ISNULL(tk.total, 0) AS btr_keluar,
          ROUND(ISNULL(tk.total, 0) / 30.0, 2) AS rak_keluar,

          -- Saldo dalam butir (akurat)
          (
            SELECT SUM(ISNULL(tt.total, 0))
            FROM telur_total tt
            WHERE tt.tgl <= k.tgl
          )
          -
          (
            (SELECT total FROM opening_outgoing)
            +
            SUM(ISNULL(tk.total, 0)) OVER (
              ORDER BY k.tgl
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          ) AS btr_saldo,

          ROUND(
            (
              (
                SELECT SUM(ISNULL(tt.total, 0))
                FROM telur_total tt
                WHERE tt.tgl <= k.tgl
              )
              -
              (
                (SELECT total FROM opening_outgoing)
                +
                SUM(ISNULL(tk.total, 0)) OVER (
                  ORDER BY k.tgl
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                )
              )
            ) / 30.0,
            2
          ) AS rak_saldo,

          -- Total akumulasi dari awal sampai tgl2 (sama untuk semua baris)
          (SELECT total FROM total_masuk) AS total_masuk_btr,
          ROUND((SELECT total FROM total_masuk) / 30.0, 2) AS total_masuk_rak,
          (SELECT total FROM total_keluar) AS total_keluar_btr,
          ROUND((SELECT total FROM total_keluar) / 30.0, 2) AS total_keluar_rak

        FROM kalender k
        LEFT JOIN telur_masuk tm ON tm.tgl = k.tgl
        LEFT JOIN telur_keluar tk ON tk.tgl = k.tgl
        ORDER BY k.tgl
        OPTION (MAXRECURSION 0);
      `);

    const records = result.recordset;
    let totalMasukBtr = 0, totalMasukRak = 0;
    let totalKeluarBtr = 0, totalKeluarRak = 0;
    let saldoAkhirBtr = 0, saldoAkhirRak = 0;

    if (records.length > 0) {
      const first = records[0];
      totalMasukBtr = first.total_masuk_btr || 0;
      totalMasukRak = first.total_masuk_rak || 0;
      totalKeluarBtr = first.total_keluar_btr || 0;
      totalKeluarRak = first.total_keluar_rak || 0;

      const last = records[records.length - 1];
      saldoAkhirBtr = last.btr_saldo || 0;
      saldoAkhirRak = last.rak_saldo || 0;
    }

    res.json({
      success: true,
      title: config.title,
      jenis,
      jns: config.kode,
      kolom: config.kolom,
      data: records,               // data harian untuk grafik
      total: {
        masuk: {
          butir: totalMasukBtr,
          rak: totalMasukRak
        },
        keluar: {
          butir: totalKeluarBtr,
          rak: totalKeluarRak
        },
        saldo: {
          butir: saldoAkhirBtr,
          rak: saldoAkhirRak
        }
      }
    });
  } catch (err) {
    console.error('DASHBOARD STOK TELUR ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal memuat stok telur',
      error: err.message,
    });
  }
});
const jenisMap = {
  besar: { kode: '11', kolom: 'besar', title: 'TELUR BESAR' },
  sedang: { kode: '12', kolom: 'sedang', title: 'TELUR SEDANG' },
  kecil: { kode: '13', kolom: 'kecil', title: 'TELUR KECIL' },
  retak: { kode: '14', kolom: 'retak', title: 'TELUR RETAK' },
  kecil_sekali: { kode: '15', kolom: 'sekali', title: 'TELUR KECIL SEKALI' },
  sangat_kecil: { kode: '16', kolom: 'ssekali', title: 'TELUR SANGAT KECIL' },
};

router.get('/api/dashboard/summary', async (req, res) => {
  try {
    const { tgl } = req.query;
    const pool = await getPool();

    const result = await pool.request()
      .input('tgl', sql.Date, tgl || new Date())
      .query(`
        SELECT
          ISNULL((SELECT SUM(ISNULL(besar,0)) FROM transaksi_telur WHERE tgl <= @tgl),0)
          - ISNULL((SELECT SUM(ISNULL(jmlh,0)) * 30 FROM transaksi_jual WHERE flag='JTL' AND jns='11' AND tgl <= @tgl),0) AS telur_besar,

          ISNULL((SELECT SUM(ISNULL(sedang,0)) FROM transaksi_telur WHERE tgl <= @tgl),0)
          - ISNULL((SELECT SUM(ISNULL(jmlh,0)) * 30 FROM transaksi_jual WHERE flag='JTL' AND jns='12' AND tgl <= @tgl),0) AS telur_sedang,

          ISNULL((SELECT SUM(ISNULL(kecil,0)) FROM transaksi_telur WHERE tgl <= @tgl),0)
          - ISNULL((SELECT SUM(ISNULL(jmlh,0)) * 30 FROM transaksi_jual WHERE flag='JTL' AND jns='13' AND tgl <= @tgl),0) AS telur_kecil,

          ISNULL((SELECT SUM(ISNULL(retak,0)) FROM transaksi_telur WHERE tgl <= @tgl),0)
          - ISNULL((SELECT SUM(ISNULL(jmlh,0)) * 30 FROM transaksi_jual WHERE flag='JTL' AND jns='14' AND tgl <= @tgl),0) AS telur_retak,

          ISNULL((SELECT SUM(ISNULL(sekali,0)) FROM transaksi_telur WHERE tgl <= @tgl),0)
          - ISNULL((SELECT SUM(ISNULL(jmlh,0)) * 30 FROM transaksi_jual WHERE flag='JTL' AND jns='15' AND tgl <= @tgl),0) AS telur_kecil_sekali,

          ISNULL((SELECT SUM(ISNULL(ssekali,0)) FROM transaksi_telur WHERE tgl <= @tgl),0)
          - ISNULL((SELECT SUM(ISNULL(jmlh,0)) * 30 FROM transaksi_jual WHERE flag='JTL' AND jns='16' AND tgl <= @tgl),0) AS telur_sangat_kecil
      `);

    res.json({
      success: true,
      tgl: tgl || new Date(),
      data: result.recordset[0] || {},
    });
  } catch (err) {
    console.error('DASHBOARD SUMMARY ERROR:', err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.get('/api/master/kandang', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        nm,
        nm AS nama,
        nm AS nama_kandang
      FROM kandang
      ORDER BY nm
    `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.post('/api/pengambilan-telur/simpan', async (req, res) => {
  const {
    noref,
    nm,
    tgl,
    besar = 0,
    sedang = 0,
    kecil = 0,
    retak = 0,
    sekali = 0,
    ssekali = 0,
    ket = '',
    userid,
  } = req.body;

  if (!nm) {
    return res.status(400).json({ message: 'Kandang harus dipilih' });
  }

  if (!tgl) {
    return res.status(400).json({ message: 'Tentukan Tanggal' });
  }

  const pool = await getPool();
  const trx = new sql.Transaction(pool);

  try {
    await trx.begin();

    const requestDelete = new sql.Request(trx);
    await requestDelete
      .input('noref', sql.VarChar, noref)
      .query(`
        DELETE FROM transaksi_telur
        WHERE noref = @noref
      `);

    const requestInsert = new sql.Request(trx);
    await requestInsert
      .input('noref', sql.VarChar, noref)
      .input('nm', sql.VarChar, nm)
      .input('tgl', sql.Date, tgl)
      .input('besar', sql.Decimal(18, 2), besar || 0)
      .input('sedang', sql.Decimal(18, 2), sedang || 0)
      .input('kecil', sql.Decimal(18, 2), kecil || 0)
      .input('retak', sql.Decimal(18, 2), retak || 0)
      .input('sekali', sql.Decimal(18, 2), sekali || 0)
      .input('ssekali', sql.Decimal(18, 2), ssekali || 0)
      .input('ket', sql.VarChar, ket)
      .input('userid', sql.VarChar, userid)
      .query(`
        INSERT INTO transaksi_telur
        (
          noref, nm, tgl,
          besar, sedang, kecil, retak,
          sekali, ket, userid, dupd, ssekali
        )
        VALUES
        (
          @noref, @nm, @tgl,
          @besar, @sedang, @kecil, @retak,
          @sekali, @ket, @userid, GETDATE(), @ssekali
        )
      `);

    await trx.commit();

    res.json({ success: true, message: 'Transaksi berhasil disimpan' });
  } catch (err) {
    await trx.rollback();
    console.error('SIMPAN PENGAMBILAN TELUR ERROR:', err);
    res.status(500).json({ message: 'Gagal simpan transaksi' });
  }
});

router.get('/api/pengambilan-telur/noref', async (req, res) => {
  try {
    const now = new Date();

    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');

    const noref = `TL${yy}${mm}${dd}${hh}${mi}`;

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, noref });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Gagal generate noref telur',
      error: err.message,
    });
  }
});

router.delete('/api/pengambilan-telur/:noref', async (req, res) => {
  try {
    const pool = await getPool();

    await pool.request()
      .input('noref', sql.VarChar, req.params.noref)
      .query(`
        DELETE transaksi_telur
        WHERE noref = @noref
      `);

    res.json({
      success: true,
      message: 'Data berhasil dihapus',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.get('/api/pengambilan-telur', async (req, res) => {
  try {
    const { tgl1, tgl2, kandang } = req.query;

    const pool = await getPool();

    let query = `
      SELECT 
        noref,
        nm,
        tgl,
        besar,
        sedang,
        kecil,
        retak,
        ket,
        sekali,
        ssekali
      FROM transaksi_telur
      WHERE tgl BETWEEN @tgl1 AND @tgl2
    `;

    if (kandang && kandang !== 'null' && kandang !== '') {
      query += ` AND nm = @kandang `;
    }

    query += ` ORDER BY tgl ASC `;

    const request = pool.request()
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2);

    if (kandang && kandang !== 'null' && kandang !== '') {
      request.input('kandang', sql.VarChar, kandang);
    }

    const result = await request.query(query);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error('GET PENGAMBILAN TELUR ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pengambilan telur',
      error: err.message,
    });
  }
});

router.get('/api/pengambilan-ayam', async (req, res) => {
  try {
    const { tgl1, tgl2, kandang } = req.query;

    const pool = await getPool();

    let query = `
      SELECT
        noref,
        nm,
        tgl,
        afkir,
        sakit,
        mati,
        ket
      FROM transaksi_ayam_end
      WHERE tgl BETWEEN @tgl1 AND @tgl2
    `;

    if (kandang && kandang !== 'null' && kandang !== '') {
      query += ` AND nm = @kandang `;
    }

    query += ` ORDER BY tgl ASC `;

    const request = pool.request()
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2);

    if (kandang && kandang !== 'null' && kandang !== '') {
      request.input('kandang', sql.VarChar, kandang);
    }

    const result = await request.query(query);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error('GET PENGAMBILAN AYAM ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pengambilan ayam',
      error: err.message,
    });
  }
});

router.delete('/api/pengambilan-ayam/:noref', async (req, res) => {
  try {
    const pool = await getPool();

    await pool.request()
      .input('noref', sql.VarChar, req.params.noref)
      .query(`
        DELETE FROM transaksi_ayam_end
        WHERE noref = @noref
      `);

    res.json({
      success: true,
      message: 'Data ayam berhasil dihapus',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.get('/api/pengambilan-ayam/noref', async (req, res) => {
  try {
    const now = new Date();

    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');

    const noref = `TA${yy}${mm}${dd}${hh}${mi}`;

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, noref });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Gagal generate noref ayam',
      error: err.message,
    });
  }
});

router.post('/api/pengambilan-ayam/simpan', async (req, res) => {
  const {
    noref,
    nm,
    tgl,
    afkir = 0,
    sakit = 0,
    mati = 0,
    ket = '',
    userid,
  } = req.body;

  if (!nm) {
    return res.status(400).json({
      success: false,
      message: 'Kandang harus dipilih',
    });
  }

  if (!tgl) {
    return res.status(400).json({
      success: false,
      message: 'Tentukan Tanggal',
    });
  }

  const pool = await getPool();
  const trx = new sql.Transaction(pool);

  try {
    await trx.begin();

    await new sql.Request(trx)
      .input('noref', sql.VarChar, noref)
      .query(`
        DELETE FROM transaksi_ayam_end
        WHERE noref = @noref
      `);

    await new sql.Request(trx)
      .input('noref', sql.VarChar, noref)
      .input('nm', sql.VarChar, nm)
      .input('tgl', sql.Date, tgl)
      .input('afkir', sql.Decimal(18, 2), afkir || 0)
      .input('sakit', sql.Decimal(18, 2), sakit || 0)
      .input('mati', sql.Decimal(18, 2), mati || 0)
      .input('ket', sql.VarChar, ket)
      .input('userid', sql.VarChar, userid)
      .query(`
        INSERT INTO transaksi_ayam_end
        (
          noref, nm, tgl,
          afkir, sakit, mati,
          ket, userid, dupd
        )
        VALUES
        (
          @noref, @nm, @tgl,
          @afkir, @sakit, @mati,
          @ket, @userid, GETDATE()
        )
      `);

    await trx.commit();

    res.json({
      success: true,
      message: 'Transaksi berhasil disimpan',
    });
  } catch (err) {
    await trx.rollback();

    res.status(500).json({
      success: false,
      message: 'Gagal simpan transaksi ayam',
      error: err.message,
    });
  }
});

router.get('/master/pelanggan', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT pelanggan.nm
      FROM pelanggan
      ORDER BY pelanggan.nm
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/master/jenis-sales', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT jenissales.kode, jenissales.jenis
      FROM jenissales
      ORDER BY jenissales.jenis
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/penjualan-ayam/noref', async (req, res) => {
  try {
    const pool = await getPool();

    const prefix = 'RISWJAY';
    const result = await pool.request().query(`
      SELECT TOP 1 noref
      FROM transaksi_jual
      WHERE noref LIKE '${prefix}%'
      ORDER BY noref DESC
    `);

    let next = 1;

    if (result.recordset.length > 0) {
      const last = result.recordset[0].noref || '';
      const angka = parseInt(last.replace(prefix, ''), 10);
      if (!isNaN(angka)) next = angka + 1;
    }

    const noref = prefix + String(next).padStart(6, '0');

    res.json({ success: true, noref });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/api/penjualan-ayam/noref', async (req, res) => {
  try {
    const pool = await getPool();
    const prefix = 'RISWJAY';

    const result = await pool.request().query(`
      SELECT TOP 1 noref
      FROM jual
      WHERE noref LIKE '${prefix}%'
      ORDER BY noref DESC
    `);

    let next = 1;
    if (result.recordset.length > 0) {
      const last = result.recordset[0].noref || '';
      const angka = parseInt(last.replace(prefix, ''), 10);
      if (!isNaN(angka)) next = angka + 1;
    }

    res.json({
      success: true,
      noref: prefix + String(next).padStart(6, '0'),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/api/master/pelanggan', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT nm
      FROM pelanggan
      ORDER BY nm
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/api/master/jenis-sales', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT kode, jenis
      FROM jenissales
      ORDER BY jenis
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/api/penjualan/:jenis/noref', async (req, res) => {
  try {
    const jenis = String(req.params.jenis || '').trim().toLowerCase();
    const userid = String(req.query.userid || 'USER').trim().toUpperCase();

    const userPrefix = userid.replace(/[^A-Z0-9]/g, '').substring(0, 4).padEnd(4, 'X');

    const kodeMap = {
      ayam: 'JAY',
      telur: 'JTL',
      pakan: 'JPL',
      pakan_limbah: 'JPL',
      lain: 'JLL',
      lain_lain: 'JLL',
      obat: 'JOB',
    };

    const kode = kodeMap[jenis];

    if (!kode) {
      return res.status(400).json({
        success: false,
        message: 'Jenis penjualan tidak valid',
      });
    }

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');

    const noref = `${userPrefix}${kode}${yy}${mm}${dd}${hh}${mi}`;

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, noref });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Gagal generate noref penjualan',
      error: err.message,
    });
  }
});

router.get('/api/penjualan/ayam/list-stok', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        t.noref,
        t.jns,
        t.nm,
        t.jmlh AS qty_awal,
        t.nou,
        ISNULL(SUM(ta.qty), 0) AS qty_terjual,
        t.jmlh - ISNULL(SUM(ta.qty), 0) AS jmlh
      FROM transaksi t
      LEFT JOIN transaksi_ayam ta
        ON ta.norefayam = t.noref
       AND ta.nou = t.nou
      WHERE t.flag = 'PAY'
      GROUP BY
        t.noref, t.jns, t.nm, t.jmlh, t.nou
      HAVING t.jmlh - ISNULL(SUM(ta.qty), 0) > 0
      ORDER BY t.nm
    `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error('LIST STOK AYAM ERROR:', err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

router.get('/api/dashboard/produksi-penjualan', async (req, res) => {
  try {
    const bulan = parseInt(req.query.bulan || '6', 10);
    const totalBulan = Number.isNaN(bulan) ? 6 : Math.min(Math.max(bulan, 1), 24);

    const pool = await getPool();

    const result = await pool.request()
      .input('bulan', sql.Int, totalBulan)
      .query(`
        WITH bulan_list AS (
          SELECT
            DATEFROMPARTS(YEAR(DATEADD(MONTH, -(@bulan - 1), GETDATE())), MONTH(DATEADD(MONTH, -(@bulan - 1), GETDATE())), 1) AS awal_bulan
          UNION ALL
          SELECT DATEADD(MONTH, 1, awal_bulan)
          FROM bulan_list
          WHERE awal_bulan < DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
        ),
        produksi AS (
          SELECT
            DATEFROMPARTS(YEAR(tgl), MONTH(tgl), 1) AS awal_bulan,
            SUM(
              ISNULL(besar, 0) +
              ISNULL(sedang, 0) +
              ISNULL(kecil, 0) +
              ISNULL(retak, 0) +
              ISNULL(sekali, 0) +
              ISNULL(ssekali, 0)
            ) AS produksi
          FROM transaksi_telur
          WHERE tgl >= DATEADD(MONTH, -(@bulan - 1), DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
          GROUP BY DATEFROMPARTS(YEAR(tgl), MONTH(tgl), 1)
        ),
        penjualan AS (
          SELECT
            DATEFROMPARTS(YEAR(tgl), MONTH(tgl), 1) AS awal_bulan,
            SUM(ISNULL(jmlh, 0) * 30) AS penjualan
          FROM transaksi_jual
          WHERE flag = 'JTL'
            AND tgl >= DATEADD(MONTH, -(@bulan - 1), DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
          GROUP BY DATEFROMPARTS(YEAR(tgl), MONTH(tgl), 1)
        )
        SELECT
          FORMAT(b.awal_bulan, 'MMM yyyy', 'id-ID') AS bulan,
          b.awal_bulan,
          ISNULL(p.produksi, 0) AS produksi,
          ISNULL(j.penjualan, 0) AS penjualan
        FROM bulan_list b
        LEFT JOIN produksi p ON p.awal_bulan = b.awal_bulan
        LEFT JOIN penjualan j ON j.awal_bulan = b.awal_bulan
        ORDER BY b.awal_bulan
        OPTION (MAXRECURSION 0);
      `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error('DASHBOARD PRODUKSI PENJUALAN ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal memuat grafik produksi dan penjualan',
      error: err.message,
    });
  }
});

router.put('/users/:userid/theme-mode', async (req, res) => {
  try {
    const { userid } = req.params;
    const { theme_mode } = req.body;

    const mode = theme_mode === 'dark' ? 'dark' : 'light';

    const pool = await getPool();

    await pool.request()
      .input('userid', sql.VarChar, userid)
      .input('theme_mode', sql.VarChar, mode)
      .query(`
        UPDATE MUSER
        SET theme_mode = @theme_mode
        WHERE userid = @userid
      `);

    res.json({
      success: true,
      message: 'Theme mode berhasil diperbarui',
      theme_mode: mode,
    });
  } catch (err) {
    console.error('UPDATE THEME MODE ERROR:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal update theme mode',
      error: err.message,
    });
  }
});
module.exports = router;
