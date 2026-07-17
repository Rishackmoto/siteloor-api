const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../../core/network/db');

const router = express.Router();

const clean = (value) => String(value ?? '').trim();

const toInt = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * ============================================================
 * GET MASTER PROVINSI
 * GET /api/pelanggan/options/provinsi
 * ============================================================
 */
router.get('/options/provinsi', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        prov_id,
        prov_name
      FROM provinces
      WHERE ISNULL(status, 1) = 1
      ORDER BY prov_name ASC
    `);

    return res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
    });
  } catch (error) {
    console.error('GET PROVINSI ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data provinsi',
      error: error.message,
    });
  }
});

/**
 * ============================================================
 * GET MASTER KOTA
 * GET /api/pelanggan/options/kota
 * GET /api/pelanggan/options/kota?prov_id=91
 * ============================================================
 */
router.get('/options/kota', async (req, res) => {
  try {
    const provId = toInt(req.query.prov_id);

    if (provId === null) {
      return res.status(400).json({
        success: false,
        message: 'Provinsi harus dipilih',
      });
    }

    const pool = await getPool();

    const result = await pool.request()
      .input('prov_id', sql.Int, provId)
      .query(`
        SELECT
          city_id,
          city_name,
          prov_id
        FROM cities
        WHERE prov_id = @prov_id
        ORDER BY city_name ASC
      `);

    return res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
    });
  } catch (error) {
    console.error('GET KOTA ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil data kota',
      error: error.message,
    });
  }
});

/**
 * ============================================================
 * GET DAFTAR PELANGGAN
 * GET /api/pelanggan
 * GET /api/pelanggan?cari=
 * ============================================================
 */
router.get('/', async (req, res) => {
  try {
    const cari = clean(req.query.cari);
    const pool = await getPool();

    const result = await pool.request()
      .input('cari', sql.VarChar(200), `%${cari}%`)
      .query(`
        SELECT
          p.nm,
          p.ad1,
          p.kontak,
          p.email,
          p.prov,
          p.kota,
          pr.prov_name,
          ct.city_name
        FROM pelanggan p

        LEFT JOIN provinces pr
          ON pr.prov_id = p.prov

        LEFT JOIN cities ct
          ON ct.city_id = p.kota

        WHERE
          ISNULL(p.nm, '') LIKE @cari
          OR ISNULL(p.ad1, '') LIKE @cari
          OR ISNULL(p.kontak, '') LIKE @cari
          OR ISNULL(p.email, '') LIKE @cari
          OR ISNULL(pr.prov_name, '') LIKE @cari
          OR ISNULL(ct.city_name, '') LIKE @cari

        ORDER BY p.nm ASC
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
 * ============================================================
 * GET DETAIL PELANGGAN
 * GET /api/pelanggan/detail?nm=
 * ============================================================
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
          p.nm,
          p.ad1,
          p.kontak,
          p.email,
          p.prov,
          p.kota,
          pr.prov_name,
          ct.city_name
        FROM pelanggan p

        LEFT JOIN provinces pr
          ON pr.prov_id = p.prov

        LEFT JOIN cities ct
          ON ct.city_id = p.kota

        WHERE p.nm = @nm
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
 * ============================================================
 * POST TAMBAH PELANGGAN
 * POST /api/pelanggan
 * ============================================================
 */
router.post('/', async (req, res) => {
  try {
    const nm = clean(req.body.nm);
    const ad1 = clean(req.body.ad1);
    const prov = toInt(req.body.prov);
    const kota = toInt(req.body.kota);
    const kontak = clean(req.body.kontak);
    const email = clean(req.body.email);

    if (!nm) {
      return res.status(400).json({
        success: false,
        message: 'Nama pelanggan harus diisi',
      });
    }

    if (!ad1) {
      return res.status(400).json({
        success: false,
        message: 'Alamat harus diisi',
      });
    }

    if (prov === null) {
      return res.status(400).json({
        success: false,
        message: 'Provinsi harus dipilih',
      });
    }

    if (kota === null) {
      return res.status(400).json({
        success: false,
        message: 'Kota harus dipilih',
      });
    }

    const pool = await getPool();

    /*
     * Cek nama pelanggan yang sama.
     */
    const duplicate = await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .query(`
        SELECT TOP 1
          nm
        FROM pelanggan
        WHERE
          UPPER(LTRIM(RTRIM(nm))) =
          UPPER(LTRIM(RTRIM(@nm)))
      `);

    if (duplicate.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Pelanggan sudah terdaftar',
      });
    }

    /*
     * Pastikan provinsi tersedia di tabel provinces.
     */
    const provinsiExists = await pool.request()
      .input('prov', sql.Int, prov)
      .query(`
        SELECT TOP 1
          prov_id,
          prov_name
        FROM provinces
        WHERE prov_id = @prov
      `);

    if (provinsiExists.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provinsi tidak ditemukan',
      });
    }

    /*
     * Pastikan kota tersedia dan sesuai provinsi.
     *
     * Diasumsikan tabel cities mempunyai kolom prov_id.
     */
    const kotaExists = await pool.request()
      .input('kota', sql.Int, kota)
      .input('prov', sql.Int, prov)
      .query(`
        SELECT TOP 1
          city_id,
          city_name
        FROM cities
        WHERE city_id = @kota
          AND prov_id = @prov
      `);

    if (kotaExists.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Kota tidak sesuai dengan provinsi yang dipilih',
      });
    }

    /*
     * Simpan pelanggan baru.
     */
    await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .input('ad1', sql.VarChar(500), ad1)
      .input('prov', sql.Int, prov)
      .input('kota', sql.Int, kota)
      .input('kontak', sql.VarChar(100), kontak || null)
      .input('email', sql.VarChar(200), email || null)
      .query(`
        INSERT INTO pelanggan (
          nm,
          ad1,
          prov,
          kota,
          kontak,
          email
        )
        VALUES (
          @nm,
          @ad1,
          @prov,
          @kota,
          @kontak,
          @email
        )
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

/**
 * ============================================================
 * PUT EDIT PELANGGAN
 * PUT /api/pelanggan
 * ============================================================
 */
router.put('/', async (req, res) => {
  try {
    const oldNm = clean(req.body.old_nm);
    const nm = clean(req.body.nm);
    const ad1 = clean(req.body.ad1);
    const prov = toInt(req.body.prov);
    const kota = toInt(req.body.kota);
    const kontak = clean(req.body.kontak);
    const email = clean(req.body.email);

    if (!oldNm) {
      return res.status(400).json({
        success: false,
        message: 'Nama pelanggan lama tidak ditemukan',
      });
    }

    if (!nm) {
      return res.status(400).json({
        success: false,
        message: 'Nama pelanggan harus diisi',
      });
    }

    if (!ad1) {
      return res.status(400).json({
        success: false,
        message: 'Alamat pelanggan harus diisi',
      });
    }

    if (prov === null) {
      return res.status(400).json({
        success: false,
        message: 'Provinsi harus dipilih',
      });
    }

    if (kota === null) {
      return res.status(400).json({
        success: false,
        message: 'Kota harus dipilih',
      });
    }

    const pool = await getPool();

    /*
     * Periksa nama baru agar tidak sama dengan pelanggan lain.
     */
    const duplicate = await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .input('old_nm', sql.VarChar(200), oldNm)
      .query(`
        SELECT TOP 1
          nm
        FROM pelanggan
        WHERE
          UPPER(LTRIM(RTRIM(nm))) =
          UPPER(LTRIM(RTRIM(@nm)))
          AND UPPER(LTRIM(RTRIM(nm))) <>
              UPPER(LTRIM(RTRIM(@old_nm)))
      `);

    if (duplicate.recordset.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Nama pelanggan sudah digunakan',
      });
    }

    /*
     * Periksa provinsi.
     */
    const provinsiExists = await pool.request()
      .input('prov', sql.Int, prov)
      .query(`
        SELECT TOP 1
          prov_id
        FROM provinces
        WHERE prov_id = @prov
      `);

    if (provinsiExists.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provinsi tidak ditemukan',
      });
    }

    /*
     * Periksa kota dan kecocokannya dengan provinsi.
     */
    const kotaExists = await pool.request()
      .input('kota', sql.Int, kota)
      .input('prov', sql.Int, prov)
      .query(`
        SELECT TOP 1
          city_id
        FROM cities
        WHERE city_id = @kota
          AND prov_id = @prov
      `);

    if (kotaExists.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Kota tidak sesuai dengan provinsi yang dipilih',
      });
    }

    const result = await pool.request()
      .input('old_nm', sql.VarChar(200), oldNm)
      .input('nm', sql.VarChar(200), nm)
      .input('ad1', sql.VarChar(500), ad1)
      .input('prov', sql.Int, prov)
      .input('kota', sql.Int, kota)
      .input('kontak', sql.VarChar(100), kontak || null)
      .input('email', sql.VarChar(200), email || null)
      .query(`
        UPDATE pelanggan
        SET
          nm = @nm,
          ad1 = @ad1,
          prov = @prov,
          kota = @kota,
          kontak = @kontak,
          email = @email
        WHERE nm = @old_nm
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({
        success: false,
        message: 'Data pelanggan tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Data pelanggan berhasil diperbarui',
    });
  } catch (error) {
    console.error('PUT PELANGGAN ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal memperbarui data pelanggan',
      error: error.message,
    });
  }
});

/**
 * ============================================================
 * DELETE PELANGGAN
 * DELETE /api/pelanggan?nm=
 * ============================================================
 */
router.delete('/', async (req, res) => {
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
        DELETE FROM pelanggan
        WHERE nm = @nm
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({
        success: false,
        message: 'Data pelanggan tidak ditemukan',
      });
    }

    return res.json({
      success: true,
      message: 'Data pelanggan berhasil dihapus',
    });
  } catch (error) {
    console.error('DELETE PELANGGAN ERROR:', error);

    /*
     * SQL Server error 547 berarti data masih digunakan
     * oleh tabel transaksi yang mempunyai foreign key.
     */
    if (error.number === 547) {
      return res.status(409).json({
        success: false,
        message:
            'Pelanggan tidak dapat dihapus karena sudah digunakan pada transaksi',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Gagal menghapus data pelanggan',
      error: error.message,
    });
  }
});

module.exports = router;