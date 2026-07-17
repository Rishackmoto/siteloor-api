const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../../core/network/db');

const router = express.Router();
const clean = (value) => String(value ?? '').trim();
const toInt = (value) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

router.get('/options/provinsi', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT prov_id, prov_name
      FROM provinces
      WHERE ISNULL(status, 1) = 1
      ORDER BY prov_name ASC
    `);
    return res.json({ success: true, data: result.recordset, total: result.recordset.length });
  } catch (error) {
    console.error('GET SUPPLIER PROVINSI ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengambil data provinsi', error: error.message });
  }
});

router.get('/options/kota', async (req, res) => {
  try {
    const provId = toInt(req.query.prov_id);
    if (provId === null) return res.status(400).json({ success: false, message: 'Provinsi harus dipilih' });
    const pool = await getPool();
    const result = await pool.request().input('prov_id', sql.Int, provId).query(`
      SELECT city_id, city_name, prov_id
      FROM cities
      WHERE prov_id = @prov_id
      ORDER BY city_name ASC
    `);
    return res.json({ success: true, data: result.recordset, total: result.recordset.length });
  } catch (error) {
    console.error('GET SUPPLIER KOTA ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengambil data kota', error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const cari = clean(req.query.cari);
    const pool = await getPool();
    const result = await pool.request().input('cari', sql.VarChar(200), `%${cari}%`).query(`
      SELECT s.nm, s.ad1, s.jns, s.kontak, s.email, s.prov, s.kota,
             p.prov_name, c.city_name
      FROM supplier s
      LEFT JOIN provinces p ON p.prov_id = s.prov
      LEFT JOIN cities c ON c.city_id = s.kota
      WHERE ISNULL(s.nm, '') LIKE @cari
         OR ISNULL(s.ad1, '') LIKE @cari
         OR ISNULL(s.jns, '') LIKE @cari
         OR ISNULL(s.kontak, '') LIKE @cari
         OR ISNULL(s.email, '') LIKE @cari
         OR ISNULL(p.prov_name, '') LIKE @cari
         OR ISNULL(c.city_name, '') LIKE @cari
      ORDER BY s.nm ASC
    `);
    return res.json({ success: true, data: result.recordset, total: result.recordset.length });
  } catch (error) {
    console.error('GET SUPPLIER ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengambil data supplier', error: error.message });
  }
});

router.get('/detail', async (req, res) => {
  try {
    const nm = clean(req.query.nm);
    if (!nm) return res.status(400).json({ success: false, message: 'Nama supplier wajib diisi' });
    const pool = await getPool();
    const result = await pool.request().input('nm', sql.VarChar(200), nm).query(`
      SELECT TOP 1 s.nm, s.ad1, s.jns, s.kontak, s.email, s.prov, s.kota,
             p.prov_name, c.city_name
      FROM supplier s
      LEFT JOIN provinces p ON p.prov_id = s.prov
      LEFT JOIN cities c ON c.city_id = s.kota
      WHERE s.nm = @nm
    `);
    if (!result.recordset.length) return res.status(404).json({ success: false, message: 'Data supplier tidak ditemukan' });
    return res.json({ success: true, data: result.recordset[0] });
  } catch (error) {
    console.error('GET DETAIL SUPPLIER ERROR:', error);
    return res.status(500).json({ success: false, message: 'Gagal mengambil detail supplier', error: error.message });
  }
});

router.post('/', async (req, res) => saveSupplier(req, res, false));
router.put('/', async (req, res) => saveSupplier(req, res, true));

async function saveSupplier(req, res, isEdit) {
  try {
    const oldNm = clean(req.body.old_nm);
    const nm = clean(req.body.nm);
    const ad1 = clean(req.body.ad1);
    const jns = clean(req.body.jns);
    const prov = toInt(req.body.prov);
    const kota = toInt(req.body.kota);
    const kontak = clean(req.body.kontak);
    const email = clean(req.body.email);

    if (isEdit && !oldNm) return res.status(400).json({ success: false, message: 'Nama supplier lama tidak ditemukan' });
    if (!nm) return res.status(400).json({ success: false, message: 'Nama supplier harus diisi' });
    if (!ad1) return res.status(400).json({ success: false, message: 'Alamat harus diisi' });
    if (!jns) return res.status(400).json({ success: false, message: 'Jenis supplier harus diisi' });
    if (prov === null) return res.status(400).json({ success: false, message: 'Provinsi harus dipilih' });
    if (kota === null) return res.status(400).json({ success: false, message: 'Kota harus dipilih' });

    const pool = await getPool();
    const duplicate = await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .input('old_nm', sql.VarChar(200), oldNm || '')
      .query(`
        SELECT TOP 1 nm FROM supplier
        WHERE UPPER(LTRIM(RTRIM(nm))) = UPPER(LTRIM(RTRIM(@nm)))
          AND (@old_nm = '' OR UPPER(LTRIM(RTRIM(nm))) <> UPPER(LTRIM(RTRIM(@old_nm))))
      `);
    if (duplicate.recordset.length) return res.status(409).json({ success: false, message: 'Supplier sudah terdaftar' });

    if (isEdit) {
      const result = await pool.request()
        .input('old_nm', sql.VarChar(200), oldNm)
        .input('nm', sql.VarChar(200), nm)
        .input('ad1', sql.VarChar(500), ad1)
        .input('jns', sql.VarChar(100), jns)
        .input('prov', sql.Int, prov)
        .input('kota', sql.Int, kota)
        .input('kontak', sql.VarChar(100), kontak || null)
        .input('email', sql.VarChar(200), email || null)
        .query(`
          UPDATE supplier SET nm=@nm, ad1=@ad1, jns=@jns, prov=@prov, kota=@kota,
                              kontak=@kontak, email=@email
          WHERE nm=@old_nm
        `);
      if (!result.rowsAffected[0]) return res.status(404).json({ success: false, message: 'Data supplier tidak ditemukan' });
      return res.json({ success: true, message: 'Data supplier berhasil diperbarui' });
    }

    await pool.request()
      .input('nm', sql.VarChar(200), nm)
      .input('ad1', sql.VarChar(500), ad1)
      .input('jns', sql.VarChar(100), jns)
      .input('prov', sql.Int, prov)
      .input('kota', sql.Int, kota)
      .input('kontak', sql.VarChar(100), kontak || null)
      .input('email', sql.VarChar(200), email || null)
      .query(`
        INSERT INTO supplier(nm,ad1,jns,prov,kota,kontak,email)
        VALUES(@nm,@ad1,@jns,@prov,@kota,@kontak,@email)
      `);
    return res.status(201).json({ success: true, message: 'Data supplier berhasil disimpan' });
  } catch (error) {
    console.error(isEdit ? 'PUT SUPPLIER ERROR:' : 'POST SUPPLIER ERROR:', error);
    return res.status(500).json({ success: false, message: isEdit ? 'Gagal memperbarui supplier' : 'Gagal menyimpan supplier', error: error.message });
  }
}

router.delete('/', async (req, res) => {
  try {
    const nm = clean(req.query.nm);
    if (!nm) return res.status(400).json({ success: false, message: 'Nama supplier wajib diisi' });
    const pool = await getPool();
    const result = await pool.request().input('nm', sql.VarChar(200), nm).query(`DELETE FROM supplier WHERE nm=@nm`);
    if (!result.rowsAffected[0]) return res.status(404).json({ success: false, message: 'Data supplier tidak ditemukan' });
    return res.json({ success: true, message: 'Data supplier berhasil dihapus' });
  } catch (error) {
    console.error('DELETE SUPPLIER ERROR:', error);
    if (error.number === 547) return res.status(409).json({ success: false, message: 'Supplier tidak dapat dihapus karena sudah digunakan pada transaksi' });
    return res.status(500).json({ success: false, message: 'Gagal menghapus supplier', error: error.message });
  }
});

module.exports = router;
