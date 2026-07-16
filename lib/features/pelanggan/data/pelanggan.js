const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../../core/network/db');

const router = express.Router();

const clean = (value) => String(value ?? '').trim();

/**
 * GET /api/pelanggan?cari=
 * Menampilkan daftar pelanggan yang sudah ada.
 */
router.get('/', async (req, res) => {
  try {
    const cari = clean(req.query.cari);
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
    const nm = clean(req.query.nm);

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

/**
 * POST /api/pelanggan
 * Menambahkan pelanggan baru setelah memeriksa nama yang sama.
 */
router.post('/', async (req, res) => {
  try {
    const nm = clean(req.body.nm);
    const ad1 = clean(req.body.ad1);
    const prov = Number(req.body.prov);
    const kota = Number(req.body.kota);
    const kontak = clean(req.body.kontak);
    const email = clean(req.body.email);

    if (!nm) {
      return res.status(400).json({ success: false, message: 'Nama pelanggan harus diisi' });
    }
    if (!ad1) {
      return res.status(400).json({ success: false, message: 'Alamat harus diisi' });
    }
    if (!Number.isFinite(prov)) {
      return res.status(400).json({ success: false, message: 'Provinsi harus dipilih' });
    }
    if (!Number.isFinite(kota)) {
      return res.status(400).json({ success: false, message: 'Kota harus dipilih' });
    }

    const pool = await getPool();

    const duplicate = await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .query(`
        SELECT TOP 1 nm
        FROM pelanggan
        WHERE UPPER(LTRIM(RTRIM(nm))) = UPPER(LTRIM(RTRIM(@nm)))
      `);

    if (duplicate.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Pelanggan sudah terdaftar',
      });
    }

    await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .input('ad1', sql.VarChar(500), ad1)
      .input('prov', sql.Int, prov)
      .input('kota', sql.Int, kota)
      .input('kontak', sql.VarChar(100), kontak || null)
      .input('email', sql.VarChar(200), email || null)
      .query(`
        INSERT INTO pelanggan(nm, ad1, prov, kota, kontak, email)
        VALUES(@nm, @ad1, @prov, @kota, @kontak, @email)
      `);

    return res.status(201).json({
      success: true,
      message: 'Data pelanggan berhasil disimpan',
    });
  } catch (error) {
    console.error('POST PELANGGAN ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal menyimpan data pelanggan',
      error: error.message,
    });
  }
});

module.exports = router;
