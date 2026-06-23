const express = require('express');
const router = express.Router();
console.log('✅ LAPORAN ROUTE LOADED');
const { getPool, sql } = require('../../../core/network/db');

/*
  KARTU STOK TELUR
  PowerBuilder lama:
  - masuk telur kecil dari transaksi_telur.kecil
  - keluar telur dari transaksi_jual.jmlh * 30
  - jns = 11 untuk telur kecil
  - saldo akhir = total masuk s/d tanggal - total keluar s/d tanggal

  Endpoint:
  GET /api/laporan/kartu-stok-telur?jenis=13&tgl1=2026-06-01&tgl2=2026-06-30

  jenis:
  11 = besar
  12 = sedang
  13 = kecil
  14 = retak
  15 = sekali
  16 = ssekali

  Catatan:
  Silakan sesuaikan mapping kolom masuk di JENIS_TELUR_MAP
  kalau nama kolom database moto berbeda.
*/

const JENIS_TELUR_MAP = {
  '11': {
    kode: '11',
    nama: 'TELUR BESAR',
    kolomMasuk: 'besar',
  },
  '12': {
    kode: '12',
    nama: 'TELUR SEDANG',
    kolomMasuk: 'sedang',
  },
  '13': {
    kode: '13',
    nama: 'TELUR KECIL',
    kolomMasuk: 'kecil',
  },
  '14': {
    kode: '14',
    nama: 'TELUR RETAK',
    kolomMasuk: 'retak',
  },
  '15': {
    kode: '15',
    nama: 'TELUR KECIL SEKALI',
    kolomMasuk: 'sekali',
  },
  '16': {
    kode: '16',
    nama: 'TELUR SANGAT KECIL',
    kolomMasuk: 'ssekali',
  },
};

