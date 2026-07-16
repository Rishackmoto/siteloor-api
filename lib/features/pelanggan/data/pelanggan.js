const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../../core/network/db');

const router = express.Router();

/**
 * GET /api/pelanggan?cari=
 * Menampilkan daftar pelanggan yang sudah ada.
 */
router.get('/', async (req, res) => {
  try {
    const cari = String(req.query.cari || '').trim();
    const pool = await getPool();

    const result = await pool.request()
      .input('cari', sql.VarChar(200), `%${cari}%`)
      .query(`
        SELECT
          nm,
          ad1,
          kontak,
          email,
          prov,
          kota
        FROM pelanggan
        WHERE
          ISNULL(nm, '') LIKE @cari
          OR ISNULL(ad1, '') LIKE @cari
          OR ISNULL(kontak, '') LIKE @cari
          OR ISNULL(email, '') LIKE @cari
        ORDER BY nm ASC
      `);

    return res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
    });
  } catch (error) {
    console.error('GET PELANGGAN ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pelanggan',
      error: error.message,
    });
  }
});

/**
 * GET /api/pelanggan/detail?nm=
 * Pengganti proses PowerBuilder:
 * SELECT nm, ad1, kontak, email, prov, kota
 * FROM pelanggan WHERE nm = :noref
 */
router.get('/detail', async (req, res) => {
  try {
    const nm = String(req.query.nm || '').trim();

    if (!nm) {
      return res.status(400).json({
        success: false,
        message: 'Nama pelanggan wajib diisi',
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .query(`
        SELECT TOP 1
          nm,
          ad1,
          kontak,
          email,
          prov,
          kota
        FROM pelanggan
        WHERE nm = @nm
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Data pelanggan tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      data: result.recordset[0],
    });
  } catch (error) {
    console.error('GET DETAIL PELANGGAN ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil detail pelanggan',
      error: error.message,
    });
  }
});

module.exports = router;