function isValidDate(value) {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function round2(value) {
  const number = Number(value || 0);
  return Math.round(number * 100) / 100;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Route laporan hidup',
  });
});
router.get('/kartu-stok-telur', async (req, res) => {
  try {
    const jenis = (req.query.jenis || '11').toString().trim();
    const tgl1 = (req.query.tgl1 || '').toString().trim();
    const tgl2 = (req.query.tgl2 || '').toString().trim();

    if (!isValidDate(tgl1) || !isValidDate(tgl2)) {
      return res.status(400).json({
        success: false,
        message: 'Parameter tgl1 dan tgl2 wajib format YYYY-MM-DD',
      });
    }

    const jenisInfo = JENIS_TELUR_MAP[jenis];
    if (!jenisInfo) {
      return res.status(400).json({
        success: false,
        message: 'Jenis telur tidak valid',
      });
    }

    /*
      Kolom tidak boleh langsung dari input user.
      Kolom hanya diambil dari whitelist JENIS_TELUR_MAP.
    */
    const kolomMasuk = jenisInfo.kolomMasuk;

    const pool = await getPool();

    const query = `
      ;WITH tanggal AS (
        SELECT CAST(@tgl1 AS date) AS tgl
        UNION ALL
        SELECT DATEADD(day, 1, tgl)
        FROM tanggal
        WHERE tgl < CAST(@tgl2 AS date)
      ),
      masuk_harian AS (
        SELECT
          CAST(tgl AS date) AS tgl,
          ISNULL(SUM(ISNULL(${kolomMasuk}, 0)), 0) AS masuk
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY CAST(tgl AS date)
      ),
      keluar_harian AS (
        SELECT
          CAST(tgl AS date) AS tgl,
          ISNULL(SUM(ISNULL(jmlh, 0)) * 30, 0) AS keluar
        FROM transaksi_jual
        WHERE flag = 'JTL'
          AND CONVERT(varchar(20), jns) = @jenis
          AND CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY CAST(tgl AS date)
      ),
      masuk_sd AS (
        SELECT
          t.tgl,
          ISNULL((
            SELECT SUM(ISNULL(tt.${kolomMasuk}, 0))
            FROM transaksi_telur tt
            WHERE CAST(tt.tgl AS date) <= t.tgl
          ), 0) AS total_masuk_sd
        FROM tanggal t
      ),
      keluar_sd AS (
        SELECT
          t.tgl,
          ISNULL((
            SELECT SUM(ISNULL(tj.jmlh, 0)) * 30
            FROM transaksi_jual tj
            WHERE tj.flag = 'JTL'
              AND CONVERT(varchar(20), tj.jns) = @jenis
              AND CAST(tj.tgl AS date) <= t.tgl
          ), 0) AS total_keluar_sd
        FROM tanggal t
      )
      SELECT
        CONVERT(varchar(10), t.tgl, 23) AS tgl,
        ISNULL(m.masuk, 0) AS btr_masuk,
        ROUND(ISNULL(m.masuk, 0) / 30.0, 2) AS rak_masuk,
        ISNULL(k.keluar, 0) AS btr_keluar,
        ROUND(ISNULL(k.keluar, 0) / 30.0, 2) AS rak_keluar,
        ISNULL(ms.total_masuk_sd, 0) - ISNULL(ks.total_keluar_sd, 0) AS btr_akhir,
        ROUND((ISNULL(ms.total_masuk_sd, 0) - ISNULL(ks.total_keluar_sd, 0)) / 30.0, 2) AS rak_akhir
      FROM tanggal t
      LEFT JOIN masuk_harian m ON m.tgl = t.tgl
      LEFT JOIN keluar_harian k ON k.tgl = t.tgl
      LEFT JOIN masuk_sd ms ON ms.tgl = t.tgl
      LEFT JOIN keluar_sd ks ON ks.tgl = t.tgl
      ORDER BY t.tgl
      OPTION (MAXRECURSION 32767);
    `;

    const result = await pool
      .request()
      .input('jenis', sql.VarChar(20), jenis)
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2)
      .query(query);

    const rows = result.recordset.map((row, index) => ({
      no: index + 1,
      tgl: row.tgl,
      btr_masuk: safeNumber(row.btr_masuk),
      rak_masuk: round2(row.rak_masuk),
      btr_keluar: safeNumber(row.btr_keluar),
      rak_keluar: round2(row.rak_keluar),
      btr_akhir: safeNumber(row.btr_akhir),
      rak_akhir: round2(row.rak_akhir),
    }));

    const totalMasuk = rows.reduce((sum, row) => sum + safeNumber(row.btr_masuk), 0);
    const totalKeluar = rows.reduce((sum, row) => sum + safeNumber(row.btr_keluar), 0);
    const saldoAkhir = rows.length ? safeNumber(rows[rows.length - 1].btr_akhir) : 0;

    return res.json({
      success: true,
      message: 'Data kartu stok telur berhasil dimuat',
      jenis: jenisInfo,
      periode: {
        tgl1,
        tgl2,
      },
      summary: {
        total_masuk_butir: totalMasuk,
        total_masuk_rak: round2(totalMasuk / 30),
        total_keluar_butir: totalKeluar,
        total_keluar_rak: round2(totalKeluar / 30),
        saldo_akhir_butir: saldoAkhir,
        saldo_akhir_rak: round2(saldoAkhir / 30),
      },
      data: rows,
    });
  } catch (error) {
    console.error('KARTU STOK TELUR ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat kartu stok telur',
      error: error.message,
    });
  }
});

router.get('/produksi-telur', async (req, res) => {
  try {
    const tgl1 = (req.query.tgl1 || '').toString().trim();
    const tgl2 = (req.query.tgl2 || '').toString().trim();

    if (!isValidDate(tgl1) || !isValidDate(tgl2)) {
      return res.status(400).json({
        success: false,
        message: 'Parameter tgl1 dan tgl2 wajib format YYYY-MM-DD',
      });
    }

    const pool = await getPool();

    const query = `
      ;WITH produksi AS (
        SELECT EOMONTH(tgl) AS tgl, 'BESAR' AS jenis, SUM(ISNULL(besar, 0)) AS produksi
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl)

        UNION ALL
        SELECT EOMONTH(tgl), 'SEDANG', SUM(ISNULL(sedang, 0))
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl)

        UNION ALL
        SELECT EOMONTH(tgl), 'KECIL', SUM(ISNULL(kecil, 0))
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl)

        UNION ALL
        SELECT EOMONTH(tgl), 'RETAK', SUM(ISNULL(retak, 0))
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl)

        UNION ALL
        SELECT EOMONTH(tgl), 'SEKALI', SUM(ISNULL(sekali, 0))
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl)

        UNION ALL
        SELECT EOMONTH(tgl), 'SSEKALI', SUM(ISNULL(ssekali, 0))
        FROM transaksi_telur
        WHERE CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl)
      ),
      penjualan AS (
        SELECT
          EOMONTH(tgl) AS tgl,
          CASE CONVERT(varchar(20), jns)
            WHEN '11' THEN 'BESAR'
            WHEN '12' THEN 'SEDANG'
            WHEN '13' THEN 'KECIL'
            WHEN '14' THEN 'RETAK'
            WHEN '15' THEN 'SEKALI'
            WHEN '16' THEN 'SSEKALI'
          END AS jenis,
          SUM(ISNULL(jmlh, 0)) * 30 AS penjualan,
          SUM(ISNULL(total, 0)) AS pendapatan
        FROM transaksi_jual
        WHERE flag = 'JTL'
          AND CAST(tgl AS date) BETWEEN CAST(@tgl1 AS date) AND CAST(@tgl2 AS date)
        GROUP BY EOMONTH(tgl), CONVERT(varchar(20), jns)
      )
      SELECT
        CONVERT(varchar(10), p.tgl, 23) AS tgl,
        p.jenis,
        ISNULL(p.produksi, 0) AS produksi,
        ISNULL(j.penjualan, 0) AS penjualan,
        ISNULL(j.pendapatan, 0) AS pendapatan,
        ISNULL(p.produksi, 0) - ISNULL(j.penjualan, 0) AS sisa_butir,
        ROUND((ISNULL(p.produksi, 0) - ISNULL(j.penjualan, 0)) / 30.0, 0) AS sisa_rak
      FROM produksi p
      LEFT JOIN penjualan j
        ON p.tgl = j.tgl
       AND p.jenis = j.jenis
      ORDER BY p.tgl, p.jenis;
    `;

    const result = await pool
      .request()
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2)
      .query(query);

    const rows = result.recordset.map((row, index) => ({
      no: index + 1,
      tgl: row.tgl,
      jenis: row.jenis,
      produksi: safeNumber(row.produksi),
      penjualan: safeNumber(row.penjualan),
      pendapatan: safeNumber(row.pendapatan),
      sisa_butir: safeNumber(row.sisa_butir),
      sisa_rak: safeNumber(row.sisa_rak),
    }));

    const totalProduksi = rows.reduce((s, r) => s + r.produksi, 0);
    const totalPenjualan = rows.reduce((s, r) => s + r.penjualan, 0);
    const totalPendapatan = rows.reduce((s, r) => s + r.pendapatan, 0);
    const totalSisa = rows.reduce((s, r) => s + r.sisa_butir, 0);

    return res.json({
      success: true,
      message: 'Data produksi telur berhasil dimuat',
      periode: { tgl1, tgl2 },
      summary: {
        total_produksi: totalProduksi,
        total_penjualan: totalPenjualan,
        total_pendapatan: totalPendapatan,
        total_sisa_butir: totalSisa,
        total_sisa_rak: round2(totalSisa / 30),
      },
      data: rows,
    });
  } catch (error) {
    console.error('PRODUKSI TELUR ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memuat produksi telur',
      error: error.message,
    });
  }
});

router.get('/rekap-penjualan-telur', async (req, res) => {
  try {
    const { tgl1, tgl2 } = req.query;

    const pool = await getPool();

    const result = await pool.request()
      .input('tgl1', sql.Date, tgl1)
      .input('tgl2', sql.Date, tgl2)
      .query(`
       SELECT 
  ISNULL(SUM(total), 0) AS nominal,
  ISNULL(SUM(jmlh), 0) AS jmlh,
  CASE LTRIM(RTRIM(CAST(jns AS VARCHAR(20))))
    WHEN '11' THEN 'TELUR BESAR'
    WHEN '12' THEN 'TELUR SEDANG'
    WHEN '13' THEN 'TELUR KECIL'
    WHEN '14' THEN 'TELUR RETAK'
    WHEN '15' THEN 'TELUR SEKALI'
    WHEN '16' THEN 'TELUR SSEKALI'
    ELSE ISNULL(CAST(jns AS VARCHAR(20)), '')
  END AS jns,
  ISNULL(nm, '') AS satuan,
  ISNULL(SUM(jmlh), 0) * 30 AS butir
FROM transaksi_jual
WHERE flag = 'JTL'
  AND tgl >= @tgl1
  AND tgl < DATEADD(day, 1, @tgl2)
GROUP BY jns, nm
ORDER BY jns ASC
      `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (err) {
    console.error('REKAP PENJUALAN TELUR ERROR:', err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;
