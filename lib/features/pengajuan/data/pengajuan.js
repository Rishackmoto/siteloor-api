const express = require('express');
const router = express.Router();
const fs = require('fs/promises');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const bcaParser = require('../parsers/bcaParser');
const mandiriParser = require('../parsers/mandiriParser');
const briParser = require('../parsers/briParser');
const bniParser = require('../parsers/bniParser');
const bpdPapuaParser = require('../parsers/bpdPapuaParser');
const { sql, getPool, getDbTarget, isDbLoginError } = require('../../../core/network/db');
const { uploadToB2, deleteManyFromB2, deletePrefixFromB2, getB2Object } = require('../../../core/storage/backblaze');
const {
    sendWhatsAppNotification,
    sendWhatsAppTemplate,
} = require('../../../core/notification/whatsapp');
const { createWorker } = require('tesseract.js');
const { getSignedB2Url } = require("../../../core/storage/backblaze");

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.pdf']);
const wilayahBaseUrl = 'https://wilayah.id/api';
const wilayahCache = new Map();

async function fetchWilayahJson(pathname) {
    const cached = wilayahCache.get(pathname);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    const response = await fetch(`${wilayahBaseUrl}/${pathname}`);
    if (!response.ok) {
        throw new Error(`Wilayah API HTTP ${response.status}`);
    }

    const data = await response.json();
    wilayahCache.set(pathname, {
        data,
        expiresAt: now + 24 * 60 * 60 * 1000,
    });
    return data;
}

function hashPassword(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function levelName(levelid) {
    return ({
        '1': 'Operator',
        '2': 'Supervisor',
        '3': 'Signer',
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

const workflowNotificationTargets = {
    '1': {
        jabatanCodes: ['13'],
        menu: 'Verifikasi Pengajuan',
        action: 'melakukan verifikasi pengajuan',
    },
    '2': {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'FPK Pengajuan',
        action: 'melengkapi FPK pengajuan',
    },
    '3': {
        jabatanCodes: ['13'],
        menu: 'Checklist Kelengkapan',
        action: 'melakukan checklist kelengkapan dokumen',
    },
    '4': {
        jabatanCodes: ['13', '14'],
        menu: 'Rekap dan Analisa',
        action: 'melakukan rekap dan analisa kredit',
    },
    '5': {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'Survey Debitur',
        action: 'melakukan survey debitur',
    },
    '6': {
        jabatanCodes: ['12'],
        targetAo: true,
        menu: 'Survey Agunan',
        action: 'melakukan survey agunan',
    },
    '7': {
        jabatanCodes: ['15'],
        menu: 'MUK',
        action: 'melakukan review MUK',
    },
    '8': {
        jabatanCodes: ['15', '17'],
        menu: 'MUK',
        action: 'menindaklanjuti MUK',
    },
};

const deleteNotificationTarget = {
    jabatanCodes: ['13', '15'],
    targetAo: true,
    menu: 'Pengajuan',
    action: 'mengetahui pengajuan yang dihapus',
};

function parseAuditPayload(req) {
    const body = req.body || {};
    if (body.payload) {
        try {
            return { ...body, payload: JSON.parse(body.payload) };
        } catch (_) {
            return body;
        }
    }
    return body;
}

function formatRupiah(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return '-';
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0,
    }).format(number);
}

function totalUsahaBersihSurvey(usahaItems = [], pemilikTarget = '') {
    const target = String(pemilikTarget || '').toLowerCase();

    return (usahaItems || [])
        .filter((item) => {
            const pemilik = String(
                item.pemilik ||
                item.usaha_milik ||
                item.jenis_pemilik ||
                item.jenis ||
                ''
            ).toLowerCase();

            return pemilik.includes(target);
        })
        .reduce((sum, item) => {
            const laba = nullableNumber(
                item.keuntungan_laba ??
                item.keuntunganLaba ??
                item.laba ??
                item.laba_usaha ??
                item.laba_bersih ??
                item.keuntungan ??
                item.laba_kotor ??
                item.gross_profit ??
                item.profit
            ) || 0;

            const biayaRaw =
                item.biaya_operasional ??
                item.biayaOperasional ??
                item.biaya_operasional_perbulan;

            let biaya = 0;

            if (Array.isArray(biayaRaw)) {
                biaya = biayaRaw.reduce((s, row) => {
                    return s + (nullableNumber(row.harga ?? row.nominal) || 0);
                }, 0);
            } else {
                biaya = nullableNumber(biayaRaw) || 0;
            }

            let pendapatanUsaha = laba;
            if (pendapatanUsaha === 0) {
                const pendapatan = nullableNumber(item.pendapatan_perbulan) || 0;
                const hpp = nullableNumber(item.hpp_rupiah) || 0;
                pendapatanUsaha = pendapatan - hpp;
            }

            return sum + Math.max(0, pendapatanUsaha - biaya);
        }, 0);
}


function pickDebiturName(body = {}) {
    if (body.jenis_debitur === 'BADAN_USAHA') {
        return body.data_badan_usaha?.nama_perusahaan || '-';
    }
    return body.data_perorangan?.nama_debitur || '-';
}

async function getPengajuanNotificationSummary(pool, idPengajuan, fallback = {}) {
    const id = idPengajuan || fallback.id_pengajuan;
    if (!id) return { ...fallback };

    const result = await pool.request()
        .input('id_pengajuan', sql.VarChar, id)
        .query(`
            SELECT TOP 1
                   a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan,
                   a.tenor_bulan, a.status_pengajuan, a.id_ao, a.stsflag,
                   b.nama_debitur, c.nama_perusahaan
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.id_pengajuan = @id_pengajuan
        `);

    return {
        ...fallback,
        ...(result.recordset[0] || {}),
        id_pengajuan: id,
    };
}

async function getActiveNotificationUsers(pool, target = {}, summary = {}) {
    const codes = (target.jabatanCodes || [])
        .map((code) => code.toString().replace(/\D/g, ''))
        .filter(Boolean);
    const aoUserid = target.targetAo ? summary.id_ao?.toString().trim() : '';
    if (!codes.length && !aoUserid) return [];

    const request = pool.request();
    const conditions = [];

    if (codes.length) {
        conditions.push(`jabat IN (${codes.map((code) => `'${code}'`).join(', ')})`);
    }
    if (aoUserid) {
        request.input('ao_userid', sql.VarChar, aoUserid);
        conditions.push('userid = @ao_userid');
    }

    const result = await request.query(`
        SELECT userid, username, nohp, jabat, kdcab
        FROM muser
        WHERE ISNULL(flag, '1') = '1'
          AND nohp IS NOT NULL
          AND LTRIM(RTRIM(nohp)) <> ''
          AND (${conditions.join(' OR ')})
    `);

    const byPhone = new Map();
    for (const user of result.recordset || []) {
        const phone = user.nohp?.toString().replace(/\D/g, '');
        if (!phone) continue;
        byPhone.set(phone, user);
    }
    return [...byPhone.values()];
}

function getDebiturName(summary = {}) {
    return summary.nama_debitur || summary.nama_perusahaan || pickDebiturName(summary);
}

function buildWorkflowNotificationMessage({ summary, target, event, previousStsflag, catatan }) {
    const eventText = {
        save: `Pengajuan sudah disimpan dan menunggu ${target.action}.`,
        koreksi: `Pengajuan dikoreksi dari status ${previousStsflag || '-'} dan dikembalikan untuk ${target.action}.`,
        delete: 'Pengajuan telah dihapus dari sistem.',
        muk: 'MUK pengajuan telah disimpan dan siap ditindaklanjuti.',
    }[event] || `Pengajuan menunggu ${target.action}.`;

    const lines = [
        '*HONAI - Pengajuan Kredit*',
        '',
        eventText,
        '',
        `ID Pengajuan: ${summary.id_pengajuan || '-'}`,
        `Debitur: ${getDebiturName(summary)}`,
        `Jenis Debitur: ${summary.jenis_debitur || '-'}`,
        `Plafon: ${formatRupiah(summary.plafon_pengajuan)}`,
        `Tenor: ${summary.tenor_bulan || '-'} bulan`,
        `AO: ${summary.id_ao || '-'}`,
    ];

    if (catatan) {
        lines.push('', `Catatan: ${catatan}`);
    }

    if (event !== 'delete') {
        lines.push('', `Silakan buka menu ${target.menu}.`);
    }

    return lines.join('\n');
}

async function notifyWorkflowUsers(pool, {
    idPengajuan,
    fallback = {},
    targetStsflag,
    targetOverride,
    event = 'save',
    previousStsflag = null,
    catatan = null,
}) {
    const target = targetOverride || workflowNotificationTargets[String(targetStsflag || '')];
    if (!target) {
        return { skipped: true, reason: `Tidak ada target notifikasi untuk stsflag ${targetStsflag}` };
    }

    const summary = await getPengajuanNotificationSummary(pool, idPengajuan || fallback.id_pengajuan, fallback);
    const recipients = await getActiveNotificationUsers(pool, target, summary);
    if (!recipients.length) {
        console.log(`[WA] skipped ${event} ${summary.id_pengajuan || '-'} -> ${target.menu}: no recipients`);
        return { skipped: true, reason: 'Tidak ada user penerima WA yang aktif/bernomor HP' };
    }

    console.log(`[WA] sending ${event} ${summary.id_pengajuan || '-'} -> ${target.menu} to ${recipients.length} user(s): ${recipients.map((user) => user.userid).join(', ')}`);
    const text = buildWorkflowNotificationMessage({
        summary,
        target,
        event,
        previousStsflag,
        catatan,
    });
    const results = [];
    for (const user of recipients) {
        try {
            const result = await sendWhatsAppNotification(user.nohp, text);
            results.push({ userid: user.userid, nohp: user.nohp, success: true, result });
        } catch (error) {
            console.error(`WA notification failed for ${user.userid}:`, error.message);
            results.push({ userid: user.userid, nohp: user.nohp, success: false, error: error.message });
        }
    }

    const summaryResult = {
        sent: results.filter((item) => item.success).length,
        failed: results.filter((item) => !item.success).length,
        recipients: results.length,
        results,
    };
    console.log(`[WA] result ${event} ${summary.id_pengajuan || '-'}: sent=${summaryResult.sent}, failed=${summaryResult.failed}`);
    return summaryResult;
}

async function notifyWorkflowUsersSafe(pool, options) {
    try {
        return await notifyWorkflowUsers(pool, options);
    } catch (notificationError) {
        console.error('WA notification error:', notificationError.message);
        return {
            failed: true,
            error: notificationError.message,
        };
    }
}

function sanitizeAuditValue(value) {
    if (Array.isArray(value)) {
        return value.map(sanitizeAuditValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => {
                const normalizedKey = key.toLowerCase();
                if (
                    normalizedKey.includes('pass') ||
                    normalizedKey.includes('password') ||
                    normalizedKey.includes('token')
                ) {
                    return [key, '[FILTERED]'];
                }
                return [key, sanitizeAuditValue(item)];
            })
        );
    }
    return value;
}

function pickAuditActor(req, payload) {
    const source = payload?.payload && typeof payload.payload === 'object'
        ? { ...payload, ...payload.payload }
        : payload || {};

    return {
        userid:
            req.get('x-userid') ||
            source.userid ||
            source.id_user ||
            source.id_ao ||
            source.user_id ||
            null,
        username: req.get('x-username') || source.username || source.nama_user || null,
    };
}

function pickAuditPengajuanId(req, payload) {
    const source = payload?.payload && typeof payload.payload === 'object'
        ? { ...payload, ...payload.payload }
        : payload || {};

    if (source.id_pengajuan) return source.id_pengajuan;

    const match = req.originalUrl.match(
        /\/api\/pengajuan\/(?:verifikasi\/|slik\/)?([^/?]+)/
    );
    if (!match) return null;

    const value = decodeURIComponent(match[1]);
    if (
        [
            'baru',
            'list',
            'listVerifikasi',
            'listFpk',
            'listCheckKelengkapan',
            'listRekapAnalisa',
            'listSurveyDebitur',
            'listSurveyAgunan',
            'listMUK',
            'upload-ttd',
        ].includes(value)
    ) {
        return null;
    }
    return value;
}

function auditActionName(req) {
    const url = req.originalUrl.split('?')[0];
    const method = req.method.toUpperCase();

    if (url === '/api/login') return 'LOGIN';
    if (url === '/api/logout' || url === '/api/audit/logout') return 'LOGOUT';
    if (url === '/api/audit/cetak-laporan') return 'CETAK_LAPORAN';
    if (method === 'DELETE') return 'HAPUS';
    if (url.includes('/koreksi')) return 'KOREKSI';
    if (url.endsWith('/progress')) return 'UPDATE_STATUS';
    if (url === '/api/pengajuan/baru') return 'INPUT_PENGAJUAN';
    if (/\/api\/pengajuan\/verifikasi\//.test(url)) return 'VERIFIKASI_PENGAJUAN';
    if (url.endsWith('/kelengkapan')) return 'INPUT_KELENGKAPAN';
    if (url.endsWith('/survey-debitur')) return 'INPUT_SURVEY_DEBITUR';
    if (url.endsWith('/survey-agunan')) return 'INPUT_SURVEY_AGUNAN';
    if (url.endsWith('/rekap-analisa')) return 'INPUT_REKAP_ANALISA';
    if (/\/api\/pengajuan\/slik\//.test(url)) return 'INPUT_SLIK';
    if (url === '/api/pengajuan/upload-ttd') return 'UPLOAD_TTD';
    if (url === '/api/users' && method === 'POST') return 'TAMBAH_USER';
    if (/\/api\/users\/[^/]+\/password$/.test(url)) return 'UBAH_PASSWORD';
    if (/\/api\/users\/[^/]+$/.test(url) && method === 'PUT') return 'EDIT_USER';
    if (/\/api\/pengajuan\/[^/]+$/.test(url) && method === 'PUT') return 'EDIT_PENGAJUAN';
    return `${method}_${url.replace(/^\/api\//, '').replace(/[/-]/g, '_').toUpperCase()}`;
}

function auditNote(action, payload) {
    if (action === 'KOREKSI') return payload?.catatan_koreksi?.toString() || null;
    if (action === 'CETAK_LAPORAN') return payload?.keterangan?.toString() || null;
    return payload?.catatan?.toString() || payload?.message?.toString() || null;
}

async function ensureMuserPasswordColumn(pool) {
    await pool.request().query(`
    IF COL_LENGTH('dbo.muser', 'pass') IS NOT NULL
    BEGIN
      ALTER TABLE dbo.muser ALTER COLUMN pass VARCHAR(128) NULL
    END
  `);
}

async function ensureMuserProfileColumn(pool) {
    await pool.request().query(`
    IF COL_LENGTH('dbo.muser', 'foto_profile') IS NULL
    BEGIN
      ALTER TABLE dbo.muser ADD foto_profile NVARCHAR(500) NULL
    END
  `);
}

router.use(auditLogger);

router.post('/api/login', async (req, res) => {
    try {
        const { userid, pass } = req.body;

        if (!userid || !pass) {
            return res.status(400).json({
                success: false,
                message: 'User ID dan password wajib diisi',
            });
        }

        const pool = await getPool();
        await ensureMuserPasswordColumn(pool);
        await ensureMuserProfileColumn(pool);

        const result = await pool.request()
            .input('userid', sql.VarChar(30), userid)
            .query(`
        SELECT TOP 1
          noref,
          userid,
          username,
          levelid,
          flag,
          email,
          nohp,
          jabat,
          kdcab,
          foto_profile,
          pass
        FROM muser
        WHERE userid = @userid
          AND ISNULL(flag, '1') = '1'
      `);

        const user = result.recordset[0];
        const inputHash = hashPassword(pass);
        const storedPass = (user?.pass || '').toString().trim();
        const isValidPassword = storedPass === pass || storedPass === inputHash;

        if (!user || !isValidPassword) {
            return res.status(401).json({
                success: false,
                message: 'User ID atau password salah / user tidak aktif',
            });
        }

        if (storedPass === pass) {
            await pool.request()
                .input('userid', sql.VarChar(30), userid)
                .input('pass', sql.VarChar(128), inputHash)
                .query('UPDATE muser SET pass = @pass WHERE userid = @userid');
        }

        const { pass: _ignoredPass, ...safeUser } = user;
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
        console.error('LOGIN ERROR:', error);
        if (isDbLoginError(error)) {
            return res.status(503).json({
                success: false,
                message: `Login database gagal untuk ${getDbTarget()}. Periksa DB_USER, DB_PASSWORD, status login SQL Server, dan mode Mixed Authentication.`,
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server',
        });
    }
});

router.post('/api/audit/logout', async (req, res) => {
    res.json({ status: 'success', message: 'Logout tercatat' });
});

router.post('/api/audit/cetak-laporan', async (req, res) => {
    res.json({ status: 'success', message: 'Cetak laporan tercatat' });
});

router.get('/api/wilayah/provinces', async (req, res) => {
    try {
        const data = await fetchWilayahJson('provinces.json');
        res.json(data);
    } catch (error) {
        console.error('GET WILAYAH PROVINCES ERROR:', error);
        res.status(502).json({
            success: false,
            message: 'Gagal mengambil data provinsi',
            error: error.message,
        });
    }
});

router.get('/api/wilayah/regencies/:provinceCode', async (req, res) => {
    try {
        const data = await fetchWilayahJson(`regencies/${encodeURIComponent(req.params.provinceCode)}.json`);
        res.json(data);
    } catch (error) {
        console.error('GET WILAYAH REGENCIES ERROR:', error);
        res.status(502).json({
            success: false,
            message: 'Gagal mengambil data kabupaten/kota',
            error: error.message,
        });
    }
});

router.get('/api/wilayah/districts/:regencyCode', async (req, res) => {
    try {
        const data = await fetchWilayahJson(`districts/${encodeURIComponent(req.params.regencyCode)}.json`);
        res.json(data);
    } catch (error) {
        console.error('GET WILAYAH DISTRICTS ERROR:', error);
        res.status(502).json({
            success: false,
            message: 'Gagal mengambil data kecamatan',
            error: error.message,
        });
    }
});

router.get('/api/wilayah/villages/:districtCode', async (req, res) => {
    try {
        const data = await fetchWilayahJson(`villages/${encodeURIComponent(req.params.districtCode)}.json`);
        res.json(data);
    } catch (error) {
        console.error('GET WILAYAH VILLAGES ERROR:', error);
        res.status(502).json({
            success: false,
            message: 'Gagal mengambil data kelurahan',
            error: error.message,
        });
    }
});

router.get('/api/users', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureMuserPasswordColumn(pool);
        await ensureMuserProfileColumn(pool);
        const result = await pool.request().query(`
      SELECT noref, userid, username, levelid, flag, email, nohp, jabat, kdcab, foto_profile
      FROM muser
      ORDER BY userid
    `);
        res.json({
            success: true,
            data: result.recordset.map((user) => ({
                ...user,
                level_name: levelName(user.levelid),
                jabatan_name: jabatanName(user.jabat),
            })),
        });
    } catch (error) {
        console.error('GET USERS ERROR:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/api/master/produk', async (req, res) => {
    try {
        const pool = await getPool();
        const exists = await pool.request().query(`
      SELECT OBJECT_ID('dbo.t_produk', 'U') AS object_id
    `);
        if (!exists.recordset[0]?.object_id) {
            return res.json({ success: true, data: [] });
        }

        const result = await pool.request().query('SELECT * FROM t_produk ORDER BY 1');
        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('GET PRODUK ERROR:', error);
        res.status(500).json({ success: false, message: error.message, data: [] });
    }
});

router.get('/api/master/cabang/:kdcab', async (req, res) => {
    try {
        const pool = await getPool();
        const { kdcab } = req.params;
        const exists = await pool.request().query(`
      SELECT OBJECT_ID('dbo.subbranch', 'U') AS object_id
    `);
        if (!exists.recordset[0]?.object_id) {
            return res.json({ success: true, data: null });
        }

        const columns = await pool.request().query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'subbranch'
    `);
        const names = new Set(columns.recordset.map((item) => item.COLUMN_NAME.toLowerCase()));
        const codeColumn = names.has('kdcab') ? 'kdcab' : names.has('kd_cab') ? 'kd_cab' : null;
        const nameColumn = names.has('nm_cab') ? 'nm_cab' : names.has('nama_cabang') ? 'nama_cabang' : null;

        if (!codeColumn || !nameColumn) {
            return res.json({ success: true, data: null });
        }

        const result = await pool.request()
            .input('kdcab', sql.VarChar, kdcab)
            .query(`
        SELECT TOP 1 ${codeColumn} AS kdcab, ${nameColumn} AS nm_cab
        FROM subbranch
        WHERE ${codeColumn} = @kdcab
      `);

        res.json({ success: true, data: result.recordset[0] || null });
    } catch (error) {
        console.error('GET CABANG ERROR:', error);
        res.status(500).json({ success: false, message: error.message, data: null });
    }
});

router.post('/api/users', async (req, res) => {
    try {
        const {
            noref,
            userid,
            username,
            pass,
            levelid,
            flag,
            email,
            nohp,
            jabat,
            kdcab,
        } = req.body;

        if (!userid || !username || !pass) {
            return res.status(400).json({
                success: false,
                message: 'User ID, nama user, dan password wajib diisi',
            });
        }

        const pool = await getPool();
        await ensureMuserPasswordColumn(pool);
        await pool.request()
            .input('noref', sql.Char(2), noref || null)
            .input('userid', sql.VarChar(30), userid)
            .input('username', sql.VarChar(50), username)
            .input('pass', sql.VarChar(128), hashPassword(pass))
            .input('levelid', sql.VarChar(1), levelid || '1')
            .input('flag', sql.VarChar(1), flag || '1')
            .input('email', sql.VarChar(50), email || null)
            .input('nohp', sql.VarChar(50), nohp || null)
            .input('jabat', sql.Char(2), jabat || null)
            .input('kdcab', sql.Char(3), kdcab || null)
            .query(`
        INSERT INTO muser (noref, userid, username, pass, levelid, flag, email, nohp, jabat, kdcab)
        VALUES (@noref, @userid, @username, @pass, @levelid, @flag, @email, @nohp, @jabat, @kdcab)
      `);

        res.json({ success: true, message: 'User berhasil ditambahkan' });
    } catch (error) {
        console.error('CREATE USER ERROR:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/api/users/:userid', async (req, res) => {
    try {
        const { userid } = req.params;
        const { noref, username, levelid, flag, email, nohp, jabat, kdcab } = req.body;
        if (!username) {
            return res.status(400).json({ success: false, message: 'Nama user wajib diisi' });
        }

        const pool = await getPool();
        await pool.request()
            .input('noref', sql.Char(2), noref || null)
            .input('userid', sql.VarChar(30), userid)
            .input('username', sql.VarChar(50), username)
            .input('levelid', sql.VarChar(1), levelid || '1')
            .input('flag', sql.VarChar(1), flag || '1')
            .input('email', sql.VarChar(50), email || null)
            .input('nohp', sql.VarChar(50), nohp || null)
            .input('jabat', sql.Char(2), jabat || null)
            .input('kdcab', sql.Char(3), kdcab || null)
            .query(`
        UPDATE muser
        SET noref = @noref,
            username = @username,
            levelid = @levelid,
            flag = @flag,
            email = @email,
            nohp = @nohp,
            jabat = @jabat,
            kdcab = @kdcab
        WHERE userid = @userid
      `);

        res.json({ success: true, message: 'User berhasil diperbarui' });
    } catch (error) {
        console.error('UPDATE USER ERROR:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put('/api/users/:userid/password', async (req, res) => {
    try {
        const { userid } = req.params;
        const { pass } = req.body;
        if (!pass) {
            return res.status(400).json({ success: false, message: 'Password wajib diisi' });
        }
        const pool = await getPool();
        await ensureMuserPasswordColumn(pool);
        await pool.request()
            .input('userid', sql.VarChar(30), userid)
            .input('pass', sql.VarChar(128), hashPassword(pass))
            .query('UPDATE muser SET pass = @pass WHERE userid = @userid');
        res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (error) {
        console.error('UPDATE PASSWORD ERROR:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});



const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 50,
    },
    fileFilter: (req, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.has(extension)) {
            return callback(new Error('File hanya boleh JPG, PNG, atau PDF.'));
        }
        callback(null, true);
    },
});

router.get("/api/files/signed-url", async (req, res) => {
  try {
    const key = req.query.key?.toString().trim();

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Key file kosong",
      });
    }

    const url = await getSignedB2Url(key, 60 * 10);

    res.json({
      success: true,
      key,
      url,
    });
  } catch (err) {
    console.error("SIGNED URL ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Gagal membuat signed URL",
      error: err.message,
    });
  }
});

router.get("/api/files/view", async (req, res) => {
  try {
    const key = req.query.key?.toString().trim();

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Key file kosong",
      });
    }

    const { result } = await getB2Object(key);
    const contentType = result.ContentType || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    if (result.ContentLength) {
      res.setHeader("Content-Length", result.ContentLength.toString());
    }

    if (typeof result.Body?.pipe === "function") {
      result.Body.pipe(res);
      return;
    }

    const chunks = [];
    for await (const chunk of result.Body) {
      chunks.push(chunk);
    }
    res.end(Buffer.concat(chunks));
  } catch (err) {
    console.error("B2 VIEW ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Gagal menampilkan file",
      error: err.message,
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
    await ensureMuserProfileColumn(pool);

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


function parsePayload(req) {
    if (req.body.payload) {
        return JSON.parse(req.body.payload);
    }
    return req.body;
}

function safeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function saveUploadedFiles(idPengajuan, files = []) {
    if (!files.length) {
        console.log('No files to save');
        return [];
    }

    const uploadTasks = files.map((file) => {
        const filename = `${Date.now()}-${file.fieldname}-${safeFilename(file.originalname)}`;
        const key = `pengajuan/${idPengajuan}/${filename}`;

        return {
            field: file.fieldname,
            original_name: file.originalname,
            filename,
            key,
            mimetype: file.mimetype,
            size: file.size,
            promise: uploadToB2({
                key,
                buffer: file.buffer,
                contentType: file.mimetype,
            }),
        };
    });

    console.log(`Uploading ${uploadTasks.length} files to Backblaze in parallel...`);

    const results = await Promise.allSettled(
        uploadTasks.map((task) => task.promise)
    );

    const savedFiles = [];
    const failedFiles = [];

    results.forEach((result, index) => {
        const task = uploadTasks[index];

        if (result.status === 'fulfilled') {
            savedFiles.push({
                field: task.field,
                original_name: task.original_name,
                filename: task.filename,
                key: task.key,
                path: result.value,
                mimetype: task.mimetype,
                size: task.size,
            });
        } else {
            failedFiles.push({
                field: task.field,
                original_name: task.original_name,
                key: task.key,
                error: result.reason?.message || String(result.reason),
            });
        }
    });

    if (failedFiles.length > 0) {
        console.error('Sebagian upload gagal:', failedFiles);

        await cleanupSavedFiles(savedFiles);

        throw new Error(
            `Upload gagal untuk ${failedFiles.length} file: ` +
            failedFiles.map((f) => f.original_name).join(', ')
        );
    }

    return savedFiles;
}

async function cleanupUploadFolder(idPengajuan) {
    if (!idPengajuan) return;
    const uploadDir = path.join(process.cwd(), 'uploads', 'pengajuan', idPengajuan);
    await fs.rm(uploadDir, { recursive: true, force: true });
}

async function cleanupSavedFiles(savedFiles = []) {
    const urls = savedFiles.map((file) => file.path || file.key).filter(Boolean);
    if (!urls.length) return 0;
    return deleteManyFromB2(urls);
}

function collectFileValues(rows = []) {
    const values = [];
    for (const row of rows) {
        for (const value of Object.values(row)) {
            if (value && typeof value === 'string' && value.trim()) {
                values.push(value.trim());
            }
        }
    }
    return values;
}

async function collectPengajuanFileUrls(pool, idPengajuan) {
    const columnResult = await pool.request().query(`
        SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE EXISTS (
            SELECT 1
            FROM INFORMATION_SCHEMA.COLUMNS idc
            WHERE idc.TABLE_SCHEMA = c.TABLE_SCHEMA
              AND idc.TABLE_NAME = c.TABLE_NAME
              AND idc.COLUMN_NAME = 'id_pengajuan'
        )
          AND c.DATA_TYPE IN ('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext')
          AND (
              c.COLUMN_NAME LIKE '%file%'
              OR c.COLUMN_NAME LIKE '%foto%'
              OR c.COLUMN_NAME LIKE '%path%'
              OR c.COLUMN_NAME LIKE '%url%'
              OR c.COLUMN_NAME LIKE '%ttd%'
              OR c.COLUMN_NAME LIKE '%dokumen%'
          )
    `);

    const specsByTable = new Map();
    for (const row of columnResult.recordset || []) {
        const schema = row.TABLE_SCHEMA;
        const table = row.TABLE_NAME;
        const key = `${schema}.${table}`;
        if (!specsByTable.has(key)) {
            specsByTable.set(key, { schema, table, columns: [] });
        }
        specsByTable.get(key).columns.push(row.COLUMN_NAME);
    }

    const values = [];
    for (const spec of specsByTable.values()) {
        try {
            const columns = spec.columns.map((column) => `[${column.replace(/]/g, ']]')}]`);
            const tableName = `[${spec.schema.replace(/]/g, ']]')}].[${spec.table.replace(/]/g, ']]')}]`;

            const result = await pool.request()
                .input('id', sql.VarChar, idPengajuan)
                .query(`
                    SELECT ${columns.join(', ')}
                    FROM ${tableName}
                    WHERE id_pengajuan = @id
                `);
            values.push(...collectFileValues(result.recordset || []));
        } catch (error) {
            console.log(`Skip collect files from ${spec.table}: ${error.message}`);
        }
    }

    return values;
}

async function cleanupPengajuanStorage(pool, idPengajuan) {
    const urls = await collectPengajuanFileUrls(pool, idPengajuan);
    const deletedListedFiles = await deleteManyFromB2(urls);
    const deletedPrefixedFiles = await deletePrefixFromB2(`pengajuan/${idPengajuan}/`);
    return deletedListedFiles + deletedPrefixedFiles;
}

async function deletePengajuanDatabaseRows(pool, idPengajuan) {
    const tableResult = await pool.request().query(`
        SELECT c.TABLE_SCHEMA, c.TABLE_NAME
        FROM INFORMATION_SCHEMA.COLUMNS c
        INNER JOIN INFORMATION_SCHEMA.TABLES t
            ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
           AND t.TABLE_NAME = c.TABLE_NAME
           AND t.TABLE_TYPE = 'BASE TABLE'
        WHERE c.COLUMN_NAME = 'id_pengajuan'
    `);

    const tables = (tableResult.recordset || [])
        .map((row) => ({
            schema: row.TABLE_SCHEMA,
            table: row.TABLE_NAME,
        }))
        .filter((item, index, list) =>
            list.findIndex((other) => other.schema === item.schema && other.table === item.table) === index
        )
        .sort((a, b) => {
            if (a.table === 't_pengajuan') return 1;
            if (b.table === 't_pengajuan') return -1;
            return a.table.localeCompare(b.table);
        });

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    let deletedTables = 0;

    try {
        for (const item of tables) {
            const tableName = `[${item.schema.replace(/]/g, ']]')}].[${item.table.replace(/]/g, ']]')}]`;
            await new sql.Request(transaction)
                .input('id', sql.VarChar, idPengajuan)
                .query(`DELETE FROM ${tableName} WHERE id_pengajuan = @id`);
            deletedTables += 1;
        }
        await transaction.commit();
        return deletedTables;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

async function ensureDokumenTable(pool) {
    await pool.request().query(`
        IF OBJECT_ID('dbo.t_pengajuan_dokumen', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_dokumen (
                id_dokumen INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                field_name VARCHAR(100) NOT NULL,
                original_name VARCHAR(255) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                file_path VARCHAR(500) NOT NULL,
                mime_type VARCHAR(100) NULL,
                file_size INT NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE()
            )
        END
    `);
}

async function ensureTableColumns(pool, tableName, columns) {
    const definitions = columns.map((column) => `
        IF COL_LENGTH('dbo.${tableName}', '${column.name}') IS NULL
        BEGIN
            ALTER TABLE dbo.${tableName} ADD ${column.name} ${column.type} NULL
        END
    `).join('\n');
    await pool.request().query(`
        IF OBJECT_ID('dbo.${tableName}', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.${tableName} (
                id_detail INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL
            )
        END
        IF COL_LENGTH('dbo.${tableName}', 'id_pengajuan') IS NULL
        BEGIN
            ALTER TABLE dbo.${tableName} ADD id_pengajuan VARCHAR(50) NULL
        END
        ${definitions}
    `);
}

async function ensurePengajuanDukcapilTable(pool) {
    await ensureTableColumns(pool, 't_pengajuan_dukcapil', [
        { name: 'id_penjamin', type: 'INT' },
        { name: 'id_pendiri', type: 'INT' },
        { name: 'jenis', type: 'VARCHAR(30)' },
        { name: 'index_ke', type: 'INT' },
        { name: 'dukcapil_data', type: 'NVARCHAR(MAX)' },
        { name: 'status_dukcapil', type: 'BIT' },
        { name: 'file_hasil_dukcapil', type: 'NVARCHAR(500)' },
        { name: 'catatan_admin', type: 'TEXT' },
        { name: 'verified_by', type: 'VARCHAR(100)' },
        { name: 'created_at', type: 'DATETIME' },
    ]);
}

async function ensureKelengkapanDokumenTable(pool) {
    await ensureTableColumns(pool, 't_pengajuan_kelengkapan_dokumen', [
        { name: 'category', type: 'VARCHAR(50)' },
        { name: 'description', type: 'NVARCHAR(500)' },
        { name: 'jaminan_index', type: 'INT' },
        { name: 'jaminan_label', type: 'NVARCHAR(200)' },
        { name: 'field_name', type: 'VARCHAR(100)' },
        { name: 'original_name', type: 'NVARCHAR(255)' },
        { name: 'file_name', type: 'NVARCHAR(255)' },
        { name: 'file_path', type: 'NVARCHAR(500)' },
        { name: 'mime_type', type: 'VARCHAR(100)' },
        { name: 'file_size', type: 'INT' },
        { name: 'created_at', type: 'DATETIME' },
    ]);
}

async function ensureMukTable(pool) {
    await ensureTableColumns(pool, 't_pengajuan_muk', [
        { name: 'muk_data', type: 'NVARCHAR(MAX)' },
        { name: 'created_at', type: 'DATETIME' },
        { name: 'updated_at', type: 'DATETIME' },
    ]);
}

async function ensureMutasiRekeningTables(pool) {
    await pool.request().query(`
        IF OBJECT_ID('dbo.t_pengajuan_mutasi_rekening', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_mutasi_rekening (
                id_mutasi INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                bank VARCHAR(50) NULL,
                periode VARCHAR(50) NULL,
                original_name NVARCHAR(255) NULL,
                file_name NVARCHAR(255) NULL,
                file_path NVARCHAR(500) NULL,
                mime_type VARCHAR(100) NULL,
                file_size INT NULL,
                uploaded_at DATETIME NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE()
            )
        END

        IF OBJECT_ID('dbo.t_pengajuan_mutasi_transaksi', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_mutasi_transaksi (
                id_transaksi INT IDENTITY(1,1) PRIMARY KEY,
                id_mutasi INT NOT NULL,
                id_pengajuan VARCHAR(50) NOT NULL,
                urutan INT NOT NULL DEFAULT 0,
                tanggal DATE NULL,
                keterangan NVARCHAR(MAX) NULL,
                debit DECIMAL(18,2) NULL,
                kredit DECIMAL(18,2) NULL,
                saldo DECIMAL(18,2) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE()
            )
        END
    `);
}

function sqlDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseMutasiByBank(bank, fullText) {
    switch (String(bank || '').toUpperCase()) {
        case 'BCA':
            return bcaParser(fullText);
        case 'MANDIRI':
            return mandiriParser(fullText);
        case 'BRI':
            return briParser(fullText);
        case 'BNI':
            return bniParser(fullText);
        case 'BPD PAPUA':
            return bpdPapuaParser(fullText);
        default:
            return null;
    }
}

async function getMukData(pool, idPengajuan) {
    await ensureMukTable(pool);
    const result = await pool.request()
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .query(`
            SELECT TOP 1 muk_data
            FROM t_pengajuan_muk
            WHERE id_pengajuan = @id_pengajuan
            ORDER BY ISNULL(updated_at, created_at) DESC
        `);

    const raw = result.recordset[0]?.muk_data;
    if (!raw) return {};

    try {
        return JSON.parse(raw) || {};
    } catch (_) {
        return {};
    }
}

async function saveMukData(pool, idPengajuan, mukData) {
    await ensureMukTable(pool);
    await pool.request()
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('muk_data', sql.NVarChar, JSON.stringify(mukData || {}))
        .query(`
            IF EXISTS (SELECT 1 FROM t_pengajuan_muk WHERE id_pengajuan = @id_pengajuan)
            BEGIN
                UPDATE t_pengajuan_muk
                SET muk_data = @muk_data,
                    updated_at = GETDATE()
                WHERE id_pengajuan = @id_pengajuan
            END
            ELSE
            BEGIN
                INSERT INTO t_pengajuan_muk (id_pengajuan, muk_data, created_at, updated_at)
                VALUES (@id_pengajuan, @muk_data, GETDATE(), GETDATE())
            END
        `);
}

async function ensurePengajuanLogTable(pool) {
    await ensureTableColumns(pool, 't_pengajuan_log', [
        { name: 'userid', type: 'VARCHAR(50)' },
        { name: 'username', type: 'NVARCHAR(100)' },
        { name: 'aksi', type: 'VARCHAR(50)' },
        { name: 'method', type: 'VARCHAR(10)' },
        { name: 'endpoint', type: 'NVARCHAR(300)' },
        { name: 'status_code', type: 'INT' },
        { name: 'stsflag_from', type: 'VARCHAR(10)' },
        { name: 'stsflag_to', type: 'VARCHAR(10)' },
        { name: 'catatan', type: 'NVARCHAR(MAX)' },
        { name: 'metadata', type: 'NVARCHAR(MAX)' },
        { name: 'ip_address', type: 'VARCHAR(80)' },
        { name: 'user_agent', type: 'NVARCHAR(500)' },
        { name: 'created_at', type: 'DATETIME' },
    ]);

    await pool.request().query(`
        IF COL_LENGTH('dbo.t_pengajuan_log', 'id_pengajuan') IS NOT NULL
        BEGIN
            ALTER TABLE dbo.t_pengajuan_log ALTER COLUMN id_pengajuan VARCHAR(50) NULL
        END
        IF COL_LENGTH('dbo.t_pengajuan_log', 'stsflag_old') IS NOT NULL
        BEGIN
            ALTER TABLE dbo.t_pengajuan_log ALTER COLUMN stsflag_old VARCHAR(10) NULL
        END
        IF COL_LENGTH('dbo.t_pengajuan_log', 'stsflag_new') IS NOT NULL
        BEGIN
            ALTER TABLE dbo.t_pengajuan_log ALTER COLUMN stsflag_new VARCHAR(10) NULL
        END
    `);
}

async function insertPengajuanLog(pool, data) {
    await ensurePengajuanLogTable(pool);
    await pool.request()
        .input('id_pengajuan', sql.VarChar, data.id_pengajuan || '-')
        .input('userid', sql.VarChar, data.userid || null)
        .input('username', sql.NVarChar, data.username || null)
        .input('aksi', sql.VarChar, data.aksi)
        .input('method', sql.VarChar, data.method || null)
        .input('endpoint', sql.NVarChar, data.endpoint || null)
        .input('status_code', sql.Int, data.status_code || null)
        .input('stsflag_from', sql.VarChar, data.stsflag_from || null)
        .input('stsflag_to', sql.VarChar, data.stsflag_to || null)
        .input('catatan', sql.NVarChar, data.catatan || null)
        .input('metadata', sql.NVarChar, data.metadata || null)
        .input('ip_address', sql.VarChar, data.ip_address || null)
        .input('user_agent', sql.NVarChar, data.user_agent || null)
        .query(`
            INSERT INTO t_pengajuan_log
                (id_pengajuan, userid, username, aksi, method, endpoint, status_code,
                 stsflag_from, stsflag_to, catatan, metadata, ip_address, user_agent, created_at)
            VALUES
                (@id_pengajuan, @userid, @username, @aksi, @method, @endpoint, @status_code,
                 @stsflag_from, @stsflag_to, @catatan, @metadata, @ip_address, @user_agent, GETDATE())
        `);
}

function auditLogger(req, res, next) {
    if (!req.originalUrl.startsWith('/api/') || !['POST', 'PUT', 'DELETE'].includes(req.method)) {
        return next();
    }

    let responseBody = null;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        responseBody = body;
        return originalJson(body);
    };

    res.on('finish', async () => {
        try {
            const payload = parseAuditPayload(req);
            const action = auditActionName(req);
            const actor = pickAuditActor(req, payload);
            const sanitizedPayload = sanitizeAuditValue(payload);
            const sanitizedResponse = sanitizeAuditValue(responseBody);
            const metadata = {
                payload: sanitizedPayload,
                response: sanitizedResponse,
            };

            await insertPengajuanLog(await getPool(), {
                id_pengajuan: pickAuditPengajuanId(req, payload),
                userid: actor.userid,
                username: actor.username,
                aksi: action,
                method: req.method,
                endpoint: req.originalUrl,
                status_code: res.statusCode,
                stsflag_from: responseBody?.previous_stsflag || null,
                stsflag_to: responseBody?.stsflag || payload?.target_stsflag || payload?.stsflag || null,
                catatan: auditNote(action, payload),
                metadata: JSON.stringify(metadata),
                ip_address: req.ip || req.socket?.remoteAddress || null,
                user_agent: req.get('user-agent') || null,
            });
        } catch (error) {
            console.error('AUDIT LOG ERROR:', error.message);
        }
    });

    return next();
}

async function ensureVerifikasiDukcapilColumns(pool) {
    await ensureTableColumns(pool, 't_verifikasi_dukcapil', [
        { name: 'status_debitur', type: 'BIT' },
        { name: 'status_pasangan', type: 'BIT' },
        { name: 'catatan_admin', type: 'TEXT' },
        { name: 'catatan_admin_debitur', type: 'TEXT' },
        { name: 'catatan_admin_pasangan', type: 'TEXT' },
        { name: 'file_hasil_dukcapil_debitur', type: 'NVARCHAR(500)' },
        { name: 'file_hasil_dukcapil_pasangan', type: 'NVARCHAR(500)' },
        { name: 'verified_by', type: 'VARCHAR(100)' },
        { name: 'verified_at', type: 'DATETIME' },
    ]);
}

async function getTableColumnMeta(pool, tableName) {
    const result = await pool.request()
        .input('table_name', sql.VarChar, tableName)
        .query(`
            SELECT COLUMN_NAME, IS_NULLABLE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'dbo'
              AND TABLE_NAME = @table_name
        `);

    return new Map(
        result.recordset.map((column) => [
            column.COLUMN_NAME,
            { nullable: column.IS_NULLABLE === 'YES' },
        ])
    );
}

async function insertPengajuanDukcapil(pool, columnMeta, data) {
    const request = pool.request();
    const columns = [];
    const values = [];

    const normalizeValue = (columnName, value) => {
        const meta = columnMeta.get(columnName);
        if (value !== null && value !== undefined) return value;
        if (meta?.nullable === false && columnName === 'id_penjamin') {
            if (data.id_pendiri !== null && data.id_pendiri !== undefined) return -Math.abs(data.id_pendiri);
            return -100000 - (Number(data.index_ke) || 0);
        }
        if (meta?.nullable === false && columnName === 'id_pendiri') {
            if (data.id_penjamin !== null && data.id_penjamin !== undefined) return -Math.abs(data.id_penjamin);
            return -200000 - (Number(data.index_ke) || 0);
        }
        if (meta?.nullable === false && columnName === 'index_ke') {
            return 0;
        }
        return value ?? null;
    };

    const effectiveIdPenjamin = normalizeValue('id_penjamin', data.id_penjamin ?? null);
    const effectiveIdPendiri = normalizeValue('id_pendiri', data.id_pendiri ?? null);
    const effectiveIndexKe = normalizeValue('index_ke', data.index_ke);

    const deleteRequest = pool.request();
    const deleteConditions = [];
    if (columnMeta.has('id_penjamin') && effectiveIdPenjamin !== null && effectiveIdPenjamin !== undefined) {
        deleteConditions.push('id_penjamin = @delete_id_penjamin');
        deleteRequest.input('delete_id_penjamin', sql.Int, effectiveIdPenjamin);
    } else if (columnMeta.has('id_pendiri') && effectiveIdPendiri !== null && effectiveIdPendiri !== undefined) {
        deleteConditions.push('id_pendiri = @delete_id_pendiri');
        deleteRequest.input('delete_id_pendiri', sql.Int, effectiveIdPendiri);
    } else if (columnMeta.has('id_pengajuan') && columnMeta.has('jenis') && columnMeta.has('index_ke')) {
        deleteConditions.push('id_pengajuan = @delete_id_pengajuan');
        deleteConditions.push('jenis = @delete_jenis');
        deleteConditions.push('index_ke = @delete_index_ke');
        deleteRequest
            .input('delete_id_pengajuan', sql.VarChar, data.id_pengajuan)
            .input('delete_jenis', sql.VarChar, data.jenis)
            .input('delete_index_ke', sql.Int, effectiveIndexKe);
    }
    if (deleteConditions.length > 0) {
        await deleteRequest.query(`DELETE FROM t_pengajuan_dukcapil WHERE ${deleteConditions.join(' AND ')}`);
    }

    const addColumn = (columnName, paramName, type, value) => {
        if (!columnMeta.has(columnName)) return;
        columns.push(columnName);
        values.push(`@${paramName}`);
        request.input(paramName, type, normalizeValue(columnName, value));
    };

    addColumn('id_pengajuan', 'id_pengajuan', sql.VarChar, data.id_pengajuan);
    addColumn('id_penjamin', 'id_penjamin', sql.Int, effectiveIdPenjamin);
    addColumn('id_pendiri', 'id_pendiri', sql.Int, effectiveIdPendiri);
    addColumn('jenis', 'jenis', sql.VarChar, data.jenis);
    addColumn('index_ke', 'index_ke', sql.Int, effectiveIndexKe);
    addColumn('dukcapil_data', 'dukcapil_data', sql.NVarChar, JSON.stringify({
        jenis: data.jenis,
        index_ke: effectiveIndexKe,
        id_penjamin: effectiveIdPenjamin,
        id_pendiri: effectiveIdPendiri,
        status_dukcapil: data.status_dukcapil,
        file_hasil_dukcapil: data.file_hasil_dukcapil,
        catatan_admin: data.catatan_admin,
        verified_by: data.verified_by,
        created_at: data.created_at,
    }));
    addColumn('status_dukcapil', 'status_dukcapil', sql.Bit, data.status_dukcapil);
    addColumn('file_hasil_dukcapil', 'file_hasil_dukcapil', sql.NVarChar, data.file_hasil_dukcapil);
    addColumn('catatan_admin', 'catatan_admin', sql.Text, data.catatan_admin);
    addColumn('verified_by', 'verified_by', sql.VarChar, data.verified_by);
    addColumn('created_at', 'created_at', sql.DateTime, data.created_at);

    await request.query(`
        INSERT INTO t_pengajuan_dukcapil (${columns.join(', ')})
        VALUES (${values.join(', ')})
    `);
}


async function ensurePengajuanDetailTables(pool) {
    await ensureTableColumns(pool, 't_debitur_perorangan', [
        { name: 'foto_kk', type: 'NVARCHAR(500)' },
        { name: 'ttd_debitur', type: 'NVARCHAR(MAX)' },
        { name: 'ttd_pasangan', type: 'NVARCHAR(MAX)' },
        { name: 'ttd_debitur_base64', type: 'NVARCHAR(MAX)' },
        { name: 'ttd_pasangan_base64', type: 'NVARCHAR(MAX)' },
    ]);

    await ensureTableColumns(pool, 't_debitur_badan_usaha', [
        { name: 'alamat_domisili_perusahaan', type: 'TEXT' },
        { name: 'nib', type: 'VARCHAR(100)' },
        { name: 'no_akta_pendirian', type: 'VARCHAR(100)' },
        { name: 'notaris', type: 'VARCHAR(150)' },
        { name: 'no_sk_kemenhum', type: 'VARCHAR(100)' },
        { name: 'tgl_sk_kemenhum', type: 'DATE' },
        { name: 'modal_dasar', type: 'VARCHAR(100)' },
        { name: 'rt_rw', type: 'VARCHAR(50)' },
        { name: 'kode_pos', type: 'VARCHAR(20)' },
        { name: 'provinsi_code', type: 'VARCHAR(20)' },
        { name: 'provinsi', type: 'VARCHAR(100)' },
        { name: 'kabupaten_code', type: 'VARCHAR(20)' },
        { name: 'kabupaten', type: 'VARCHAR(100)' },
        { name: 'kecamatan_code', type: 'VARCHAR(20)' },
        { name: 'kecamatan', type: 'VARCHAR(100)' },
        { name: 'kelurahan_code', type: 'VARCHAR(20)' },
        { name: 'kelurahan', type: 'VARCHAR(100)' },
        { name: 'tgl_perubahan', type: 'DATE' },
        { name: 'no_akta_perubahan', type: 'VARCHAR(100)' },
        { name: 'notaris_perubahan', type: 'VARCHAR(150)' },
        { name: 'no_sk_kemenhum_perubahan', type: 'VARCHAR(100)' },
        { name: 'tgl_sk_kemenhum_perubahan', type: 'DATE' },
        { name: 'alasan_perubahan', type: 'TEXT' },
        { name: 'lama_usaha', type: 'VARCHAR(50)' },
        { name: 'telp_usaha', type: 'VARCHAR(50)' },
        { name: 'sektor_usaha', type: 'VARCHAR(150)' },
        { name: 'nomor_npwp_usaha', type: 'VARCHAR(50)' },
        { name: 'sektor_ekonomi', type: 'VARCHAR(150)' },
        { name: 'golongan_debitur', type: 'VARCHAR(150)' },
        { name: 'pendapatan_usaha', type: 'VARCHAR(100)' },
        { name: 'total_penghasilan', type: 'VARCHAR(100)' },
        { name: 'total_biaya', type: 'VARCHAR(100)' },
        { name: 'file_akta_pendirian', type: 'NVARCHAR(500)' },
    ]);
    await ensureTableColumns(pool, 't_pengajuan_pendiri', [
        { name: 'alamat_ktp', type: 'TEXT' },
        { name: 'alamat_domisili', type: 'TEXT' },
        { name: 'no_hp', type: 'VARCHAR(50)' },
        { name: 'tgl_berlaku_ktp', type: 'DATE' },
        { name: 'ktp_berlaku_seumur_hidup', type: 'BIT' },
        { name: 'agama', type: 'VARCHAR(50)' },
        { name: 'nama_ibu_kandung', type: 'VARCHAR(150)' },
    ]);
    await ensureTableColumns(pool, 't_pengajuan_penjamin', [
        { name: 'nama_penjamin', type: 'VARCHAR(150)' },
        { name: 'ktp_penjamin', type: 'VARCHAR(50)' },
        { name: 'hubungan_debitur', type: 'VARCHAR(100)' },
        { name: 'no_hp_penjamin', type: 'VARCHAR(50)' },
        { name: 'foto_penjamin', type: 'NVARCHAR(500)' },
        { name: 'ttd_penjamin', type: 'NVARCHAR(500)' },
        { name: 'tempat_lahir', type: 'VARCHAR(100)' },
        { name: 'tanggal_lahir', type: 'DATE' },
        { name: 'jenis_kelamin', type: 'VARCHAR(30)' },
        { name: 'tgl_berlaku_ktp', type: 'DATE' },
        { name: 'ktp_berlaku_seumur_hidup', type: 'BIT' },
    ]);
    await ensureTableColumns(pool, 't_detail_debitur', [
        { name: 'nama_panggilan', type: 'VARCHAR(100)' },
        { name: 'alamat_debitur', type: 'TEXT' },
        { name: 'alamat_domisili_debitur', type: 'TEXT' },
        { name: 'domisili_sesuai_ktp_debitur', type: 'BIT' },
        { name: 'tempat_lahir', type: 'VARCHAR(100)' },
        { name: 'tanggal_lahir', type: 'DATE' },
        { name: 'agama', type: 'VARCHAR(50)' },
        { name: 'rt_rw', type: 'VARCHAR(50)' },
        { name: 'kode_pos', type: 'VARCHAR(20)' },
        { name: 'email', type: 'VARCHAR(150)' },
        { name: 'nama_ibu_kandung', type: 'VARCHAR(150)' },
        { name: 'tgl_berlaku_ktp', type: 'DATE' },
        { name: 'ktp_berlaku_seumur_hidup', type: 'BIT' },
        { name: 'jenis_kelamin', type: 'VARCHAR(30)' },
        { name: 'status_menikah', type: 'VARCHAR(50)' },
        { name: 'status_pendidikan', type: 'VARCHAR(50)' },
        { name: 'provinsi_code', type: 'VARCHAR(20)' },
        { name: 'provinsi', type: 'VARCHAR(100)' },
        { name: 'kabupaten_code', type: 'VARCHAR(20)' },
        { name: 'kabupaten', type: 'VARCHAR(100)' },
        { name: 'kecamatan_code', type: 'VARCHAR(20)' },
        { name: 'kecamatan', type: 'VARCHAR(100)' },
        { name: 'kelurahan_code', type: 'VARCHAR(20)' },
        { name: 'kelurahan', type: 'VARCHAR(100)' },
        { name: 'foto_pas_photo', type: 'NVARCHAR(500)' },
    ]);
    await ensureTableColumns(pool, 't_detail_pasangan_debitur', [
        { name: 'nama_panggilan_pasangan', type: 'VARCHAR(100)' },
        { name: 'tempat_lahir_pasangan', type: 'VARCHAR(100)' },
        { name: 'tanggal_lahir_pasangan', type: 'DATE' },
        { name: 'agama_pasangan', type: 'VARCHAR(50)' },
        { name: 'alamat_pasangan', type: 'TEXT' },
        { name: 'alamat_domisili_pasangan', type: 'TEXT' },
        { name: 'domisili_sesuai_ktp_pasangan', type: 'BIT' },
        { name: 'rt_rw_pasangan', type: 'VARCHAR(50)' },
        { name: 'kode_pos_pasangan', type: 'VARCHAR(20)' },
        { name: 'email_pasangan', type: 'VARCHAR(150)' },
        { name: 'tgl_berlaku_ktp_pasangan', type: 'DATE' },
        { name: 'ktp_berlaku_seumur_hidup_pasangan', type: 'BIT' },
        { name: 'jenis_kelamin_pasangan', type: 'VARCHAR(30)' },
        { name: 'provinsi_code_pasangan', type: 'VARCHAR(20)' },
        { name: 'provinsi_pasangan', type: 'VARCHAR(100)' },
        { name: 'kabupaten_code_pasangan', type: 'VARCHAR(20)' },
        { name: 'kabupaten_pasangan', type: 'VARCHAR(100)' },
        { name: 'kecamatan_code_pasangan', type: 'VARCHAR(20)' },
        { name: 'kecamatan_pasangan', type: 'VARCHAR(100)' },
        { name: 'kelurahan_code_pasangan', type: 'VARCHAR(20)' },
        { name: 'kelurahan_pasangan', type: 'VARCHAR(100)' },
        { name: 'foto_pasangan_photo', type: 'NVARCHAR(500)' },
    ]);
    await ensureTableColumns(pool, 't_keluarga_tidak_serumah', [
        { name: 'nama_keluarga_1', type: 'VARCHAR(150)' },
        { name: 'hp_keluarga_1', type: 'VARCHAR(50)' },
        { name: 'nama_keluarga_2', type: 'VARCHAR(150)' },
        { name: 'hp_keluarga_2', type: 'VARCHAR(50)' },
    ]);
    await ensureTableColumns(pool, 't_detail_usaha_debitur', [
        { name: 'form_pekerjaan', type: 'VARCHAR(100)' },
        { name: 'bekerja', type: 'VARCHAR(150)' },
        { name: 'nama_perusahaan_kerja', type: 'VARCHAR(150)' },
        { name: 'jabatan', type: 'VARCHAR(100)' },
        { name: 'bidang_usaha', type: 'VARCHAR(150)' },
        { name: 'jenis_pekerjaan', type: 'VARCHAR(50)' },
        { name: 'lama_bekerja', type: 'VARCHAR(50)' },
        { name: 'alamat_kantor', type: 'TEXT' },
        { name: 'telp_kantor', type: 'VARCHAR(50)' },
        { name: 'gaji', type: 'VARCHAR(100)' },
        { name: 'nama_usaha', type: 'VARCHAR(150)' },
        { name: 'lama_usaha', type: 'VARCHAR(50)' },
        { name: 'alamat_usaha', type: 'TEXT' },
        { name: 'telp_usaha', type: 'VARCHAR(50)' },
        { name: 'hasil_usaha', type: 'VARCHAR(100)' },
        { name: 'sektor_usaha', type: 'VARCHAR(150)' },
        { name: 'nomor_npwp', type: 'VARCHAR(50)' },
        { name: 'pekerjaan_slik', type: 'VARCHAR(150)' },
        { name: 'sektor_ekonomi', type: 'VARCHAR(150)' },
        { name: 'golongan_debitur', type: 'VARCHAR(150)' },
    ]);
    await ensureTableColumns(pool, 't_detail_usaha_pasangan', [
        { name: 'form_pekerjaan', type: 'VARCHAR(100)' },
        { name: 'bekerja', type: 'VARCHAR(150)' },
        { name: 'nama_perusahaan_kerja', type: 'VARCHAR(150)' },
        { name: 'jabatan', type: 'VARCHAR(100)' },
        { name: 'bidang_usaha', type: 'VARCHAR(150)' },
        { name: 'jenis_pekerjaan', type: 'VARCHAR(50)' },
        { name: 'lama_bekerja', type: 'VARCHAR(50)' },
        { name: 'alamat_kantor', type: 'TEXT' },
        { name: 'telp_kantor', type: 'VARCHAR(50)' },
        { name: 'gaji', type: 'VARCHAR(100)' },
        { name: 'nama_usaha', type: 'VARCHAR(150)' },
        { name: 'lama_usaha', type: 'VARCHAR(50)' },
        { name: 'alamat_usaha', type: 'TEXT' },
        { name: 'telp_usaha', type: 'VARCHAR(50)' },
        { name: 'hasil_usaha', type: 'VARCHAR(100)' },
        { name: 'sektor_usaha', type: 'VARCHAR(150)' },
        { name: 'nomor_npwp', type: 'VARCHAR(50)' },
        { name: 'pekerjaan_slik', type: 'VARCHAR(150)' },
        { name: 'sektor_ekonomi', type: 'VARCHAR(150)' },
        { name: 'golongan_debitur', type: 'VARCHAR(150)' },
    ]);
    await ensureTableColumns(pool, 't_debitur_data_penghasilan', [
        { name: 'pendapatan_usaha_debitur', type: 'DECIMAL(18,2)' },
        { name: 'total_penghasilan_debitur', type: 'DECIMAL(18,2)' },
        { name: 'total_biaya_perbulan', type: 'DECIMAL(18,2)' },
    ]);
    await ensureTableColumns(pool, 't_debitur_data_kredit', [
        { name: 'referensi', type: 'VARCHAR(100)' },
        { name: 'nama_referensi', type: 'VARCHAR(150)' },
        { name: 'hubungan_dengan_bank', type: 'VARCHAR(100)' },
        { name: 'tujuan_penggunaan', type: 'VARCHAR(100)' },
        { name: 'jumlah_pengajuan_kredit', type: 'DECIMAL(18,2)' },
        { name: 'jangka_waktu_bulan', type: 'INT' },
        { name: 'bunga_per_tahun', type: 'DECIMAL(9,4)' },
        { name: 'jenis_hitung_bunga', type: 'VARCHAR(50)' },
        { name: 'jenis_kredit', type: 'VARCHAR(100)' },
        { name: 'no_rekening_bank_lain', type: 'VARCHAR(100)' },
        { name: 'sumber_pembayaran_kredit', type: 'VARCHAR(150)' },
        { name: 'detail_tujuan', type: 'TEXT' },
        { name: 'sindikasi', type: 'VARCHAR(50)' },
        { name: 'alasan', type: 'TEXT' },
        { name: 'asuransi_jiwa', type: 'BIT' },
        { name: 'asuransi_kredit', type: 'BIT' },
        { name: 'asuransi_lainnya', type: 'BIT' },
    ]);
    await ensureTableColumns(pool, 't_debitur_data_jaminan', [
        { name: 'jenis_jaminan', type: 'VARCHAR(100)' },
        { name: 'data_jaminan', type: 'NVARCHAR(MAX)' },
    ]);
}

function nullableDate(value) {
    return value ? new Date(value) : null;
}

function parseLocaleNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    const text = String(value).trim();
    if (!text) return null;

    const cleaned = text.replace(/[^\d,.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === ',' || cleaned === '.') return null;

    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    let normalized = cleaned;

    if (lastDot >= 0 && lastComma >= 0) {
        normalized = lastComma > lastDot
            ? cleaned.replace(/\./g, '').replace(',', '.')
            : cleaned.replace(/,/g, '');
    } else if (lastComma >= 0) {
        const commaCount = (cleaned.match(/,/g) || []).length;
        const decimalDigits = cleaned.length - lastComma - 1;
        normalized = commaCount > 1 || decimalDigits === 3
            ? cleaned.replace(/,/g, '')
            : cleaned.replace(',', '.');
    } else if (lastDot >= 0) {
        const dotCount = (cleaned.match(/\./g) || []).length;
        const decimalDigits = cleaned.length - lastDot - 1;
        normalized = dotCount > 1 || decimalDigits === 3
            ? cleaned.replace(/\./g, '')
            : cleaned;
    }

    const number = Number(normalized);

    return Number.isFinite(number) ? number : null;
}

function nullableNumber(value) {
    const number = parseLocaleNumber(value);
    if (number === null) return null;
    const rounded = Number(number.toFixed(2));
    return Number.isFinite(rounded) && Math.abs(rounded) < 10000000000000000
        ? rounded
        : null;
}

function nullableDecimalNumber(value) {
    const number = parseLocaleNumber(value);
    if (number === null) return null;
    const rounded = Number(number.toFixed(4));
    return Number.isFinite(rounded) && Math.abs(rounded) < 100000
        ? rounded
        : null;
}

function nullableInt(value) {
    const number = nullableNumber(value);
    return number === null ? null : Math.trunc(number);
}

function getFilePath(savedFiles, field) {
    return savedFiles.find((file) => file.field === field)?.path || null;
}

function handleUpload(req, res, next) {
    upload.any()(req, res, (error) => {
        if (error) {
            return res.status(400).json({ status: 'error', message: error.message });
        }
        next();
    });
}

function handleSingleMutasiUpload(req, res, next) {
    upload.single('file')(req, res, (error) => {
        if (error) {
            return res.status(400).json({ status: 'error', message: error.message });
        }
        next();
    });
}

async function rollbackIfActive(transactionStarted, transaction) {
    if (!transactionStarted || !transaction) return;

    try {
        await transaction.rollback();
    } catch (rollbackError) {
        console.error('ROLLBACK ERROR:', rollbackError);
    }
}

function normalizeOcrLine(line) {
    return (line || '').replace(/\|/g, 'I').replace(/\s+/g, ' ').trim();
}

function valueAfterLabel(line, labels) {
    let cleaned = normalizeOcrLine(line);
    const upper = cleaned.toUpperCase();
    for (const label of labels) {
        const index = upper.indexOf(label);
        if (index >= 0) {
            cleaned = cleaned.substring(index + label.length).trim();
            break;
        }
    }
    return cleaned.replace(/^[\s:.-]+/, '').trim();
}

function nextValue(lines, startIndex) {
    for (let i = startIndex + 1; i < lines.length; i++) {
        const value = normalizeOcrLine(lines[i]);
        if (value) return value;
    }
    return '';
}

function normalizeKtpDate(value) {
    const match = String(value || '').match(/(\d{1,2})[\-/](\d{1,2})[\-/](\d{4})/);
    if (!match) return '';
    return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function normalizeKtpGender(value) {
    const upper = String(value || '').toUpperCase();
    if (upper.includes('LAKI')) return 'LAKI-LAKI';
    if (upper.includes('PEREMPUAN') || upper.includes('WANITA')) return 'PEREMPUAN';
    return '';
}

function normalizeOcrDigits(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[OoQD]/g, '0')
        .replace(/[Il|!]/g, '1')
        .replace(/[Zz]/g, '2')
        .replace(/[Aa]/g, '4')
        .replace(/[Ss]/g, '5')
        .replace(/[Gg]/g, '6')
        .replace(/[Tt]/g, '7')
        .replace(/[Bb]/g, '8')
        .replace(/[^0-9]/g, '');
}

function isLikelyNik(value) {
    if (!/^\d{16}$/.test(value)) return false;
    const day = Number(value.substring(6, 8));
    const month = Number(value.substring(8, 10));
    const sequence = Number(value.substring(12, 16));
    const normalizedDay = day > 40 ? day - 40 : day;
    return normalizedDay >= 1 && normalizedDay <= 31 && month >= 1 && month <= 12 && sequence > 0;
}

function collectNikCandidates(value) {
    const digits = normalizeOcrDigits(value);
    const candidates = [];
    for (let i = 0; i <= digits.length - 16; i++) {
        const candidate = digits.substring(i, i + 16);
        candidates.push(candidate);
    }
    return candidates;
}

function bestNikCandidate(values) {
    const allCandidates = values.flatMap(collectNikCandidates);
    return allCandidates.find(isLikelyNik) || allCandidates[0] || '';
}

function formatNpwp(value) {
    if (value.length === 15) {
        return `${value.substring(0, 2)}.${value.substring(2, 5)}.${value.substring(5, 8)}.${value.substring(8, 9)}-${value.substring(9, 12)}.${value.substring(12, 15)}`;
    }
    return value;
}

function collectDigitCandidates(value, length) {
    const digits = normalizeOcrDigits(value);
    const candidates = [];
    for (let i = 0; i <= digits.length - length; i++) {
        candidates.push(digits.substring(i, i + length));
    }
    return candidates;
}

function bestNpwpCandidate(values) {
    const candidates = [];
    for (const value of values) {
        candidates.push(...collectDigitCandidates(value, 16));
        candidates.push(...collectDigitCandidates(value, 15));
    }
    const candidate = candidates.find((item) => item.length === 15 || item.length === 16);
    return candidate ? formatNpwp(candidate) : '';
}

function findKtpNik(lines, rawText) {
    const labelCandidates = [];
    const nearbyCandidates = [];
    for (let i = 0; i < lines.length; i++) {
        if (/NIK|N1K|NlK|NO\.?\s*KTP|NOMOR/i.test(lines[i])) {
            const afterLabel = lines[i].replace(/^.*?(?:NIK|N1K|NlK|NO\.?\s*KTP|NOMOR)\s*[:.\-]?\s*/i, '');
            labelCandidates.push(afterLabel);
            nearbyCandidates.push(lines[i + 1] || '', lines[i + 2] || '');
        }
    }

    return (
        bestNikCandidate(labelCandidates) ||
        bestNikCandidate(nearbyCandidates) ||
        bestNikCandidate([String(rawText || '')])
    );
}

function findNpwp(lines, rawText) {
    const labelCandidates = [];
    const nearbyCandidates = [];
    for (let i = 0; i < lines.length; i++) {
        if (/\bN\s*P\s*W\s*P\b/i.test(lines[i])) {
            labelCandidates.push(lines[i]);
            nearbyCandidates.push(lines[i + 1] || '', lines[i + 2] || '');
        }
    }

    return (
        bestNpwpCandidate(labelCandidates) ||
        bestNpwpCandidate(nearbyCandidates) ||
        (/NPWP/i.test(rawText) ? bestNpwpCandidate([String(rawText || '')]) : '')
    );
}

function cleanKtpValue(value) {
    return String(value || '')
        .replace(/\bPROVINSI\b.*/i, '')
        .replace(/\bKABUPATEN\b.*/i, '')
        .replace(/\bKOTA\b.*/i, '')
        .replace(/\bNIK\b.*/i, '')
        .replace(/\bNAMA\b.*/i, '')
        .replace(/\bTEMPAT\b.*/i, '')
        .replace(/\bTGL\b.*/i, '')
        .replace(/\bLAHIR\b.*/i, '')
        .replace(/\bJENIS\s*KELAMIN\b.*/i, '')
        .replace(/\bBERLAKU\b.*/i, '')
        .replace(/\bGOL\.?\s*DARAH\b.*/i, '')
        .replace(/\bAGAMA\b.*/i, '')
        .replace(/\bSTATUS\b.*/i, '')
        .replace(/\bPEKERJAAN\b.*/i, '')
        .replace(/[^\p{L}\p{N}\s.,/\-]/gu, '')
        .replace(/\s+-+\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.,/\-]+|[\s.,/\-]+$/g, '')
        .trim();
}

function cleanKtpName(value) {
    return cleanKtpValue(value)
        .replace(/\s+\bPR\b.*$/i, '')
        .replace(/\s+\bPRO\b.*$/i, '')
        .trim();
}

function parseKtpOcrText(text) {
    const result = {
        document_type: '',
        nik: '',
        npwp: '',
        nama: '',
        tempat_lahir: '',
        tanggal_lahir: '',
        jenis_kelamin: '',
        golongan_darah: '',
        alamat: '',
        rt_rw: '',
        kelurahan: '',
        kecamatan: '',
        agama: '',
        status_perkawinan: '',
        pekerjaan: '',
        kewarganegaraan: '',
    };
    const lines = String(text || '').split('\n').map(normalizeOcrLine);
    result.nik = findKtpNik(lines, text);
    result.npwp = findNpwp(lines, text);
    result.document_type = result.nik ? 'KTP' : (result.npwp ? 'NPWP' : '');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upperLine = line.toUpperCase();

        if (!result.nama && upperLine.includes('NAMA') && !upperLine.includes('PROVINSI')) {
            const value = valueAfterLabel(line, ['NAMA']);
            result.nama = cleanKtpName(value && value.toUpperCase() !== 'NAMA' ? value : nextValue(lines, i));
        }

        if (!result.tempat_lahir && (upperLine.includes('TEMPAT') || upperLine.includes('TGL') || upperLine.includes('LAHIR') || upperLine.includes('TTL'))) {
            const combined = `${line} ${lines[i + 1] || ''}`;
            const match = combined.match(/([A-Za-zÀ-ÿ\s.-]+),?\s*(\d{1,2}[\-/]\d{1,2}[\-/]\d{4})/);
            if (match) {
                const tempat = valueAfterLabel(match[1], ['TEMPAT/TGL LAHIR', 'TEMPAT TGL LAHIR', 'TEMPAT LAHIR', 'TGL LAHIR', 'LAHIR', 'TTL']);
                result.tempat_lahir = cleanKtpValue(tempat).toUpperCase();
                result.tanggal_lahir = normalizeKtpDate(match[2]);
            }
        }

        if (!result.jenis_kelamin && upperLine.includes('JENIS KELAMIN')) {
            const value = valueAfterLabel(line, ['JENIS KELAMIN']);
            result.jenis_kelamin = normalizeKtpGender(`${value} ${nextValue(lines, i)}`);
        }

        if (!result.alamat && upperLine.includes('ALAMAT')) {
            const alamat = [];
            let j = i + 1;
            while (j < lines.length && !/RT|KELURAHAN|DESA/i.test(lines[j]) && lines[j].trim()) {
                alamat.push(lines[j].trim());
                j++;
            }
            result.alamat = alamat.join(' ').trim();
        }

        const rtRwMatch = line.match(/RT\s*(\d+)\s*\/\s*RW\s*(\d+)/i);
        if (rtRwMatch) result.rt_rw = `RT ${rtRwMatch[1]} / RW ${rtRwMatch[2]}`;

        if (!result.kelurahan && (upperLine.includes('KELURAHAN') || upperLine.includes('DESA'))) {
            result.kelurahan = cleanKtpValue(valueAfterLabel(line, ['KELURAHAN', 'DESA']) || nextValue(lines, i)).toUpperCase();
        }
        if (!result.kecamatan && upperLine.includes('KECAMATAN')) {
            result.kecamatan = cleanKtpValue(valueAfterLabel(line, ['KECAMATAN']) || nextValue(lines, i)).toUpperCase();
        }
        if (!result.agama && upperLine.includes('AGAMA')) {
            result.agama = cleanKtpValue(valueAfterLabel(line, ['AGAMA']) || nextValue(lines, i)).toUpperCase();
        }
        if (!result.status_perkawinan && upperLine.includes('STATUS PERKAWINAN')) {
            result.status_perkawinan = cleanKtpValue(valueAfterLabel(line, ['STATUS PERKAWINAN']) || nextValue(lines, i)).toUpperCase();
        }
        if (!result.pekerjaan && upperLine.includes('PEKERJAAN')) {
            result.pekerjaan = cleanKtpValue(valueAfterLabel(line, ['PEKERJAAN']) || nextValue(lines, i)).toUpperCase();
        }
    }

    return result;
}



router.post('/api/ktp/scan', handleUpload, async (req, res) => {
    const image = req.files?.find((file) => file.fieldname === 'ktp_image') || req.files?.[0];
    if (!image) {
        return res.status(400).json({ status: 'error', message: 'File gambar KTP tidak ditemukan.' });
    }

    let worker;
    try {
        worker = await createWorker('eng');
        const { data } = await worker.recognize(image.buffer);
        const parsed = parseKtpOcrText(data.text);
        res.json({ status: 'success', data: parsed, raw_text: data.text });
    } catch (error) {
        console.error('KTP OCR error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        if (worker) await worker.terminate();
    }
});

// ==================== INSERT FUNCTIONS ====================
async function insertPengajuanDetails(transaction, idPengajuan, dataPerorangan = {}, dataUsaha = {}, files = {}, dataUsahaPasangan = {}) {
    if (!dataPerorangan) return;

    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('nama_panggilan', sql.VarChar, dataPerorangan.nama_panggilan || null)
        .input('alamat_debitur', sql.Text, dataPerorangan.alamat_debitur || null)
        .input('alamat_domisili_debitur', sql.Text, dataPerorangan.alamat_domisili_debitur || null)
        .input('domisili_sesuai_ktp_debitur', sql.Bit, dataPerorangan.domisili_sesuai_ktp_debitur || false)
        .input('tempat_lahir', sql.VarChar, dataPerorangan.tempat_lahir || null)
        .input('tanggal_lahir', sql.Date, nullableDate(dataPerorangan.tanggal_lahir))
        .input('agama', sql.VarChar, dataPerorangan.agama || null)
        .input('rt_rw', sql.VarChar, dataPerorangan.rt_rw || null)
        .input('kode_pos', sql.VarChar, dataPerorangan.kode_pos || null)
        .input('email', sql.VarChar, dataPerorangan.email || null)
        .input('nama_ibu_kandung', sql.VarChar, dataPerorangan.nama_ibu_kandung || null)
        .input('tgl_berlaku_ktp', sql.Date, nullableDate(dataPerorangan.tgl_berlaku_ktp))
        .input('ktp_berlaku_seumur_hidup', sql.Bit, dataPerorangan.ktp_berlaku_seumur_hidup || false)
        .input('jenis_kelamin', sql.VarChar, dataPerorangan.jenis_kelamin || null)
        .input('status_menikah', sql.VarChar, dataPerorangan.status_menikah || null)
        .input('status_pendidikan', sql.VarChar, dataPerorangan.status_pendidikan || null)
        .input('provinsi_code', sql.VarChar, dataPerorangan.provinsi_code || null)
        .input('provinsi', sql.VarChar, dataPerorangan.provinsi || null)
        .input('kabupaten_code', sql.VarChar, dataPerorangan.kabupaten_code || null)
        .input('kabupaten', sql.VarChar, dataPerorangan.kabupaten || null)
        .input('kecamatan_code', sql.VarChar, dataPerorangan.kecamatan_code || null)
        .input('kecamatan', sql.VarChar, dataPerorangan.kecamatan || null)
        .input('kelurahan_code', sql.VarChar, dataPerorangan.kelurahan_code || null)
        .input('kelurahan', sql.VarChar, dataPerorangan.kelurahan || null)
        .input('foto_pas_photo', sql.NVarChar, files.foto_pas_photo || null)
        .query(`INSERT INTO t_detail_debitur (id_pengajuan, nama_panggilan, alamat_debitur, alamat_domisili_debitur, domisili_sesuai_ktp_debitur, tempat_lahir, tanggal_lahir, agama, rt_rw, kode_pos, email, nama_ibu_kandung, tgl_berlaku_ktp, ktp_berlaku_seumur_hidup, jenis_kelamin, status_menikah, status_pendidikan, provinsi_code, provinsi, kabupaten_code, kabupaten, kecamatan_code, kecamatan, kelurahan_code, kelurahan, foto_pas_photo) VALUES (@id_pengajuan, @nama_panggilan, @alamat_debitur, @alamat_domisili_debitur, @domisili_sesuai_ktp_debitur, @tempat_lahir, @tanggal_lahir, @agama, @rt_rw, @kode_pos, @email, @nama_ibu_kandung, @tgl_berlaku_ktp, @ktp_berlaku_seumur_hidup, @jenis_kelamin, @status_menikah, @status_pendidikan, @provinsi_code, @provinsi, @kabupaten_code, @kabupaten, @kecamatan_code, @kecamatan, @kelurahan_code, @kelurahan, @foto_pas_photo)`);

    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('nama_panggilan_pasangan', sql.VarChar, dataPerorangan.nama_panggilan_pasangan || null)
        .input('tempat_lahir_pasangan', sql.VarChar, dataPerorangan.tempat_lahir_pasangan || null)
        .input('tanggal_lahir_pasangan', sql.Date, nullableDate(dataPerorangan.tanggal_lahir_pasangan))
        .input('agama_pasangan', sql.VarChar, dataPerorangan.agama_pasangan || null)
        .input('alamat_pasangan', sql.Text, dataPerorangan.alamat_pasangan || null)
        .input('alamat_domisili_pasangan', sql.Text, dataPerorangan.alamat_domisili_pasangan || null)
        .input('domisili_sesuai_ktp_pasangan', sql.Bit, dataPerorangan.domisili_sesuai_ktp_pasangan || false)
        .input('rt_rw_pasangan', sql.VarChar, dataPerorangan.rt_rw_pasangan || null)
        .input('kode_pos_pasangan', sql.VarChar, dataPerorangan.kode_pos_pasangan || null)
        .input('email_pasangan', sql.VarChar, dataPerorangan.email_pasangan || null)
        .input('tgl_berlaku_ktp_pasangan', sql.Date, nullableDate(dataPerorangan.tgl_berlaku_ktp_pasangan))
        .input('ktp_berlaku_seumur_hidup_pasangan', sql.Bit, dataPerorangan.ktp_berlaku_seumur_hidup_pasangan || false)
        .input('jenis_kelamin_pasangan', sql.VarChar, dataPerorangan.jenis_kelamin_pasangan || null)
        .input('provinsi_code_pasangan', sql.VarChar, dataPerorangan.provinsi_code_pasangan || null)
        .input('provinsi_pasangan', sql.VarChar, dataPerorangan.provinsi_pasangan || null)
        .input('kabupaten_code_pasangan', sql.VarChar, dataPerorangan.kabupaten_code_pasangan || null)
        .input('kabupaten_pasangan', sql.VarChar, dataPerorangan.kabupaten_pasangan || null)
        .input('kecamatan_code_pasangan', sql.VarChar, dataPerorangan.kecamatan_code_pasangan || null)
        .input('kecamatan_pasangan', sql.VarChar, dataPerorangan.kecamatan_pasangan || null)
        .input('kelurahan_code_pasangan', sql.VarChar, dataPerorangan.kelurahan_code_pasangan || null)
        .input('kelurahan_pasangan', sql.VarChar, dataPerorangan.kelurahan_pasangan || null)
        .input('foto_pasangan_photo', sql.NVarChar, files.foto_pasangan_photo || null)
        .query(`INSERT INTO t_detail_pasangan_debitur (id_pengajuan, nama_panggilan_pasangan, tempat_lahir_pasangan, tanggal_lahir_pasangan, agama_pasangan, alamat_pasangan, alamat_domisili_pasangan, domisili_sesuai_ktp_pasangan, rt_rw_pasangan, kode_pos_pasangan, email_pasangan, tgl_berlaku_ktp_pasangan, ktp_berlaku_seumur_hidup_pasangan, jenis_kelamin_pasangan, provinsi_code_pasangan, provinsi_pasangan, kabupaten_code_pasangan, kabupaten_pasangan, kecamatan_code_pasangan, kecamatan_pasangan, kelurahan_code_pasangan, kelurahan_pasangan, foto_pasangan_photo) VALUES (@id_pengajuan, @nama_panggilan_pasangan, @tempat_lahir_pasangan, @tanggal_lahir_pasangan, @agama_pasangan, @alamat_pasangan, @alamat_domisili_pasangan, @domisili_sesuai_ktp_pasangan, @rt_rw_pasangan, @kode_pos_pasangan, @email_pasangan, @tgl_berlaku_ktp_pasangan, @ktp_berlaku_seumur_hidup_pasangan, @jenis_kelamin_pasangan, @provinsi_code_pasangan, @provinsi_pasangan, @kabupaten_code_pasangan, @kabupaten_pasangan, @kecamatan_code_pasangan, @kecamatan_pasangan, @kelurahan_code_pasangan, @kelurahan_pasangan, @foto_pasangan_photo)`);

    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('nama_keluarga_1', sql.VarChar, dataPerorangan.nama_keluarga_1 || null)
        .input('hp_keluarga_1', sql.VarChar, dataPerorangan.hp_keluarga_1 || null)
        .input('nama_keluarga_2', sql.VarChar, dataPerorangan.nama_keluarga_2 || null)
        .input('hp_keluarga_2', sql.VarChar, dataPerorangan.hp_keluarga_2 || null)
        .query(`INSERT INTO t_keluarga_tidak_serumah (id_pengajuan, nama_keluarga_1, hp_keluarga_1, nama_keluarga_2, hp_keluarga_2) VALUES (@id_pengajuan, @nama_keluarga_1, @hp_keluarga_1, @nama_keluarga_2, @hp_keluarga_2)`);

    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('form_pekerjaan', sql.VarChar, dataUsaha.form_pekerjaan || null)
        .input('bekerja', sql.VarChar, dataUsaha.bekerja || null)
        .input('nama_perusahaan_kerja', sql.VarChar, dataUsaha.nama_perusahaan_kerja || null)
        .input('jabatan', sql.VarChar, dataUsaha.jabatan || null)
        .input('bidang_usaha', sql.VarChar, dataUsaha.bidang_usaha || null)
        .input('jenis_pekerjaan', sql.VarChar, dataUsaha.jenis_pekerjaan || null)
        .input('lama_bekerja', sql.VarChar, dataUsaha.lama_bekerja || null)
        .input('alamat_kantor', sql.Text, dataUsaha.alamat_kantor || null)
        .input('telp_kantor', sql.VarChar, dataUsaha.telp_kantor || null)
        .input('gaji', sql.VarChar, dataUsaha.gaji || null)
        .input('nama_usaha', sql.VarChar, dataUsaha.nama_usaha || null)
        .input('lama_usaha', sql.VarChar, dataUsaha.lama_usaha || null)
        .input('alamat_usaha', sql.Text, dataUsaha.alamat_usaha || null)
        .input('telp_usaha', sql.VarChar, dataUsaha.telp_usaha || null)
        .input('hasil_usaha', sql.VarChar, dataUsaha.hasil_usaha || null)
        .input('sektor_usaha', sql.VarChar, dataUsaha.sektor_usaha || null)
        .input('nomor_npwp', sql.VarChar, dataUsaha.nomor_npwp || null)
        .input('pekerjaan_slik', sql.VarChar, dataUsaha.pekerjaan_slik || null)
        .input('sektor_ekonomi', sql.VarChar, dataUsaha.sektor_ekonomi || null)
        .input('golongan_debitur', sql.VarChar, dataUsaha.golongan_debitur || null)
        .query(`INSERT INTO t_detail_usaha_debitur (id_pengajuan, form_pekerjaan, bekerja, nama_perusahaan_kerja, jabatan, bidang_usaha, jenis_pekerjaan, lama_bekerja, alamat_kantor, telp_kantor, gaji, nama_usaha, lama_usaha, alamat_usaha, telp_usaha, hasil_usaha, sektor_usaha, nomor_npwp, pekerjaan_slik, sektor_ekonomi, golongan_debitur) VALUES (@id_pengajuan, @form_pekerjaan, @bekerja, @nama_perusahaan_kerja, @jabatan, @bidang_usaha, @jenis_pekerjaan, @lama_bekerja, @alamat_kantor, @telp_kantor, @gaji, @nama_usaha, @lama_usaha, @alamat_usaha, @telp_usaha, @hasil_usaha, @sektor_usaha, @nomor_npwp, @pekerjaan_slik, @sektor_ekonomi, @golongan_debitur)`);

    await insertDetailUsaha(transaction, 't_detail_usaha_pasangan', idPengajuan, dataUsahaPasangan);
}

async function insertDetailUsaha(transaction, tableName, idPengajuan, dataUsaha = {}) {
    if (!dataUsaha) return;
    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('form_pekerjaan', sql.VarChar, dataUsaha.form_pekerjaan || null)
        .input('bekerja', sql.VarChar, dataUsaha.bekerja || null)
        .input('nama_perusahaan_kerja', sql.VarChar, dataUsaha.nama_perusahaan_kerja || null)
        .input('jabatan', sql.VarChar, dataUsaha.jabatan || null)
        .input('bidang_usaha', sql.VarChar, dataUsaha.bidang_usaha || null)
        .input('jenis_pekerjaan', sql.VarChar, dataUsaha.jenis_pekerjaan || null)
        .input('lama_bekerja', sql.VarChar, dataUsaha.lama_bekerja || null)
        .input('alamat_kantor', sql.Text, dataUsaha.alamat_kantor || null)
        .input('telp_kantor', sql.VarChar, dataUsaha.telp_kantor || null)
        .input('gaji', sql.VarChar, dataUsaha.gaji || null)
        .input('nama_usaha', sql.VarChar, dataUsaha.nama_usaha || null)
        .input('lama_usaha', sql.VarChar, dataUsaha.lama_usaha || null)
        .input('alamat_usaha', sql.Text, dataUsaha.alamat_usaha || null)
        .input('telp_usaha', sql.VarChar, dataUsaha.telp_usaha || null)
        .input('hasil_usaha', sql.VarChar, dataUsaha.hasil_usaha || null)
        .input('sektor_usaha', sql.VarChar, dataUsaha.sektor_usaha || null)
        .input('nomor_npwp', sql.VarChar, dataUsaha.nomor_npwp || null)
        .input('pekerjaan_slik', sql.VarChar, dataUsaha.pekerjaan_slik || null)
        .input('sektor_ekonomi', sql.VarChar, dataUsaha.sektor_ekonomi || null)
        .input('golongan_debitur', sql.VarChar, dataUsaha.golongan_debitur || null)
        .query(`INSERT INTO ${tableName} (id_pengajuan, form_pekerjaan, bekerja, nama_perusahaan_kerja, jabatan, bidang_usaha, jenis_pekerjaan, lama_bekerja, alamat_kantor, telp_kantor, gaji, nama_usaha, lama_usaha, alamat_usaha, telp_usaha, hasil_usaha, sektor_usaha, nomor_npwp, pekerjaan_slik, sektor_ekonomi, golongan_debitur) VALUES (@id_pengajuan, @form_pekerjaan, @bekerja, @nama_perusahaan_kerja, @jabatan, @bidang_usaha, @jenis_pekerjaan, @lama_bekerja, @alamat_kantor, @telp_kantor, @gaji, @nama_usaha, @lama_usaha, @alamat_usaha, @telp_usaha, @hasil_usaha, @sektor_usaha, @nomor_npwp, @pekerjaan_slik, @sektor_ekonomi, @golongan_debitur)`);
}

async function insertUploadedFiles(transaction, idPengajuan, savedFiles) {
    for (const file of savedFiles) {
        await new sql.Request(transaction)
            .input('id_pengajuan', sql.VarChar, idPengajuan)
            .input('field_name', sql.VarChar, file.field)
            .input('original_name', sql.VarChar, file.original_name)
            .input('file_name', sql.VarChar, file.filename)
            .input('file_path', sql.VarChar, file.path)
            .input('mime_type', sql.VarChar, file.mimetype)
            .input('file_size', sql.Int, file.size)
            .query(`INSERT INTO t_pengajuan_dokumen (id_pengajuan, field_name, original_name, file_name, file_path, mime_type, file_size) VALUES (@id_pengajuan, @field_name, @original_name, @file_name, @file_path, @mime_type, @file_size)`);
    }
}

async function insertBadanUsaha(transaction, idPengajuan, dataBadanUsaha = {}, files = {}) {
    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('nama_perusahaan', sql.VarChar, dataBadanUsaha.nama_perusahaan || null)
        .input('npwp', sql.VarChar, dataBadanUsaha.npwp || null)
        .input('tgl_berdiri', sql.Date, nullableDate(dataBadanUsaha.tgl_berdiri))
        .input('jenis_badan_usaha', sql.VarChar, dataBadanUsaha.jenis_badan_usaha || dataBadanUsaha.bentuk_usaha || null)
        .input('alamat_perusahaan', sql.Text, dataBadanUsaha.alamat_perusahaan || null)
        .input('alamat_domisili_perusahaan', sql.Text, dataBadanUsaha.alamat_domisili_perusahaan || null)
        .input('no_telp_perusahaan', sql.VarChar, dataBadanUsaha.no_telp_perusahaan || dataBadanUsaha.telp_usaha || null)
        .input('foto_npwp', sql.NVarChar, files.foto_npwp || null)
        .input('nib', sql.VarChar, dataBadanUsaha.nib || null)
        .input('no_akta_pendirian', sql.VarChar, dataBadanUsaha.no_akta_pendirian || null)
        .input('notaris', sql.VarChar, dataBadanUsaha.notaris || null)
        .input('no_sk_kemenhum', sql.VarChar, dataBadanUsaha.no_sk_kemenhum || null)
        .input('tgl_sk_kemenhum', sql.Date, nullableDate(dataBadanUsaha.tgl_sk_kemenhum))
        .input('modal_dasar', sql.Decimal(18, 2), nullableNumber(dataBadanUsaha.modal_dasar))
        .input('rt_rw', sql.VarChar, dataBadanUsaha.rt_rw || null)
        .input('kode_pos', sql.VarChar, dataBadanUsaha.kode_pos || null)
        .input('provinsi_code', sql.VarChar, dataBadanUsaha.provinsi_code || null)
        .input('provinsi', sql.VarChar, dataBadanUsaha.provinsi || null)
        .input('kabupaten_code', sql.VarChar, dataBadanUsaha.kabupaten_code || null)
        .input('kabupaten', sql.VarChar, dataBadanUsaha.kabupaten || null)
        .input('kecamatan_code', sql.VarChar, dataBadanUsaha.kecamatan_code || null)
        .input('kecamatan', sql.VarChar, dataBadanUsaha.kecamatan || null)
        .input('kelurahan_code', sql.VarChar, dataBadanUsaha.kelurahan_code || null)
        .input('kelurahan', sql.VarChar, dataBadanUsaha.kelurahan || null)
        .input('tgl_perubahan', sql.Date, nullableDate(dataBadanUsaha.tgl_perubahan))
        .input('no_akta_perubahan', sql.VarChar, dataBadanUsaha.no_akta_perubahan || null)
        .input('notaris_perubahan', sql.VarChar, dataBadanUsaha.notaris_perubahan || null)
        .input('no_sk_kemenhum_perubahan', sql.VarChar, dataBadanUsaha.no_sk_kemenhum_perubahan || null)
        .input('tgl_sk_kemenhum_perubahan', sql.Date, nullableDate(dataBadanUsaha.tgl_sk_kemenhum_perubahan))
        .input('alasan_perubahan', sql.Text, dataBadanUsaha.alasan_perubahan || null)
        .input('lama_usaha', sql.VarChar, dataBadanUsaha.lama_usaha || null)
        .input('telp_usaha', sql.VarChar, dataBadanUsaha.telp_usaha || null)
        .input('sektor_usaha', sql.VarChar, dataBadanUsaha.sektor_usaha || null)
        .input('nomor_npwp_usaha', sql.VarChar, dataBadanUsaha.nomor_npwp_usaha || null)
        .input('sektor_ekonomi', sql.VarChar, dataBadanUsaha.sektor_ekonomi || null)
        .input('golongan_debitur', sql.VarChar, dataBadanUsaha.golongan_debitur || null)
        .input('pendapatan_usaha', sql.Decimal(18, 2), nullableNumber(dataBadanUsaha.pendapatan_usaha))
        .input('total_penghasilan', sql.Decimal(18, 2), nullableNumber(dataBadanUsaha.total_penghasilan))
        .input('total_biaya', sql.Decimal(18, 2), nullableNumber(dataBadanUsaha.total_biaya))
        .input('file_akta_pendirian', sql.NVarChar, files.file_akta_pendirian || null)
        .query(`INSERT INTO t_debitur_badan_usaha (
            id_pengajuan, nama_perusahaan, npwp, tgl_berdiri, jenis_badan_usaha,
            alamat_perusahaan, alamat_domisili_perusahaan, no_telp_perusahaan, foto_npwp,
            nib, no_akta_pendirian, notaris, no_sk_kemenhum, tgl_sk_kemenhum, modal_dasar,
            rt_rw, kode_pos, provinsi_code, provinsi, kabupaten_code, kabupaten,
            kecamatan_code, kecamatan, kelurahan_code, kelurahan, tgl_perubahan,
            no_akta_perubahan, notaris_perubahan, no_sk_kemenhum_perubahan,
            tgl_sk_kemenhum_perubahan, alasan_perubahan, lama_usaha, telp_usaha,
            sektor_usaha, nomor_npwp_usaha, sektor_ekonomi, golongan_debitur,
            pendapatan_usaha, total_penghasilan, total_biaya, file_akta_pendirian
        ) VALUES (
            @id_pengajuan, @nama_perusahaan, @npwp, @tgl_berdiri, @jenis_badan_usaha,
            @alamat_perusahaan, @alamat_domisili_perusahaan, @no_telp_perusahaan, @foto_npwp,
            @nib, @no_akta_pendirian, @notaris, @no_sk_kemenhum, @tgl_sk_kemenhum, @modal_dasar,
            @rt_rw, @kode_pos, @provinsi_code, @provinsi, @kabupaten_code, @kabupaten,
            @kecamatan_code, @kecamatan, @kelurahan_code, @kelurahan, @tgl_perubahan,
            @no_akta_perubahan, @notaris_perubahan, @no_sk_kemenhum_perubahan,
            @tgl_sk_kemenhum_perubahan, @alasan_perubahan, @lama_usaha, @telp_usaha,
            @sektor_usaha, @nomor_npwp_usaha, @sektor_ekonomi, @golongan_debitur,
            @pendapatan_usaha, @total_penghasilan, @total_biaya, @file_akta_pendirian
        )`);
}

async function insertDataPenghasilan(transaction, idPengajuan, dataPenghasilan) {
    if (!dataPenghasilan) return;
    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('pendapatan_usaha_debitur', sql.Decimal(18, 2), nullableNumber(dataPenghasilan.pendapatan_usaha_debitur))
        .input('total_penghasilan_debitur', sql.Decimal(18, 2), nullableNumber(dataPenghasilan.total_penghasilan_debitur))
        .input('total_biaya_perbulan', sql.Decimal(18, 2), nullableNumber(dataPenghasilan.total_biaya_perbulan))
        .query(`INSERT INTO t_debitur_data_penghasilan (id_pengajuan, pendapatan_usaha_debitur, total_penghasilan_debitur, total_biaya_perbulan) VALUES (@id_pengajuan, @pendapatan_usaha_debitur, @total_penghasilan_debitur, @total_biaya_perbulan)`);
}

async function insertDataKredit(transaction, idPengajuan, dataKredit) {
    if (!dataKredit) return;
    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('referensi', sql.VarChar, dataKredit.referensi || null)
        .input('nama_referensi', sql.VarChar, dataKredit.nama_referensi || null)
        .input('hubungan_dengan_bank', sql.VarChar, dataKredit.hubungan_dengan_bank || null)
        .input('tujuan_penggunaan', sql.VarChar, dataKredit.tujuan_penggunaan || null)
        .input('jumlah_pengajuan_kredit', sql.Decimal(18, 2), nullableNumber(dataKredit.jumlah_pengajuan_kredit))
        .input('jangka_waktu_bulan', sql.Int, nullableInt(dataKredit.jangka_waktu_bulan))
        .input('bunga_per_tahun', sql.Decimal(9, 4), nullableDecimalNumber(dataKredit.bunga_per_tahun))
        .input('jenis_hitung_bunga', sql.VarChar, dataKredit.jenis_hitung_bunga || null)
        .input('jenis_kredit', sql.VarChar, dataKredit.jenis_kredit || null)
        .input('no_rekening_bank_lain', sql.VarChar, dataKredit.no_rekening_bank_lain || null)
        .input('sumber_pembayaran_kredit', sql.VarChar, dataKredit.sumber_pembayaran_kredit || null)
        .input('detail_tujuan', sql.Text, dataKredit.detail_tujuan || null)
        .input('sindikasi', sql.VarChar, dataKredit.sindikasi || null)
        .input('alasan', sql.Text, dataKredit.alasan || null)
        .input('asuransi_jiwa', sql.Bit, dataKredit.asuransi?.asuransi_jiwa || false)
        .input('asuransi_kredit', sql.Bit, dataKredit.asuransi?.asuransi_kredit || false)
        .input('asuransi_lainnya', sql.Bit, dataKredit.asuransi?.lainnya || false)
        .query(`INSERT INTO t_debitur_data_kredit (id_pengajuan, referensi, nama_referensi, hubungan_dengan_bank, tujuan_penggunaan, jumlah_pengajuan_kredit, jangka_waktu_bulan, bunga_per_tahun, jenis_hitung_bunga, jenis_kredit, no_rekening_bank_lain, sumber_pembayaran_kredit, detail_tujuan, sindikasi, alasan, asuransi_jiwa, asuransi_kredit, asuransi_lainnya) VALUES (@id_pengajuan, @referensi, @nama_referensi, @hubungan_dengan_bank, @tujuan_penggunaan, @jumlah_pengajuan_kredit, @jangka_waktu_bulan, @bunga_per_tahun, @jenis_hitung_bunga, @jenis_kredit, @no_rekening_bank_lain, @sumber_pembayaran_kredit, @detail_tujuan, @sindikasi, @alasan, @asuransi_jiwa, @asuransi_kredit, @asuransi_lainnya)`);
}

async function insertJaminan(transaction, idPengajuan, jaminan) {
    if (!jaminan) return;
    await new sql.Request(transaction)
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('jenis_jaminan', sql.VarChar, jaminan.jenis_jaminan || null)
        .input('data_jaminan', sql.NVarChar, JSON.stringify(jaminan))
        .query(`INSERT INTO t_debitur_data_jaminan (id_pengajuan, jenis_jaminan, data_jaminan) VALUES (@id_pengajuan, @jenis_jaminan, @data_jaminan)`);
}

function hasOwnPayload(source, key) {
    return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function mergePreservedFields(oldData = {}, newData = {}, preserveBlank = false) {
    const merged = { ...(oldData || {}), ...(newData || {}) };

    if (preserveBlank) {
        for (const [key, value] of Object.entries(newData || {})) {
            if (value === null || value === undefined || value === '') {
                merged[key] = oldData?.[key] ?? value;
            }
        }
    }

    return merged;
}

function parseStoredJaminanRows(rows = []) {
    return rows.map((row) => {
        try {
            return JSON.parse(row.data_jaminan || '{}');
        } catch (_) {
            return { jenis_jaminan: row.jenis_jaminan || null };
        }
    });
}

// ==================== ENDPOINTS ====================

// POST - Pengajuan Baru
router.post('/api/pengajuan/baru', handleUpload, async (req, res) => {
    let body;
    try {
        body = parsePayload(req);
    } catch (error) {
        return res.status(400).json({ status: 'error', message: 'Payload JSON tidak valid.' });
    }

    const {
        id_pengajuan, jenis_debitur, plafon_pengajuan, tenor_bulan, tgl_pengajuan,
        status_pengajuan, id_ao, catatan_ao, data_perorangan,
        data_badan_usaha, data_usaha, data_usaha_pasangan, stsflag,
        data_penghasilan, data_kredit, list_jaminan = [],
        list_penjamin = [], list_pendiri = []
    } = body;

    if (!id_pengajuan || !jenis_debitur || !id_ao) {
        return res.status(400).json({ status: 'error', message: 'id_pengajuan, jenis_debitur, dan id_ao wajib diisi.' });
    }
    if (jenis_debitur === 'PERORANGAN' && !data_perorangan) {
        return res.status(400).json({ status: 'error', message: 'Data debitur perorangan wajib diisi.' });
    }
    if (jenis_debitur === 'BADAN_USAHA' && !data_badan_usaha) {
        return res.status(400).json({ status: 'error', message: 'Data badan usaha wajib diisi.' });
    }

    // ✅ PERBAIKAN: stsflag default '1', FPK adalah '3'
    const finalStsflag = stsflag || '1';
    const isFpk = finalStsflag === '3';  // PERBAIKAN: hanya '3' yang dianggap FPK

    let transaction;
    let transactionStarted = false;
    let savedFiles = [];

    try {
        console.log('=== UPLOADED FILES ===');
        console.log(`Total files: ${req.files?.length || 0}`);
        req.files?.forEach((file, index) => {
            console.log(`File ${index}: fieldname=${file.fieldname}, originalname=${file.originalname}, size=${file.size}`);
        });

        savedFiles = await saveUploadedFiles(id_pengajuan, req.files);
        console.log('=== SAVED FILES ===');
        savedFiles.forEach(file => {
            console.log(`Saved: field=${file.field}, path=${file.path}`);
        });
        const pool = await getPool();
        await ensureDokumenTable(pool);
        await ensurePengajuanDetailTables(pool);

        transaction = new sql.Transaction(pool);
        await transaction.begin();
        transactionStarted = true;

        // Debug log
        console.log('=== PAYLOAD RECEIVED ===');
        console.log('jenis_debitur:', jenis_debitur);
        console.log('stsflag:', stsflag);
        console.log('finalStsflag:', finalStsflag);
        console.log('isFpk:', isFpk);

        // Insert ke t_pengajuan
        const reqUtama = new sql.Request(transaction);
        await reqUtama
            .input('id_pengajuan', sql.VarChar, id_pengajuan)
            .input('jenis_debitur', sql.VarChar, jenis_debitur)
            .input('plafon_pengajuan', sql.Decimal(18, 2), plafon_pengajuan)
            .input('tenor_bulan', sql.Int, tenor_bulan)
            .input('tgl_pengajuan', sql.DateTime, tgl_pengajuan ? new Date(tgl_pengajuan) : null)
            .input('status_pengajuan', sql.VarChar, status_pengajuan)
            .input('id_ao', sql.VarChar, id_ao)
            .input('catatan_ao', sql.Text, catatan_ao)
            .input('stsflag', sql.VarChar, finalStsflag)
            .query(`INSERT INTO t_pengajuan (id_pengajuan, jenis_debitur, plafon_pengajuan, tenor_bulan, tgl_pengajuan, status_pengajuan, id_ao, catatan_ao, stsflag) 
                    VALUES (@id_pengajuan, @jenis_debitur, @plafon_pengajuan, @tenor_bulan, @tgl_pengajuan, @status_pengajuan, @id_ao, @catatan_ao, @stsflag)`);

        // Perorangan
        if (jenis_debitur === 'PERORANGAN' && data_perorangan) {
            const reqPerorangan = new sql.Request(transaction);
            await reqPerorangan
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('no_ktp', sql.VarChar, data_perorangan.no_ktp)
                .input('nama_debitur', sql.VarChar, data_perorangan.nama_debitur)
                .input('tempat_lahir', sql.VarChar, data_perorangan.tempat_lahir || null)
                .input('tanggal_lahir', sql.Date, nullableDate(data_perorangan.tanggal_lahir))
                .input('jenis_kelamin', sql.VarChar, data_perorangan.jenis_kelamin || null)
                .input('tempat_lahir_pasangan', sql.VarChar, data_perorangan.tempat_lahir_pasangan || null)
                .input('tanggal_lahir_pasangan', sql.Date, nullableDate(data_perorangan.tanggal_lahir_pasangan))
                .input('jenis_kelamin_pasangan', sql.VarChar, data_perorangan.jenis_kelamin_pasangan || null)
                .input('no_hp', sql.VarChar, data_perorangan.no_hp)
                .input('nama_pasangan', sql.VarChar, data_perorangan.nama_pasangan)
                .input('ktp_pasangan', sql.VarChar, data_perorangan.ktp_pasangan)
                .input('no_hp_pasangan', sql.VarChar, data_perorangan.no_hp_pasangan)
                .input('foto_ktp', sql.NVarChar, getFilePath(savedFiles, 'file_debitur'))
                .input('foto_pasangan', sql.NVarChar, getFilePath(savedFiles, 'file_pasangan'))
                .input('foto_kk', sql.NVarChar, getFilePath(savedFiles, 'file_kk'))
                .input('ttd_debitur', sql.NVarChar, data_perorangan.ttd_debitur || null)
                .input('ttd_pasangan', sql.NVarChar, data_perorangan.ttd_pasangan || null)
                .query(`INSERT INTO t_debitur_perorangan 
                    (id_pengajuan, no_ktp, nama_debitur,  no_hp, nama_pasangan, ktp_pasangan, no_hp_pasangan, foto_ktp, 
                    foto_pasangan, foto_kk, ttd_debitur, ttd_pasangan,tempat_lahir, tanggal_lahir,jenis_kelamin, tempat_lahir_pasangan, tanggal_lahir_pasangan,
                     jenis_kelamin_pasangan) 
                    VALUES (@id_pengajuan, @no_ktp, @nama_debitur, @no_hp, @nama_pasangan, @ktp_pasangan, @no_hp_pasangan, @foto_ktp,
                     @foto_pasangan, @foto_kk, @ttd_debitur, @ttd_pasangan,@tempat_lahir, @tanggal_lahir, @jenis_kelamin, @tempat_lahir_pasangan, @tanggal_lahir_pasangan,
                    @jenis_kelamin_pasangan)`);

            if (isFpk) {
                await insertPengajuanDetails(transaction, id_pengajuan, data_perorangan, data_usaha, {
                    foto_pas_photo: getFilePath(savedFiles, 'file_pas_photo'),
                    foto_pasangan_photo: getFilePath(savedFiles, 'file_pasangan_photo'),
                }, data_usaha_pasangan);
                if (data_penghasilan) await insertDataPenghasilan(transaction, id_pengajuan, data_penghasilan);
                if (data_kredit) await insertDataKredit(transaction, id_pengajuan, data_kredit);
                if (list_jaminan && list_jaminan.length > 0) {
                    for (const jaminan of list_jaminan) await insertJaminan(transaction, id_pengajuan, jaminan);
                }
            }
        }
        // Badan Usaha
        else if (jenis_debitur === 'BADAN_USAHA' && data_badan_usaha) {
            await insertBadanUsaha(transaction, id_pengajuan, data_badan_usaha, {
                foto_npwp: getFilePath(savedFiles, 'file_npwp'),
                file_akta_pendirian: getFilePath(savedFiles, 'file_akta_pendirian'),
            });

            if (isFpk) {
                if (data_penghasilan) await insertDataPenghasilan(transaction, id_pengajuan, data_penghasilan);
                if (data_kredit) await insertDataKredit(transaction, id_pengajuan, data_kredit);
                if (list_jaminan && list_jaminan.length > 0) {
                    for (const jaminan of list_jaminan) await insertJaminan(transaction, id_pengajuan, jaminan);
                }
            }
        }

        // Penjamin & Pendiri/Pengurus dikirim juga dari pengajuan awal (stsflag='1').
        {
            if (list_penjamin && list_penjamin.length > 0) {
                for (let index = 0; index < list_penjamin.length; index++) {
                    const penjamin = list_penjamin[index];
                    await new sql.Request(transaction)
                        .input('id_pengajuan', sql.VarChar, id_pengajuan)
                        .input('nama_penjamin', sql.VarChar, penjamin.nama_penjamin || null)
                        .input('ktp_penjamin', sql.VarChar, penjamin.ktp_penjamin || null)
                        .input('hubungan_debitur', sql.VarChar, penjamin.hubungan_debitur || null)
                        .input('no_hp_penjamin', sql.VarChar, penjamin.no_hp_penjamin || null)
                        .input('foto_penjamin', sql.NVarChar, getFilePath(savedFiles, `file_penjamin_${index}`) || penjamin.foto_penjamin_url || null)
                        .input('ttd_penjamin', sql.NVarChar, penjamin.ttd_penjamin || null)
                        .input('tempat_lahir', sql.VarChar, penjamin.tempat_lahir || null)
                        .input('tanggal_lahir', sql.Date, nullableDate(penjamin.tanggal_lahir))
                        .input('jenis_kelamin', sql.VarChar, penjamin.jenis_kelamin || null)
                        .input('tgl_berlaku_ktp', sql.Date, nullableDate(penjamin.tgl_berlaku_ktp))
                        .input('ktp_berlaku_seumur_hidup', sql.Bit, penjamin.ktp_berlaku_seumur_hidup || false)
                        .query(`INSERT INTO t_pengajuan_penjamin 
                            (id_pengajuan, nama_penjamin, ktp_penjamin, hubungan_debitur, no_hp_penjamin, foto_penjamin, ttd_penjamin, tempat_lahir, tanggal_lahir, jenis_kelamin, tgl_berlaku_ktp, ktp_berlaku_seumur_hidup) 
                            VALUES (@id_pengajuan, @nama_penjamin, @ktp_penjamin, @hubungan_debitur, @no_hp_penjamin, @foto_penjamin, @ttd_penjamin, @tempat_lahir, @tanggal_lahir, @jenis_kelamin, @tgl_berlaku_ktp, @ktp_berlaku_seumur_hidup)`);
                }
            }
            if (list_pendiri && list_pendiri.length > 0) {
                for (let index = 0; index < list_pendiri.length; index++) {
                    const pendiri = list_pendiri[index];
                    // ✅ Gunakan field yang benar
                    const fotoPendiriUrl = getFilePath(savedFiles, `file_pendiri_${index}`) || pendiri.foto_pendiri_url || null;

                    await new sql.Request(transaction)
                        .input('id_pengajuan', sql.VarChar, id_pengajuan)
                        .input('nama_pendiri', sql.VarChar, pendiri.nama_pendiri)
                        .input('ktp_pendiri', sql.VarChar, pendiri.ktp_pendiri)
                        .input('jabatan', sql.VarChar, pendiri.jabatan)
                        .input('persentase_saham', sql.Decimal(5, 2), Number(pendiri.persentase_saham) || 0)
                        .input('foto_pendiri', sql.NVarChar, fotoPendiriUrl)
                        .input('ttd_pendiri', sql.NVarChar, pendiri.ttd_pendiri || null)
                        .input('tempat_lahir', sql.VarChar, pendiri.tempat_lahir || null)
                        .input('tanggal_lahir', sql.Date, nullableDate(pendiri.tanggal_lahir))
                        .input('jenis_kelamin', sql.VarChar, pendiri.jenis_kelamin || null)
                        .input('alamat_ktp', sql.Text, pendiri.alamat_ktp || null)
                        .input('alamat_domisili', sql.Text, pendiri.alamat_domisili || null)
                        .input('no_hp', sql.VarChar, pendiri.no_hp || null)
                        .input('tgl_berlaku_ktp', sql.Date, nullableDate(pendiri.tgl_berlaku_ktp))
                        .input('ktp_berlaku_seumur_hidup', sql.Bit, pendiri.ktp_berlaku_seumur_hidup || false)
                        .input('agama', sql.VarChar, pendiri.agama || null)
                        .input('nama_ibu_kandung', sql.VarChar, pendiri.nama_ibu_kandung || null)
                        .query(`INSERT INTO t_pengajuan_pendiri 
                (id_pengajuan, nama_pendiri, ktp_pendiri, jabatan, persentase_saham, foto_pendiri, ttd_pendiri, tempat_lahir, tanggal_lahir, jenis_kelamin, alamat_ktp, alamat_domisili, no_hp, tgl_berlaku_ktp, ktp_berlaku_seumur_hidup, agama, nama_ibu_kandung) 
                VALUES (@id_pengajuan, @nama_pendiri, @ktp_pendiri, @jabatan, @persentase_saham, @foto_pendiri, @ttd_pendiri, @tempat_lahir, @tanggal_lahir, @jenis_kelamin, @alamat_ktp, @alamat_domisili, @no_hp, @tgl_berlaku_ktp, @ktp_berlaku_seumur_hidup, @agama, @nama_ibu_kandung)`);
                }
            }
        }

        await insertUploadedFiles(transaction, id_pengajuan, savedFiles);
        await transaction.commit();

        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id_pengajuan,
            fallback: body,
            targetStsflag: finalStsflag,
            event: 'save',
        });

        res.status(201).json({
            status: 'success',
            message: isFpk ? 'Data Pengajuan FPK berhasil disimpan!' : 'Data Pre FPK berhasil disimpan!',
            files: savedFiles,
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('ERROR SIMPAN:', error);
        await rollbackIfActive(transactionStarted, transaction);
        await cleanupSavedFiles(savedFiles);
        await cleanupUploadFolder(id_pengajuan);
        res.status(500).json({ status: 'error', message: 'Gagal simpan, transaksi dibatalkan: ' + error.message });
    }
});

router.get("/api/pengajuan/file/signed-url", async (req, res) => {
    try {
        const { path } = req.query;

        if (!path) {
            return res.status(400).json({
                success: false,
                message: "Path file wajib diisi",
            });
        }

        const signedUrl = await getSignedB2Url(path, 300);

        res.json({
            success: true,
            url: signedUrl,
            expiresIn: 300,
        });
    } catch (err) {
        console.error("SIGNED URL ERROR:", err);
        res.status(500).json({
            success: false,
            message: "Gagal membuat signed URL",
            error: err.message,
        });
    }
});
// PUT - Update Pengajuan
router.put('/api/pengajuan/:id', handleUpload, async (req, res) => {
    let body;
    try {
        body = parsePayload(req);
    } catch (error) {
        return res.status(400).json({ status: 'error', message: 'Payload JSON tidak valid.' });
    }

    const {
        id_pengajuan, jenis_debitur, plafon_pengajuan, tenor_bulan, tgl_pengajuan,
        status_pengajuan, id_ao, catatan_ao, data_perorangan,
        data_badan_usaha, data_usaha, data_usaha_pasangan, stsflag, data_penghasilan, data_kredit,
        list_jaminan = [], list_penjamin = [], list_pendiri = []
    } = body;

    let transaction;
    let transactionStarted = false;
    let savedFiles = [];

    try {
        savedFiles = await saveUploadedFiles(id_pengajuan, req.files);
        const pool = await getPool();
        await ensureDokumenTable(pool);
        await ensurePengajuanDetailTables(pool);

        transaction = new sql.Transaction(pool);
        await transaction.begin();
        transactionStarted = true;

        const shouldPreserveFpkFields = String(stsflag || '') !== '3';

        // Ambil data lama agar koreksi dari verifikasi tidak menghapus isian FPK.
        const oldData = await new sql.Request(transaction)
            .input('id', sql.VarChar, id_pengajuan)
            .query(`SELECT *,
                           COALESCE(NULLIF(CAST(ttd_debitur AS VARCHAR(MAX)), ''), NULLIF(CAST(ttd_debitur_base64 AS VARCHAR(MAX)), '')) AS effective_ttd_debitur,
                           COALESCE(NULLIF(CAST(ttd_pasangan AS VARCHAR(MAX)), ''), NULLIF(CAST(ttd_pasangan_base64 AS VARCHAR(MAX)), '')) AS effective_ttd_pasangan
                    FROM t_debitur_perorangan WHERE id_pengajuan = @id
                    SELECT * FROM t_debitur_badan_usaha WHERE id_pengajuan = @id
                    SELECT * FROM t_detail_debitur WHERE id_pengajuan = @id
                    SELECT * FROM t_detail_pasangan_debitur WHERE id_pengajuan = @id
                    SELECT * FROM t_keluarga_tidak_serumah WHERE id_pengajuan = @id
                    SELECT * FROM t_detail_usaha_debitur WHERE id_pengajuan = @id
                    SELECT * FROM t_detail_usaha_pasangan WHERE id_pengajuan = @id
                    SELECT * FROM t_debitur_data_penghasilan WHERE id_pengajuan = @id
                    SELECT * FROM t_debitur_data_kredit WHERE id_pengajuan = @id
                    SELECT jenis_jaminan, data_jaminan FROM t_debitur_data_jaminan WHERE id_pengajuan = @id`);

        const oldPerorangan = oldData.recordsets[0][0] || {};
        const oldBU = oldData.recordsets[1][0] || {};
        const oldDetailDebitur = oldData.recordsets[2][0] || {};
        const oldDetailPasangan = oldData.recordsets[3][0] || {};
        const oldKeluarga = oldData.recordsets[4][0] || {};
        const oldUsahaDebitur = oldData.recordsets[5][0] || {};
        const oldUsahaPasangan = oldData.recordsets[6][0] || {};
        const oldPenghasilan = oldData.recordsets[7][0] || null;
        const oldKreditRow = oldData.recordsets[8][0] || null;
        const oldJaminanRows = oldData.recordsets[9] || [];
        const oldKredit = oldKreditRow ? {
            ...oldKreditRow,
            asuransi: {
                asuransi_jiwa: oldKreditRow.asuransi_jiwa,
                asuransi_kredit: oldKreditRow.asuransi_kredit,
                lainnya: oldKreditRow.asuransi_lainnya,
            },
        } : null;
        const effectivePenghasilan = hasOwnPayload(body, 'data_penghasilan') ? data_penghasilan : oldPenghasilan;
        const effectiveKredit = hasOwnPayload(body, 'data_kredit') ? data_kredit : oldKredit;
        const effectiveJaminan = hasOwnPayload(body, 'list_jaminan') ? list_jaminan : parseStoredJaminanRows(oldJaminanRows);

        // Update header
        await new sql.Request(transaction)
            .input('id_pengajuan', sql.VarChar, id_pengajuan)
            .input('jenis_debitur', sql.VarChar, jenis_debitur)
            .input('plafon_pengajuan', sql.Decimal(18, 2), plafon_pengajuan)
            .input('tenor_bulan', sql.Int, tenor_bulan)
            .input('tgl_pengajuan', sql.DateTime, tgl_pengajuan ? new Date(tgl_pengajuan) : null)
            .input('status_pengajuan', sql.VarChar, status_pengajuan)
            .input('catatan_ao', sql.Text, catatan_ao)
            .input('stsflag', sql.VarChar, stsflag || null)
            .query(`UPDATE t_pengajuan SET jenis_debitur = @jenis_debitur, plafon_pengajuan = @plafon_pengajuan, tenor_bulan = @tenor_bulan, tgl_pengajuan = @tgl_pengajuan, status_pengajuan = @status_pengajuan, catatan_ao = @catatan_ao, stsflag = COALESCE(@stsflag, stsflag) WHERE id_pengajuan = @id_pengajuan`);

        // Ambil data penjamin & pendiri lama
        const oldPenjamin = await new sql.Request(transaction)
            .input('id', sql.VarChar, id_pengajuan)
            .query(`SELECT * FROM t_pengajuan_penjamin WHERE id_pengajuan = @id`);
        const oldPendiri = await new sql.Request(transaction)
            .input('id', sql.VarChar, id_pengajuan)
            .query(`SELECT * FROM t_pengajuan_pendiri WHERE id_pengajuan = @id`);
        const shouldPreserveEmptyPenjamin = String(stsflag || '') === '3' && hasOwnPayload(body, 'list_penjamin') && Array.isArray(list_penjamin) && list_penjamin.length === 0;
        const shouldPreserveEmptyPendiri = String(stsflag || '') === '3' && hasOwnPayload(body, 'list_pendiri') && Array.isArray(list_pendiri) && list_pendiri.length === 0;
        const effectivePenjamin = hasOwnPayload(body, 'list_penjamin') && !shouldPreserveEmptyPenjamin ? list_penjamin : oldPenjamin.recordset;
        const effectivePendiri = hasOwnPayload(body, 'list_pendiri') && !shouldPreserveEmptyPendiri ? list_pendiri : oldPendiri.recordset;

        // Delete detail lama
        await new sql.Request(transaction)
            .input('id', sql.VarChar, id_pengajuan)
            .query(`DELETE FROM t_pengajuan_penjamin WHERE id_pengajuan = @id
                    DELETE FROM t_pengajuan_pendiri WHERE id_pengajuan = @id
                    DELETE FROM t_debitur_perorangan WHERE id_pengajuan = @id
                    DELETE FROM t_debitur_badan_usaha WHERE id_pengajuan = @id
                    DELETE FROM t_detail_debitur WHERE id_pengajuan = @id
                    DELETE FROM t_detail_pasangan_debitur WHERE id_pengajuan = @id
                    DELETE FROM t_keluarga_tidak_serumah WHERE id_pengajuan = @id
                    DELETE FROM t_detail_usaha_debitur WHERE id_pengajuan = @id
                    DELETE FROM t_detail_usaha_pasangan WHERE id_pengajuan = @id
                    DELETE FROM t_debitur_data_penghasilan WHERE id_pengajuan = @id
                    DELETE FROM t_debitur_data_kredit WHERE id_pengajuan = @id
                    DELETE FROM t_debitur_data_jaminan WHERE id_pengajuan = @id
                    DELETE FROM t_pengajuan_dokumen WHERE id_pengajuan = @id`);

        // Insert ulang perorangan
        if (jenis_debitur === 'PERORANGAN' && data_perorangan) {
            const mergedPerorangan = mergePreservedFields(
                {
                    ...oldPerorangan,
                    ...oldDetailDebitur,
                    ...oldDetailPasangan,
                    ...oldKeluarga,
                },
                data_perorangan,
                shouldPreserveFpkFields
            );
            // Gunakan file lama jika tidak ada file baru
            const fotoKtp = getFilePath(savedFiles, 'file_debitur') || oldPerorangan.foto_ktp;
            const fotoPasangan = getFilePath(savedFiles, 'file_pasangan') || oldPerorangan.foto_pasangan;
            const fotoKk = getFilePath(savedFiles, 'file_kk') || oldPerorangan.foto_kk;
            const ttdDebitur = getFilePath(savedFiles, 'ttd_debitur') || mergedPerorangan.ttd_debitur || oldPerorangan.effective_ttd_debitur || null;
            const ttdPasangan = getFilePath(savedFiles, 'ttd_pasangan') || mergedPerorangan.ttd_pasangan || oldPerorangan.effective_ttd_pasangan || null;

            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('no_ktp', sql.VarChar, mergedPerorangan.no_ktp)
                .input('nama_debitur', sql.VarChar, mergedPerorangan.nama_debitur)
                .input('tempat_lahir', sql.VarChar, mergedPerorangan.tempat_lahir || null)
                .input('tanggal_lahir', sql.Date, nullableDate(mergedPerorangan.tanggal_lahir))
                .input('jenis_kelamin', sql.VarChar, mergedPerorangan.jenis_kelamin || null)
                .input('tempat_lahir_pasangan', sql.VarChar, mergedPerorangan.tempat_lahir_pasangan || null)
                .input('tanggal_lahir_pasangan', sql.Date, nullableDate(mergedPerorangan.tanggal_lahir_pasangan))
                .input('jenis_kelamin_pasangan', sql.VarChar, mergedPerorangan.jenis_kelamin_pasangan || null)
                .input('no_hp', sql.VarChar, mergedPerorangan.no_hp)
                .input('nama_pasangan', sql.VarChar, mergedPerorangan.nama_pasangan)
                .input('ktp_pasangan', sql.VarChar, mergedPerorangan.ktp_pasangan)
                .input('no_hp_pasangan', sql.VarChar, mergedPerorangan.no_hp_pasangan)
                .input('foto_ktp', sql.NVarChar, fotoKtp)
                .input('foto_pasangan', sql.NVarChar, fotoPasangan)
                .input('foto_kk', sql.NVarChar, fotoKk)
                .input(
                    'ttd_debitur',
                    sql.NVarChar,
                    ttdDebitur
                ).input(
                    'ttd_pasangan',
                    sql.NVarChar,
                    ttdPasangan
                )
                .query(`INSERT INTO t_debitur_perorangan (id_pengajuan, no_ktp, nama_debitur, no_hp, nama_pasangan, ktp_pasangan, no_hp_pasangan, foto_ktp, foto_pasangan, foto_kk, ttd_debitur, ttd_pasangan, ttd_debitur_base64, ttd_pasangan_base64, tempat_lahir, tanggal_lahir, jenis_kelamin, tempat_lahir_pasangan, tanggal_lahir_pasangan, jenis_kelamin_pasangan) 
                    VALUES (@id_pengajuan, @no_ktp, @nama_debitur, @no_hp, @nama_pasangan, @ktp_pasangan, @no_hp_pasangan, @foto_ktp, @foto_pasangan, @foto_kk, @ttd_debitur, @ttd_pasangan, @ttd_debitur, @ttd_pasangan, @tempat_lahir, @tanggal_lahir, @jenis_kelamin, @tempat_lahir_pasangan, @tanggal_lahir_pasangan, @jenis_kelamin_pasangan)`);

            const mergedUsahaDebitur = mergePreservedFields(oldUsahaDebitur, data_usaha, shouldPreserveFpkFields);
            const mergedUsahaPasangan = mergePreservedFields(oldUsahaPasangan, data_usaha_pasangan, shouldPreserveFpkFields);

            await insertPengajuanDetails(transaction, id_pengajuan, mergedPerorangan, mergedUsahaDebitur, {
                foto_pas_photo: getFilePath(savedFiles, 'file_pas_photo') || oldDetailDebitur.foto_pas_photo,
                foto_pasangan_photo: getFilePath(savedFiles, 'file_pasangan_photo') || oldDetailPasangan.foto_pasangan_photo,
            }, mergedUsahaPasangan);
            if (effectivePenghasilan) await insertDataPenghasilan(transaction, id_pengajuan, effectivePenghasilan);
            if (effectiveKredit) await insertDataKredit(transaction, id_pengajuan, effectiveKredit);
            if (effectiveJaminan && effectiveJaminan.length > 0) {
                for (const jaminan of effectiveJaminan) await insertJaminan(transaction, id_pengajuan, jaminan);
            }
        }
        // Insert ulang badan usaha
        else if (jenis_debitur === 'BADAN_USAHA' && data_badan_usaha) {
            const mergedBadanUsaha = mergePreservedFields(oldBU, data_badan_usaha, shouldPreserveFpkFields);
            const fotoNpwp = getFilePath(savedFiles, 'file_npwp') || oldBU.foto_npwp;
            const fileAktaPendirian = getFilePath(savedFiles, 'file_akta_pendirian') || oldBU.file_akta_pendirian;

            await insertBadanUsaha(transaction, id_pengajuan, mergedBadanUsaha, {
                foto_npwp: fotoNpwp,
                file_akta_pendirian: fileAktaPendirian,
            });

            if (effectivePenghasilan) await insertDataPenghasilan(transaction, id_pengajuan, effectivePenghasilan);
            if (effectiveKredit) await insertDataKredit(transaction, id_pengajuan, effectiveKredit);
            if (effectiveJaminan && effectiveJaminan.length > 0) {
                for (const jaminan of effectiveJaminan) await insertJaminan(transaction, id_pengajuan, jaminan);
            }
        }

        // Insert penjamin
        for (let index = 0; index < effectivePenjamin.length; index++) {
            const penjamin = effectivePenjamin[index];
            const oldPenjaminFile = oldPenjamin.recordset.find(x => x.nama_penjamin === penjamin.nama_penjamin);
            const mergedPenjamin = mergePreservedFields(oldPenjaminFile || {}, penjamin, shouldPreserveFpkFields);
            const fotoPenjamin = getFilePath(savedFiles, `file_penjamin_${index}`) || oldPenjaminFile?.foto_penjamin || mergedPenjamin.foto_penjamin_url || mergedPenjamin.foto_penjamin;
            const ttdPenjamin = getFilePath(savedFiles, `ttd_penjamin_${index}`) || mergedPenjamin.ttd_penjamin || oldPenjaminFile?.ttd_penjamin || null;
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('nama_penjamin', sql.VarChar, mergedPenjamin.nama_penjamin)
                .input('tempat_lahir', sql.VarChar, mergedPenjamin.tempat_lahir || null)
                .input('tanggal_lahir', sql.Date, nullableDate(mergedPenjamin.tanggal_lahir))
                .input('jenis_kelamin', sql.VarChar, mergedPenjamin.jenis_kelamin || null)
                .input('ktp_penjamin', sql.VarChar, mergedPenjamin.ktp_penjamin)
                .input('hubungan_debitur', sql.VarChar, mergedPenjamin.hubungan_debitur)
                .input('no_hp_penjamin', sql.VarChar, mergedPenjamin.no_hp_penjamin)
                .input('foto_penjamin', sql.NVarChar, fotoPenjamin)
                .input(
                    'ttd_penjamin',
                    sql.NVarChar,
                    ttdPenjamin
                )
                .input('tgl_berlaku_ktp', sql.Date, nullableDate(mergedPenjamin.tgl_berlaku_ktp))
                .input('ktp_berlaku_seumur_hidup', sql.Bit, mergedPenjamin.ktp_berlaku_seumur_hidup || false)
                .query(`INSERT INTO t_pengajuan_penjamin (id_pengajuan, nama_penjamin, ktp_penjamin, hubungan_debitur, no_hp_penjamin, foto_penjamin,ttd_penjamin,tempat_lahir, tanggal_lahir, jenis_kelamin, tgl_berlaku_ktp, ktp_berlaku_seumur_hidup)
                     VALUES (@id_pengajuan, @nama_penjamin, @ktp_penjamin, @hubungan_debitur, @no_hp_penjamin, @foto_penjamin,@ttd_penjamin,@tempat_lahir, @tanggal_lahir, @jenis_kelamin, @tgl_berlaku_ktp, @ktp_berlaku_seumur_hidup)`);
        }

        // Insert pendiri
        for (let index = 0; index < effectivePendiri.length; index++) {
            const pendiri = effectivePendiri[index];
            const oldPendiriFile = oldPendiri.recordset.find(x => x.nama_pendiri === pendiri.nama_pendiri);
            const mergedPendiri = mergePreservedFields(oldPendiriFile || {}, pendiri, shouldPreserveFpkFields);
            const fotoPendiri = getFilePath(savedFiles, `file_pendiri_${index}`) || oldPendiriFile?.foto_pendiri || mergedPendiri.foto_pendiri_url || mergedPendiri.foto_pendiri;
            const ttdPendiri = getFilePath(savedFiles, `ttd_pendiri_${index}`) || mergedPendiri.ttd_pendiri || oldPendiriFile?.ttd_pendiri || null;
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('nama_pendiri', sql.VarChar, mergedPendiri.nama_pendiri)
                .input('tempat_lahir', sql.VarChar, mergedPendiri.tempat_lahir || null)
                .input('tanggal_lahir', sql.Date, nullableDate(mergedPendiri.tanggal_lahir))
                .input('jenis_kelamin', sql.VarChar, mergedPendiri.jenis_kelamin || null)
                .input('ktp_pendiri', sql.VarChar, mergedPendiri.ktp_pendiri)
                .input('jabatan', sql.VarChar, mergedPendiri.jabatan)
                .input('persentase_saham', sql.Decimal(5, 2), Number(mergedPendiri.persentase_saham) || 0)
                .input('foto_pendiri', sql.NVarChar, fotoPendiri)
                .input('ttd_pendiri', sql.NVarChar, ttdPendiri)
                .input('alamat_ktp', sql.Text, mergedPendiri.alamat_ktp || null)
                .input('alamat_domisili', sql.Text, mergedPendiri.alamat_domisili || null)
                .input('no_hp', sql.VarChar, mergedPendiri.no_hp || null)
                .input('tgl_berlaku_ktp', sql.Date, nullableDate(mergedPendiri.tgl_berlaku_ktp))
                .input('ktp_berlaku_seumur_hidup', sql.Bit, mergedPendiri.ktp_berlaku_seumur_hidup || false)
                .input('agama', sql.VarChar, mergedPendiri.agama || null)
                .input('nama_ibu_kandung', sql.VarChar, mergedPendiri.nama_ibu_kandung || null)
                .query(`INSERT INTO t_pengajuan_pendiri (id_pengajuan, nama_pendiri, ktp_pendiri, jabatan, persentase_saham, foto_pendiri,ttd_pendiri,tempat_lahir, tanggal_lahir, jenis_kelamin, alamat_ktp, alamat_domisili, no_hp, tgl_berlaku_ktp, ktp_berlaku_seumur_hidup, agama, nama_ibu_kandung) 
                    VALUES (@id_pengajuan, @nama_pendiri, @ktp_pendiri, @jabatan, @persentase_saham, @foto_pendiri,@ttd_pendiri,@tempat_lahir, @tanggal_lahir, @jenis_kelamin, @alamat_ktp, @alamat_domisili, @no_hp, @tgl_berlaku_ktp, @ktp_berlaku_seumur_hidup, @agama, @nama_ibu_kandung)`);
        }

        await insertUploadedFiles(transaction, id_pengajuan, savedFiles);
        await transaction.commit();

        const whatsappNotification = stsflag
            ? await notifyWorkflowUsersSafe(pool, {
                idPengajuan: id_pengajuan,
                fallback: body,
                targetStsflag: stsflag,
                event: 'save',
            })
            : { skipped: true, reason: 'Status workflow tidak berubah' };

        res.json({
            status: 'success',
            message: 'Pengajuan berhasil diupdate',
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('UPDATE ERROR:', error);
        await rollbackIfActive(transactionStarted, transaction);
        await cleanupSavedFiles(savedFiles);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET - List Verifikasi (stsflag = '1')
router.get('/api/pengajuan/listVerifikasi', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan, a.tenor_bulan, a.tgl_pengajuan, a.status_pengajuan, a.catatan_ao, a.stsflag,
                   b.nama_debitur, b.no_ktp, b.no_hp, b.nama_pasangan, b.ktp_pasangan, b.no_hp_pasangan, b.foto_ktp, b.foto_pasangan,
                   c.nama_perusahaan, c.npwp, c.alamat_perusahaan, c.no_telp_perusahaan
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.stsflag = '1'
            ORDER BY a.tgl_pengajuan ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('Error di listVerifikasi:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST - Verifikasi DUKCAPIL (dengan upload multiple file)
router.post('/api/pengajuan/verifikasi/:id', handleUpload, async (req, res) => {
    const { id } = req.params;
    let savedFiles = [];
    let body;
    try {
        body = JSON.parse(req.body.payload);
    } catch (error) {
        body = req.body;
    }

    const {
        status_debitur,
        status_pasangan,
        status_penjamin = {},
        status_pendiri = {},
        catatan_admin,
        catatan_debitur,
        catatan_pasangan,
        catatan_penjamin = {},
        catatan_pendiri = {}
    } = body;
    const catatanDebitur = catatan_debitur ?? catatan_admin ?? null;
    const catatanPasangan = catatan_pasangan ?? null;

    try {
        const pool = await getPool();
        await ensurePengajuanDukcapilTable(pool);
        await ensureVerifikasiDukcapilColumns(pool);

        // Simpan file yang diupload
        if (req.files && req.files.length > 0) {
            savedFiles = await saveUploadedFiles(id, req.files);
        }

        // Helper function untuk mendapatkan path file
        const getFilePath = (fieldName) => {
            const file = savedFiles.find(f => f.field === fieldName);
            return file ? file.path : null;
        };
        const dukcapilColumnMeta = await getTableColumnMeta(pool, 't_pengajuan_dukcapil');
        const existingDukcapilRows = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT jenis, index_ke, file_hasil_dukcapil
                FROM (
                    SELECT jenis, index_ke, file_hasil_dukcapil,
                           ROW_NUMBER() OVER (PARTITION BY jenis, index_ke ORDER BY created_at DESC) AS rn
                    FROM t_pengajuan_dukcapil
                    WHERE id_pengajuan = @id
                      AND jenis IN ('PENJAMIN', 'PENGURUS', 'PENDIRI')
                ) x
                WHERE rn = 1
            `);
        const getExistingDukcapilFile = (jenis, indexKe) => {
            const normalized = (jenis || '').toUpperCase();
            const row = existingDukcapilRows.recordset.find((item) => {
                const itemJenis = (item.jenis || '').toUpperCase();
                const sameJenis =
                    itemJenis === normalized ||
                    (normalized === 'PENGURUS' && itemJenis === 'PENDIRI') ||
                    (normalized === 'PENDIRI' && itemJenis === 'PENGURUS');
                return sameJenis && Number(item.index_ke) === Number(indexKe);
            });
            return row?.file_hasil_dukcapil || null;
        };

        const penjaminIds = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_penjamin
                FROM t_pengajuan_penjamin
                WHERE id_pengajuan = @id
                ORDER BY id_penjamin ASC
            `);
        const pendiriIds = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_pendiri
                FROM t_pengajuan_pendiri
                WHERE id_pengajuan = @id
                ORDER BY id_pendiri ASC
            `);

        // Simpan ke tabel verifikasi utama
        await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .input('status_debitur', sql.Bit, status_debitur)
            .input('status_pasangan', sql.Bit, status_pasangan || null)
            .input('catatan_admin', sql.Text, catatan_admin || null)
            .input('catatan_admin_debitur', sql.Text, catatanDebitur || null)
            .input('catatan_admin_pasangan', sql.Text, catatanPasangan || null)
            .input('file_hasil_dukcapil_debitur', sql.NVarChar, getFilePath('file_dukcapil_debitur'))
            .input('file_hasil_dukcapil_pasangan', sql.NVarChar, getFilePath('file_dukcapil_pasangan'))
            .input('verified_by', sql.VarChar, 'ADMIN')
            .query(`INSERT INTO t_verifikasi_dukcapil (id_pengajuan, status_debitur, status_pasangan, catatan_admin, catatan_admin_debitur, catatan_admin_pasangan, file_hasil_dukcapil_debitur, file_hasil_dukcapil_pasangan, verified_by) 
                    VALUES (@id_pengajuan, @status_debitur, @status_pasangan, @catatan_admin, @catatan_admin_debitur, @catatan_admin_pasangan, @file_hasil_dukcapil_debitur, @file_hasil_dukcapil_pasangan, @verified_by)`);

        // Simpan status penjamin
        for (const [index, status] of Object.entries(status_penjamin)) {
            const indexKe = parseInt(index);
            const idPenjamin = penjaminIds.recordset[indexKe]?.id_penjamin;
            const filePath =
                getFilePath(`file_dukcapil_penjamin_${index}`) ||
                getExistingDukcapilFile('PENJAMIN', indexKe);
            await insertPengajuanDukcapil(pool, dukcapilColumnMeta, {
                id_pengajuan: id,
                id_penjamin: idPenjamin,
                id_pendiri: null,
                jenis: 'PENJAMIN',
                index_ke: indexKe,
                status_dukcapil: status,
                file_hasil_dukcapil: filePath,
                catatan_admin: catatan_penjamin?.[index] || null,
                verified_by: 'ADMIN',
                created_at: new Date(),
            });
        }

        // Simpan status pengurus/pendiri badan usaha
        for (const [index, status] of Object.entries(status_pendiri)) {
            const indexKe = parseInt(index);
            const idPendiri = pendiriIds.recordset[indexKe]?.id_pendiri;
            const filePath =
                getFilePath(`file_dukcapil_pendiri_${index}`) ||
                getExistingDukcapilFile('PENGURUS', indexKe);
            await insertPengajuanDukcapil(pool, dukcapilColumnMeta, {
                id_pengajuan: id,
                id_penjamin: null,
                id_pendiri: idPendiri,
                jenis: 'PENGURUS',
                index_ke: indexKe,
                status_dukcapil: status,
                file_hasil_dukcapil: filePath,
                catatan_admin: catatan_pendiri?.[index] || null,
                verified_by: 'ADMIN',
                created_at: new Date(),
            });
        }

        // Update stsflag menjadi '2' (Pre FPK)
        await pool.request()
            .input('id', sql.VarChar, id)
            .input('stsflag', sql.VarChar, '2')
            .query(`UPDATE t_pengajuan SET stsflag = @stsflag WHERE id_pengajuan = @id`);

        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id,
            targetStsflag: '2',
            event: 'save',
        });

        res.json({
            status: 'success',
            message: 'Verifikasi berhasil',
            stsflag: '2',
            files_saved: savedFiles.length,
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('Verifikasi error:', error);
        await cleanupSavedFiles(savedFiles);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET - List Pengajuan (stsflag = '1')
router.get('/api/pengajuan/list', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan, a.status_pengajuan,
                   CASE WHEN a.jenis_debitur = 'PERORANGAN' THEN b.nama_debitur ELSE c.nama_perusahaan END AS nama
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.stsflag = '1'
            ORDER BY a.id_pengajuan DESC
        `);
        res.json(result.recordset);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET - List FPK (stsflag = '2')
router.get('/api/pengajuan/listFpk', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan, a.status_pengajuan,
                   CASE WHEN a.jenis_debitur = 'PERORANGAN' THEN b.nama_debitur ELSE c.nama_perusahaan END AS nama
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.stsflag = '2'
            ORDER BY a.id_pengajuan DESC
        `);
        res.json(result.recordset);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// GET - List Checklist Kelengkapan (stsflag = '3')
router.get('/api/pengajuan/listCheckKelengkapan', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan, a.status_pengajuan,
                   CASE WHEN a.jenis_debitur = 'PERORANGAN' THEN b.nama_debitur ELSE c.nama_perusahaan END AS nama
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.stsflag = '3'
            ORDER BY a.id_pengajuan DESC
        `);
        res.json(result.recordset);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

async function updatePengajuanStsflag(pool, idPengajuan, stsflag) {
    await pool.request()
        .input('id_pengajuan', sql.VarChar, idPengajuan)
        .input('stsflag', sql.VarChar, String(stsflag))
        .query(`
            UPDATE t_pengajuan
            SET stsflag = @stsflag
            WHERE id_pengajuan = @id_pengajuan
        `);
}

async function getPengajuanListByStsflag(pool, stsflag) {
    return pool.request()
        .input('stsflag', sql.VarChar, String(stsflag))
        .query(`
            SELECT a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan, a.status_pengajuan,
                   CASE WHEN a.jenis_debitur = 'PERORANGAN' THEN b.nama_debitur ELSE c.nama_perusahaan END AS nama
            FROM t_pengajuan a
            LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
            LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
            WHERE a.stsflag = @stsflag
            ORDER BY a.id_pengajuan DESC
        `);
}

function workflowListRoute(path, stsflag) {
    router.get(path, async (req, res) => {
        try {
            const pool = await getPool();
            const result = await getPengajuanListByStsflag(pool, stsflag);
            res.json(result.recordset);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
}

workflowListRoute('/api/pengajuan/listRekapAnalisa', '4');
workflowListRoute('/api/pengajuan/listSurveyDebitur', '5');
workflowListRoute('/api/pengajuan/listSurveyAgunan', '6');
workflowListRoute('/api/pengajuan/listMUK', '7');

router.get('/api/pengajuan/:id/muk', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        await ensureMukTable(pool);
        await ensureRekapAnalisaTable(pool);
        const result = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT TOP 1 muk_data, created_at, updated_at
                FROM t_pengajuan_muk
                WHERE id_pengajuan = @id_pengajuan
                ORDER BY ISNULL(updated_at, created_at) DESC
            `);

        const row = result.recordset[0];
        res.json({
            status: 'success',
            data: row?.muk_data ? JSON.parse(row.muk_data) : null,
        });
    } catch (error) {
        console.error('GET MUK error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/mutasi/upload', handleSingleMutasiUpload, async (req, res) => {
    const { id } = req.params;
    const { bank, periode, password } = req.body || {};
    let savedFiles = [];

    try {
        if (!bank || !periode) {
            return res.status(400).json({ status: 'error', message: 'Bank dan periode wajib diisi' });
        }

        if (!req.file) {
            return res.status(400).json({ status: 'error', message: 'File PDF mutasi wajib dipilih' });
        }

        if (path.extname(req.file.originalname).toLowerCase() !== '.pdf') {
            return res.status(400).json({ status: 'error', message: 'Mutasi rekening harus berupa file PDF' });
        }

        let pdfData;
        try {
            pdfData = await pdfParse(req.file.buffer, { password: password || undefined });
        } catch (error) {
            return res.status(400).json({
                status: 'error',
                message: 'Gagal membaca PDF. Periksa password atau file rusak.',
            });
        }

        const transaksi = parseMutasiByBank(bank, pdfData.text);
        if (!transaksi) {
            return res.status(400).json({ status: 'error', message: 'Bank tidak didukung' });
        }

        if (transaksi.length === 0) {
            const textPreview = pdfData.text
                .split('\n')
                .map((line) => line.replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(0, 25);

            return res.status(422).json({
                status: 'error',
                message: 'Tidak ada transaksi yang berhasil diparsing. Format mungkin tidak dikenali.',
                debug: {
                    fileName: req.file.originalname,
                    bank,
                    textPreview,
                },
            });
        }

        const pool = await getPool();
        await ensureMutasiRekeningTables(pool);
        savedFiles = await saveUploadedFiles(id, [
            {
                ...req.file,
                fieldname: 'mutasi_rekening',
            },
        ]);

        const savedFile = savedFiles[0];
        const mutasiData = {
            bank: String(bank).toUpperCase(),
            periode,
            fileName: req.file.originalname,
            filePath: savedFile?.path || null,
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            uploadedAt: new Date().toISOString(),
            transaksi,
        };

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const insertMutasi = await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, id)
                .input('bank', sql.VarChar, mutasiData.bank)
                .input('periode', sql.VarChar, periode)
                .input('original_name', sql.NVarChar, savedFile?.original_name || req.file.originalname)
                .input('file_name', sql.NVarChar, savedFile?.filename || req.file.originalname)
                .input('file_path', sql.NVarChar, savedFile?.path || null)
                .input('mime_type', sql.VarChar, req.file.mimetype || null)
                .input('file_size', sql.Int, req.file.size || null)
                .query(`
                    INSERT INTO t_pengajuan_mutasi_rekening
                        (id_pengajuan, bank, periode, original_name, file_name,
                         file_path, mime_type, file_size, uploaded_at, created_at)
                    OUTPUT INSERTED.id_mutasi
                    VALUES
                        (@id_pengajuan, @bank, @periode, @original_name, @file_name,
                         @file_path, @mime_type, @file_size, GETDATE(), GETDATE())
                `);

            const idMutasi = insertMutasi.recordset[0]?.id_mutasi;

            for (let index = 0; index < transaksi.length; index++) {
                const row = transaksi[index] || {};
                await new sql.Request(transaction)
                    .input('id_mutasi', sql.Int, idMutasi)
                    .input('id_pengajuan', sql.VarChar, id)
                    .input('urutan', sql.Int, index + 1)
                    .input('tanggal', sql.Date, sqlDateOrNull(row.tanggal))
                    .input('keterangan', sql.NVarChar, row.keterangan || null)
                    .input('debit', sql.Decimal(18, 2), nullableNumber(row.debit))
                    .input('kredit', sql.Decimal(18, 2), nullableNumber(row.kredit))
                    .input('saldo', sql.Decimal(18, 2), nullableNumber(row.saldo))
                    .query(`
                        INSERT INTO t_pengajuan_mutasi_transaksi
                            (id_mutasi, id_pengajuan, urutan, tanggal, keterangan,
                             debit, kredit, saldo, created_at)
                        VALUES
                            (@id_mutasi, @id_pengajuan, @urutan, @tanggal, @keterangan,
                             @debit, @kredit, @saldo, GETDATE())
                    `);
            }

            await transaction.commit();
            mutasiData.id_mutasi = idMutasi;
        } catch (error) {
            await transaction.rollback();
            throw error;
        }


        res.json({
            status: 'success',
            message: 'Mutasi rekening berhasil diupload',
            data: mutasiData,
        });
    } catch (error) {
        if (savedFiles.length) {
            await cleanupSavedFiles(savedFiles);
        }
        console.error('UPLOAD MUTASI error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.delete('/api/pengajuan/:id/mutasi/:idMutasi', async (req, res) => {
    const { id, idMutasi } = req.params;

    try {
        const pool = await getPool();
        await ensureMutasiRekeningTables(pool);

        await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .input('id_mutasi', sql.Int, Number(idMutasi))
            .query(`
                DELETE FROM t_pengajuan_mutasi_transaksi
                WHERE id_pengajuan = @id_pengajuan
                  AND id_mutasi = @id_mutasi;

                DELETE FROM t_pengajuan_mutasi_rekening
                WHERE id_pengajuan = @id_pengajuan
                  AND id_mutasi = @id_mutasi;
            `);

        res.json({
            status: 'success',
            message: 'Mutasi berhasil dihapus',
        });
    } catch (error) {
        console.error('DELETE MUTASI error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.get('/api/pengajuan/:id/mutasi', async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await getPool();
        await ensureMutasiRekeningTables(pool);

        const mutasiResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT id_mutasi, id_pengajuan, bank, periode, original_name,
                       file_name, file_path, mime_type, file_size, uploaded_at, created_at
                FROM t_pengajuan_mutasi_rekening
                WHERE id_pengajuan = @id_pengajuan
                ORDER BY id_mutasi DESC
            `);

        const transaksiResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT id_transaksi, id_mutasi, urutan, tanggal, keterangan,
                       debit, kredit, saldo
                FROM t_pengajuan_mutasi_transaksi
                WHERE id_pengajuan = @id_pengajuan
                ORDER BY id_mutasi DESC, urutan ASC, id_transaksi ASC
            `);

        const transaksiByMutasi = new Map();

        for (const row of transaksiResult.recordset || []) {
            if (!transaksiByMutasi.has(row.id_mutasi)) {
                transaksiByMutasi.set(row.id_mutasi, []);
            }

            transaksiByMutasi.get(row.id_mutasi).push({
                id_transaksi: row.id_transaksi,
                tanggal: row.tanggal,
                keterangan: row.keterangan,
                debit: row.debit,
                kredit: row.kredit,
                saldo: row.saldo,
            });
        }

        const data = (mutasiResult.recordset || []).map((row) => ({
            id_mutasi: row.id_mutasi,
            bank: row.bank,
            periode: row.periode,
            fileName: row.original_name || row.file_name,
            filePath: row.file_path,
            file: row.original_name || row.file_name,
            file_path: row.file_path,
            mimeType: row.mime_type,
            fileSize: row.file_size,
            uploadedAt: row.uploaded_at || row.created_at,
            transaksi: transaksiByMutasi.get(row.id_mutasi) || [],
        }));

        res.json({ status: 'success', data });
    } catch (error) {
        console.error('GET MUTASI error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});




router.get('/api/pengajuan/:id/muk-usaha', async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await getPool();

        const result = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT
          du.bekerja,
          du.nama_perusahaan_kerja,
          du.jabatan,
          du.lama_bekerja,
          du.gaji,
          du.nama_usaha,
          du.lama_usaha,
          du.alamat_usaha,
          du.telp_usaha,
          du.sektor_usaha,

          up.bekerja AS bekerja_pasangan,
up.nama_perusahaan_kerja AS nama_perusahaan_kerja_pasangan,
up.jabatan AS jabatan_pasangan,
up.lama_bekerja AS lama_bekerja_pasangan,
up.gaji AS gaji_pasangan,
up.nama_usaha AS nama_usaha_pasangan,
up.lama_usaha AS lama_usaha_pasangan,
up.alamat_usaha AS alamat_usaha_pasangan,
up.telp_usaha AS telp_usaha_pasangan,
up.sektor_usaha AS sektor_usaha_pasangan
        FROM t_pengajuan p
           LEFT JOIN t_detail_usaha_debitur du
          ON p.id_pengajuan = CAST(du.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_detail_usaha_pasangan up
          ON p.id_pengajuan = CAST(up.id_pengajuan AS VARCHAR(50))
        WHERE p.id_pengajuan = @id_pengajuan
      `);

        res.json({
            status: 'success',
            data: result.recordset[0] || {},
        });
    } catch (error) {
        console.error('GET MUK Usaha error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message,
        });
    }
});

router.post('/api/pengajuan/:id/muk-usaha/narasi', async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await getPool();

        const result = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT
          du.bekerja,
          du.nama_perusahaan_kerja,
          du.jabatan,
          du.lama_bekerja,
          du.gaji,

          up.bekerja AS bekerja_pasangan,
          up.nama_perusahaan_kerja AS nama_perusahaan_kerja_pasangan,
          up.jabatan AS jabatan_pasangan,
          up.lama_bekerja AS lama_bekerja_pasangan,
          up.gaji AS gaji_pasangan
        FROM t_pengajuan p
        LEFT JOIN t_detail_usaha_debitur du
          ON p.id_pengajuan = CAST(du.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_detail_usaha_pasangan up
          ON p.id_pengajuan = CAST(up.id_pengajuan AS VARCHAR(50))
        WHERE p.id_pengajuan = @id_pengajuan
      `);

        const data = result.recordset[0] || {};

        const narasi = [
            `Debitur bekerja sebagai ${val(data.bekerja)} pada ${val(data.nama_perusahaan_kerja)} dengan jabatan ${val(data.jabatan)} dan masa kerja ${val(data.lama_bekerja)} tahun. Debitur memperoleh penghasilan sebesar Rp ${formatAngkaRupiah(data.gaji)} per bulan.`,
            `Pasangan debitur bekerja sebagai ${val(data.bekerja_pasangan)} pada ${val(data.nama_perusahaan_kerja_pasangan)} dengan jabatan ${val(data.jabatan_pasangan)} dan masa kerja ${val(data.lama_bekerja_pasangan)} tahun. Pasangan memperoleh penghasilan sebesar Rp ${formatAngkaRupiah(data.gaji_pasangan)} per bulan.`,
            `Berdasarkan data pekerjaan dan penghasilan tersebut, sumber pendapatan keluarga berasal dari penghasilan debitur dan pasangan. Kondisi ini menjadi salah satu pertimbangan dalam menilai kemampuan bayar calon debitur terhadap fasilitas kredit yang diajukan.`,
        ].join('\n');

        res.json({
            status: 'success',
            data: {
                narasi,
            },
        });
    } catch (error) {
        console.error('GENERATE MUK USAHA NARASI error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message,
        });
    }
});

router.get('/api/pengajuan/:id/slik-owners', async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;

        const result = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_slik, slik_data, created_at
                FROM t_pengajuan_slik
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
                ORDER BY created_at DESC
            `);

        const owners = new Map();

        for (const row of result.recordset || []) {
            let data = {};
            try {
                data = typeof row.slik_data === 'string'
                    ? JSON.parse(row.slik_data)
                    : row.slik_data || {};
            } catch (_) {
                data = {};
            }

            const jenis = (data.jenis || data.jenis_pemilik || 'DEBITUR')
                .toString()
                .toUpperCase()
                .trim();

            const nama = (data.nama_debitur || data.nama || data.nama_pemilik || '')
                .toString()
                .trim();

            if (!nama) continue;

            const key = `${jenis}|${nama}`;

            if (!owners.has(key)) {
                owners.set(key, {
                    jenis,
                    nama,
                    jumlah: 0,
                });
            }

            owners.get(key).jumlah += 1;
        }

        res.json({
            status: 'success',
            data: [...owners.values()],
        });
    } catch (error) {
        console.error('GET slik owners error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.get('/api/pengajuan/:id/slik-owner-detail', async (req, res) => {
    try {
        const pool = await getPool();
        const { id } = req.params;
        const jenisFilter = (req.query.jenis || '').toString().toUpperCase().trim();
        const namaFilter = (req.query.nama || '').toString().toUpperCase().trim();

        const result = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_slik, slik_data, created_at
                FROM t_pengajuan_slik
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
                ORDER BY created_at DESC
            `);

        const rows = [];

        for (const row of result.recordset || []) {
            let data = {};
            try {
                data = typeof row.slik_data === 'string'
                    ? JSON.parse(row.slik_data)
                    : row.slik_data || {};
            } catch (_) {
                data = {};
            }

            const jenis = (data.jenis || data.jenis_pemilik || 'DEBITUR')
                .toString()
                .toUpperCase()
                .trim();

            const nama = (data.nama_debitur || data.nama || data.nama_pemilik || '')
                .toString()
                .toUpperCase()
                .trim();

            if (jenisFilter && jenis !== jenisFilter) continue;
            if (namaFilter && nama !== namaFilter) continue;

            rows.push({
                ...data,
                id_slik: row.id_slik,
                id_pengajuan: id,
                jenis_pemilik: jenis,
                nama: data.nama_debitur || data.nama || data.nama_pemilik || '',
            });
        }

        res.json({
            status: 'success',
            data: rows,
        });
    } catch (error) {
        console.error('GET slik owner detail error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/muk-usaha/analisakemampuan', async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await getPool();

        const result = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT TOP 1
                    p.id_pengajuan,
                    p.plafon_pengajuan,
                    p.tenor_bulan,

                    dp.nama_debitur,
                    dp.no_ktp,
                    dp.no_hp,
                    dp.nama_pasangan,
                    dp.ktp_pasangan,
                    
                    dd.nama_ibu_kandung,
                    dd.tgl_berlaku_ktp,
                    dd.ktp_berlaku_seumur_hidup,
                    dd.status_menikah,
                    dd.status_pendidikan,
                    dd.alamat_debitur,
                    dd.alamat_domisili_debitur,
                    dd.tanggal_lahir,

                    dps.tgl_berlaku_ktp_pasangan,
                    dps.ktp_berlaku_seumur_hidup_pasangan,
                    dps.tanggal_lahir_pasangan,
                    dps.alamat_pasangan,
                    dps.alamat_domisili_pasangan,

                    ud.gaji AS gaji_debitur,
                    up.gaji AS gaji_pasangan,
                    up.bekerja AS pekerjaan_pasangan,

                    ph.pendapatan_usaha_debitur,
                    ph.total_penghasilan_debitur,
                    ph.total_biaya_perbulan,

                    dk.bunga_per_tahun,
                    dk.jenis_hitung_bunga,
                    dk.detail_tujuan,
					dk.sumber_pembayaran_kredit,
                    dk.no_rekening_bank_lain,
                    (
                    SELECT COUNT(nama)
                    FROM t_pengajuan_survey_debitur_tanggungan tg
                    WHERE tg.id_pengajuan = p.id_pengajuan
                ) AS jumlah_tanggungan
                FROM t_pengajuan p
                LEFT JOIN t_debitur_perorangan dp
                    ON p.id_pengajuan = CAST(dp.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_debitur dd
                    ON p.id_pengajuan = CAST(dd.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_pasangan_debitur dps
                    ON p.id_pengajuan = CAST(dps.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_usaha_debitur ud
                    ON p.id_pengajuan = CAST(ud.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_usaha_pasangan up
                    ON p.id_pengajuan = CAST(up.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_debitur_data_penghasilan ph
                    ON p.id_pengajuan = CAST(ph.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_debitur_data_kredit dk
                    ON p.id_pengajuan = CAST(dk.id_pengajuan AS VARCHAR(50))
                WHERE p.id_pengajuan = @id_pengajuan
            `);

        const row = result.recordset[0];

        if (!row) {
            return res.status(404).json({
                status: 'error',
                message: 'Data pengajuan tidak ditemukan',
            });
        }

        const umur = (tanggal) => {
            if (!tanggal) return null;
            const tgl = new Date(tanggal);
            const now = new Date();
            let age = now.getFullYear() - tgl.getFullYear();
            const m = now.getMonth() - tgl.getMonth();
            if (m < 0 || (m === 0 && now.getDate() < tgl.getDate())) age--;
            return age;
        };

        const bulanRate = Number(row.bunga_per_tahun || 0) / 100 / 12;
        const plafon = Number(row.plafon_pengajuan || 0);
        const tenor = Number(row.tenor_bulan || 0);

        let angsuranBaru = 0;
        if (plafon > 0 && tenor > 0) {
            const jenis = String(row.jenis_hitung_bunga || '').toLowerCase();

            if (jenis.includes('flat') || bulanRate <= 0) {
                angsuranBaru = (plafon / tenor) + (plafon * bulanRate);
            } else {
                const factor = Math.pow(1 + bulanRate, tenor);
                angsuranBaru = plafon * bulanRate * factor / (factor - 1);
            }
        }

        const gajiDebitur = Number(row.gaji_debitur || 0);
        const gajiPasangan = Number(row.gaji_pasangan || 0);
        const pendapatanUsaha = Number(row.pendapatan_usaha_debitur || 0);
        const totalPenghasilanInput = Number(row.total_penghasilan_debitur || 0);
        const totalPengeluaran = Number(row.total_biaya_perbulan || 0);

        const totalPendapatan = totalPenghasilanInput > 0
            ? totalPenghasilanInput
            : gajiDebitur + gajiPasangan + pendapatanUsaha;

        const kewajibanExisting = 0;
        const kewajibanExistingPenjamin = 0;

        const pendapatanBersih =
            totalPendapatan - totalPengeluaran - kewajibanExisting - kewajibanExistingPenjamin;

        const totalAngsuran = kewajibanExisting + angsuranBaru;

        const dsr = pendapatanBersih > 0
            ? (totalAngsuran / pendapatanBersih) * 100
            : 0;

        const statusKelayakan = dsr <= 75 ? 'LAYAK' : 'TIDAK LAYAK';
        const tanggunganResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT 
                    nama,
                    usia,
                    pendidikan
                FROM t_pengajuan_survey_debitur_tanggungan
                WHERE id_pengajuan = @id_pengajuan
                ORDER BY nama
            `);
        const biayaPendapatanResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
    SELECT 
      jenis,
      urutan,
      keterangan,
      nominal
    FROM t_pengajuan_survey_debitur_biaya_pendapatan
    WHERE id_pengajuan = @id_pengajuan
    ORDER BY jenis, urutan, id_biaya_pendapatan
  `);

        const listPendapatanLainnya = biayaPendapatanResult.recordset.filter((row) =>
            String(row.jenis || '').trim().toUpperCase() === 'PENDAPATAN'
        );

        const listPengeluaran = biayaPendapatanResult.recordset.filter((row) =>
            String(row.jenis || '').trim().toUpperCase() === 'PENGELUARAN'
        );

        const totalPendapatanLainnya = listPendapatanLainnya.reduce(
            (sum, row) => sum + Number(row.nominal || 0),
            0
        );

        const totalPengeluaranDasar = Number(row.total_biaya_perbulan || 0);

        const totalPengeluaranSurvey = listPengeluaran.reduce(
            (sum, row) => sum + Number(row.nominal || 0),
            0
        );
        const tanggunganList = tanggunganResult.recordset || [];
        return res.json({
            status: 'success',
            data: {
                nama_pemohon: row.nama_debitur,
                umur_pemohon: umur(row.tanggal_lahir),
                ktp_pemohon: row.no_ktp,
                berlaku_ktp_pemohon: row.ktp_berlaku_seumur_hidup
                    ? 'Seumur Hidup'
                    : row.tgl_berlaku_ktp,
                status_pemohon: row.status_menikah,
                no_hp_pemohon: row.no_hp,
                pendidikan_terakhir: row.status_pendidikan,

                nama_pasangan: row.nama_pasangan,
                umur_pasangan: umur(row.tanggal_lahir_pasangan),
                ktp_pasangan: row.ktp_pasangan,
                berlaku_ktp_pasangan: row.ktp_berlaku_seumur_hidup_pasangan
                    ? 'Seumur Hidup'
                    : row.tgl_berlaku_ktp_pasangan,
                pekerjaan_pasangan: row.pekerjaan_pasangan,

                nama_gadis_ibu_kandung: row.nama_ibu_kandung,
                alamat_tempat_tinggal:
                    row.alamat_domisili_debitur || row.alamat_debitur,
                alamat_sesuai_ktp: row.alamat_debitur,

                jumlah_tanggungan: row.jumlah_tanggungan || 0,
                no_rekening_pemohon: row.no_rekening_bank_lain,
                gaji_debitur: gajiDebitur,
                gaji_pasangan: gajiPasangan,
                pendapatan_usaha_debitur: pendapatanUsaha,
                total_pendapatan: totalPendapatan,
                kewajiban_existing: kewajibanExisting,
                kewajiban_existing_penjamin: kewajibanExistingPenjamin,
                pendapatan_bersih: pendapatanBersih,
                angsuran_fasilitas_baru: angsuranBaru,
                total_angsuran: totalAngsuran,
                dsr,
                status_kelayakan: statusKelayakan,
                list_tanggungan: tanggunganList,
                jumlah_tanggungan: tanggunganList.length,
                list_pendapatan_lainnya: listPendapatanLainnya,
                pendapatan_lainnya: totalPendapatanLainnya,
                list_pengeluaran: listPengeluaran,
                total_pengeluaran: totalPengeluaranSurvey,
                total_biaya_perbulan: totalPengeluaranDasar,
            },
        });
    } catch (error) {
        console.error('GET ANALISA KEMAMPUAN MUK error:', error);
        return res.status(500).json({
            status: 'error',
            message: error.message,
        });
    }
});

router.post('/api/pengajuan/:id/muk', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        await ensureMukTable(pool);
        await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .input('muk_data', sql.NVarChar, JSON.stringify(req.body || {}))
            .query(`
                IF EXISTS (SELECT 1 FROM t_pengajuan_muk WHERE id_pengajuan = @id_pengajuan)
                BEGIN
                    UPDATE t_pengajuan_muk
                    SET muk_data = @muk_data,
                        updated_at = GETDATE()
                    WHERE id_pengajuan = @id_pengajuan
                END
                ELSE
                BEGIN
                    INSERT INTO t_pengajuan_muk (id_pengajuan, muk_data, created_at, updated_at)
                    VALUES (@id_pengajuan, @muk_data, GETDATE(), GETDATE())
                END
            `);

        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id,
            targetStsflag: '8',
            event: 'muk',
        });

        res.json({
            status: 'success',
            message: 'MUK berhasil disimpan',
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('POST MUK error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.get('/api/pengajuan/:id/kelengkapan', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        await ensureKelengkapanDokumenTable(pool);

        const result = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_detail, id_pengajuan, category, description, jaminan_index,
                       jaminan_label, field_name, original_name, file_name,
                       file_path, mime_type, file_size, created_at
                FROM t_pengajuan_kelengkapan_dokumen
                WHERE id_pengajuan = @id
                ORDER BY category, ISNULL(jaminan_index, -1), id_detail
            `);

        res.json({ status: 'success', documents: result.recordset });
    } catch (error) {
        console.error('GET kelengkapan error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/kelengkapan', handleUpload, async (req, res) => {
    const { id } = req.params;
    let savedFiles = [];
    let body;
    try {
        body = parsePayload(req);
    } catch (error) {
        return res.status(400).json({ status: 'error', message: 'Payload JSON tidak valid.' });
    }

    const documents = Array.isArray(body.documents) ? body.documents : [];
    if (documents.length === 0) {
        return res.status(400).json({ status: 'error', message: 'Minimal satu dokumen wajib disimpan.' });
    }

    try {
        const pool = await getPool();
        await ensureKelengkapanDokumenTable(pool);
        savedFiles = await saveUploadedFiles(id, req.files || []);

        const existingResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT file_path, original_name, file_name, mime_type, file_size
                FROM t_pengajuan_kelengkapan_dokumen
                WHERE id_pengajuan = @id
            `);
        const existingPaths = new Set(existingResult.recordset.map((item) => item.file_path));

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            await new sql.Request(transaction)
                .input('id', sql.VarChar, id)
                .query('DELETE FROM t_pengajuan_kelengkapan_dokumen WHERE id_pengajuan = @id');

            for (const doc of documents) {
                const fieldName = doc.field_name;
                const uploaded = savedFiles.find((file) => file.field === fieldName);
                const useExisting = !uploaded && doc.existing_file_path && existingPaths.has(doc.existing_file_path);
                if (!uploaded && !useExisting) continue;

                await new sql.Request(transaction)
                    .input('id_pengajuan', sql.VarChar, id)
                    .input('category', sql.VarChar, doc.category || null)
                    .input('description', sql.NVarChar, doc.description || null)
                    .input('jaminan_index', sql.Int, doc.jaminan_index === null || doc.jaminan_index === undefined ? null : Number(doc.jaminan_index))
                    .input('jaminan_label', sql.NVarChar, doc.jaminan_label || null)
                    .input('field_name', sql.VarChar, fieldName || null)
                    .input('original_name', sql.NVarChar, uploaded?.original_name || doc.existing_original_name || null)
                    .input('file_name', sql.NVarChar, uploaded?.filename || (doc.existing_file_path ? path.basename(doc.existing_file_path) : null))
                    .input('file_path', sql.NVarChar, uploaded?.path || doc.existing_file_path)
                    .input('mime_type', sql.VarChar, uploaded?.mimetype || null)
                    .input('file_size', sql.Int, uploaded?.size || null)
                    .query(`
                        INSERT INTO t_pengajuan_kelengkapan_dokumen
                            (id_pengajuan, category, description, jaminan_index, jaminan_label,
                             field_name, original_name, file_name, file_path, mime_type, file_size, created_at)
                        VALUES
                            (@id_pengajuan, @category, @description, @jaminan_index, @jaminan_label,
                             @field_name, @original_name, @file_name, @file_path, @mime_type, @file_size, GETDATE())
                    `);
            }

            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            throw error;
        }

        await updatePengajuanStsflag(pool, id, '4');
        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id,
            targetStsflag: '4',
            event: 'save',
        });
        res.json({
            status: 'success',
            message: 'Kelengkapan berhasil disimpan.',
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('POST kelengkapan error:', error);
        await cleanupSavedFiles(savedFiles);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/progress', async (req, res) => {
    const { id } = req.params;
    const { stsflag } = req.body || {};
    const normalizedStsflag = String(stsflag || '').trim();

    if (!['4', '5', '6', '7', '8'].includes(normalizedStsflag)) {
        return res.status(400).json({
            status: 'error',
            message: 'Status workflow tidak valid.',
        });
    }

    try {
        const pool = await getPool();
        await updatePengajuanStsflag(pool, id, normalizedStsflag);
        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id,
            targetStsflag: normalizedStsflag,
            event: 'save',
        });
        res.json({
            status: 'success',
            message: 'Status workflow berhasil diperbarui.',
            stsflag: normalizedStsflag,
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('POST progress pengajuan error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// POST - Koreksi Pengajuan: catat koreksi di log dan mundurkan status workflow
router.post('/api/pengajuan/:id/koreksi', async (req, res) => {
    const { id } = req.params;
    const { target_stsflag, catatan_koreksi } = req.body;
    const catatanKoreksi = catatan_koreksi?.toString().trim();

    if (!['1', '2', '3', '4', '5', '6', '7'].includes(String(target_stsflag))) {
        return res.status(400).json({
            status: 'error',
            message: 'Target status koreksi tidak valid'
        });
    }

    if (!catatanKoreksi) {
        return res.status(400).json({
            status: 'error',
            message: 'Catatan koreksi wajib diisi'
        });
    }

    try {
        const pool = await getPool();
        const existing = await pool.request()
            .input('id', sql.VarChar, id)
            .query('SELECT stsflag FROM t_pengajuan WHERE id_pengajuan = @id');

        if (existing.recordset.length === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'Pengajuan tidak ditemukan'
            });
        }

        const previousStsflag = existing.recordset[0].stsflag;
        await pool.request()
            .input('id', sql.VarChar, id)
            .input('target_stsflag', sql.VarChar, String(target_stsflag))
            .query(`
                UPDATE t_pengajuan
                SET stsflag = @target_stsflag
                WHERE id_pengajuan = @id
            `);

        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id,
            targetStsflag: target_stsflag,
            event: 'koreksi',
            previousStsflag,
            catatan: catatanKoreksi,
        });

        res.json({
            status: 'success',
            message: 'Pengajuan berhasil dikoreksi',
            previous_stsflag: previousStsflag,
            stsflag: String(target_stsflag),
            catatan_koreksi: catatanKoreksi,
            whatsapp_notification: whatsappNotification,
        });
    } catch (err) {
        console.error('Error koreksi pengajuan:', err);
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

async function ensureRekapAnalisaTable(pool) {
    await pool.request().query(`
        IF OBJECT_ID('dbo.t_pengajuan_rekap_analisa', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_rekap_analisa (
                id_rekap INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL UNIQUE,
                penghasilan DECIMAL(18,2) NULL,
                biaya DECIMAL(18,2) NULL,
                sisa_penghasilan DECIMAL(18,2) NULL,
                angsuran DECIMAL(18,2) NULL,
                dsr DECIMAL(9,2) NULL,
                selected_slik NVARCHAR(MAX) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END
    `);
    await ensureTableColumns(pool, 't_pengajuan_rekap_analisa', [
        { name: 'selected_slik', type: 'NVARCHAR(MAX)' },
    ]);
}

async function ensureSurveyDebiturNarasumberTable(pool) {
    await pool.request().query(`
        IF OBJECT_ID('dbo.t_pengajuan_survey_debitur_narasumber', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_debitur_narasumber (
                id_narasumber INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                jenis VARCHAR(20) NOT NULL,
                urutan INT NOT NULL DEFAULT 0,
                nama NVARCHAR(150) NULL,
                hubungan NVARCHAR(100) NULL,
                telepon VARCHAR(50) NULL,
                alamat NVARCHAR(500) NULL,
                keterangan NVARCHAR(MAX) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END

        IF COL_LENGTH('dbo.t_pengajuan_survey_debitur_narasumber', 'alamat') IS NULL
        BEGIN
            ALTER TABLE dbo.t_pengajuan_survey_debitur_narasumber ADD alamat NVARCHAR(500) NULL
        END

        IF OBJECT_ID('dbo.t_pengajuan_survey_debitur_tanggungan', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_debitur_tanggungan (
                id_tanggungan INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                urutan INT NOT NULL DEFAULT 0,
                nama NVARCHAR(150) NULL,
                usia VARCHAR(30) NULL,
                pendidikan NVARCHAR(100) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END

        IF OBJECT_ID('dbo.t_pengajuan_survey_debitur_biaya_pendapatan', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_debitur_biaya_pendapatan (
                id_biaya_pendapatan INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                jenis VARCHAR(20) NOT NULL,
                urutan INT NOT NULL DEFAULT 0,
                keterangan NVARCHAR(250) NULL,
                nominal VARCHAR(100) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END

        IF OBJECT_ID('dbo.t_pengajuan_survey_debitur_dokumentasi', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_debitur_dokumentasi (
                id_dokumentasi INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                kategori VARCHAR(50) NOT NULL DEFAULT 'SURVEY',
                urutan INT NOT NULL DEFAULT 0,
                original_name NVARCHAR(255) NULL,
                file_name NVARCHAR(255) NULL,
                file_path NVARCHAR(500) NULL,
                mime_type VARCHAR(100) NULL,
                file_size INT NULL,
                keterangan NVARCHAR(500) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END

        IF COL_LENGTH('dbo.t_pengajuan_survey_debitur_dokumentasi', 'kategori') IS NULL
        BEGIN
            ALTER TABLE dbo.t_pengajuan_survey_debitur_dokumentasi ADD kategori VARCHAR(50) NOT NULL CONSTRAINT DF_t_pengajuan_survey_debitur_dokumentasi_kategori DEFAULT 'SURVEY'
        END

        IF OBJECT_ID('dbo.t_pengajuan_survey_debitur_usaha', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_debitur_usaha (
                id_pengajuan VARCHAR(50) PRIMARY KEY,
                usaha_data NVARCHAR(MAX) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END
    `);
}

async function ensureSurveyDebiturInfoTable(pool) {
    await ensureTableColumns(pool, 't_pengajuan_survey_debitur_info', [
        { name: 'survey_data', type: 'NVARCHAR(MAX)' },
        { name: 'created_at', type: 'DATETIME' },
        { name: 'updated_at', type: 'DATETIME' },
    ]);
}

async function ensureSurveyAgunanTable(pool) {
    await pool.request().query(`
        IF OBJECT_ID('dbo.t_pengajuan_survey_agunan', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_agunan (
                id_pengajuan VARCHAR(50) PRIMARY KEY,
                survey_data NVARCHAR(MAX) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END

        IF OBJECT_ID('dbo.t_pengajuan_survey_agunan_dokumentasi', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.t_pengajuan_survey_agunan_dokumentasi (
                id_dokumentasi INT IDENTITY(1,1) PRIMARY KEY,
                id_pengajuan VARCHAR(50) NOT NULL,
                urutan INT NOT NULL DEFAULT 0,
                original_name NVARCHAR(255) NULL,
                file_name NVARCHAR(255) NULL,
                file_path NVARCHAR(500) NULL,
                mime_type VARCHAR(100) NULL,
                file_size INT NULL,
                keterangan NVARCHAR(500) NULL,
                created_at DATETIME NOT NULL DEFAULT GETDATE(),
                updated_at DATETIME NULL
            )
        END
    `);
}

router.get('/api/pengajuan/:id/survey-debitur', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureSurveyDebiturNarasumberTable(pool);
        await ensureSurveyDebiturInfoTable(pool);

        const id = req.params.id;

        const narasumberResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT jenis, urutan, nama, hubungan, telepon, alamat, keterangan
                FROM t_pengajuan_survey_debitur_narasumber
                WHERE id_pengajuan = @id
                ORDER BY jenis, urutan, id_narasumber
            `);

        const tanggunganResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT urutan, nama, usia, pendidikan
                FROM t_pengajuan_survey_debitur_tanggungan
                WHERE id_pengajuan = @id
                ORDER BY urutan, id_tanggungan
            `);

        const biayaPendapatanResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT jenis, urutan, keterangan, nominal
                FROM t_pengajuan_survey_debitur_biaya_pendapatan
                WHERE id_pengajuan = @id
                ORDER BY jenis, urutan, id_biaya_pendapatan
            `);

        const infoResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT TOP 1
                    tanggal_survey,
                    petugas_pendamping_survey,
                    status_tempat_kerja,
                    kondisi_bangunan,
                    lama_tinggal,
                    mengikuti_ormas,
                    permasalahan_hukum
                FROM t_pengajuan_survey_debitur_info
                WHERE id_pengajuan = @id
                ORDER BY ISNULL(updated_at, created_at) DESC
            `);

        const infoData = infoResult.recordset[0] || {};

        const dokumentasiResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT kategori, urutan, original_name, file_name, file_path, mime_type, file_size, keterangan
                FROM t_pengajuan_survey_debitur_dokumentasi
                WHERE id_pengajuan = @id
                ORDER BY kategori, urutan, id_dokumentasi
            `);

        const usahaResult = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT usaha_data
                FROM t_pengajuan_survey_debitur_usaha
                WHERE id_pengajuan = @id
            `);

        let usaha = {};
        const usahaRaw = usahaResult.recordset[0]?.usaha_data;
        if (usahaRaw) {
            try {
                usaha = typeof usahaRaw === 'string'
                    ? JSON.parse(usahaRaw)
                    : usahaRaw;
            } catch (_) {
                usaha = {};
            }
        }

        if (Array.isArray(usaha.items)) {
            usaha.items = usaha.items.map((item) => ({
                ...(item || {}),
                dokumentasi_keuangan: Array.isArray(item?.dokumentasi_keuangan)
                    ? item.dokumentasi_keuangan
                    : [],
                dokumentasi_operasional: Array.isArray(item?.dokumentasi_operasional)
                    ? item.dokumentasi_operasional
                    : [],
            }));
        } else {
            usaha.dokumentasi_keuangan = [];
            usaha.dokumentasi_operasional = [];
        }

        const response = {
            ...infoData,
            lingkungan: [],
            trade: [],
            tanggungan: [],
            pendapatan: [],
            pengeluaran: [],
            dokumentasi: [],
            usaha,
        };

        for (const row of narasumberResult.recordset) {
            const item = {
                nama: row.nama,
                hubungan: row.hubungan,
                telepon: row.telepon,
                alamat: row.alamat,
                keterangan: row.keterangan,
            };

            if ((row.jenis || '').toUpperCase() === 'TRADE') {
                response.trade.push(item);
            } else {
                response.lingkungan.push(item);
            }
        }

        response.tanggungan = tanggunganResult.recordset.map((row) => ({
            nama: row.nama,
            usia: row.usia,
            pendidikan: row.pendidikan,
        }));

        for (const row of biayaPendapatanResult.recordset) {
            const item = {
                keterangan: row.keterangan,
                nominal: row.nominal,
            };

            if ((row.jenis || '').toUpperCase() === 'PENGELUARAN') {
                response.pengeluaran.push(item);
            } else {
                response.pendapatan.push(item);
            }
        }

        for (const row of dokumentasiResult.recordset) {
            const item = {
                original_name: row.original_name,
                file_name: row.file_name,
                file_path: row.file_path,
                mime_type: row.mime_type,
                file_size: row.file_size,
                keterangan: row.keterangan,
            };

            const kategori = (row.kategori || 'SURVEY').toUpperCase();
            const usahaMatch = kategori.match(/^USAHA_(\d+)_(KEUANGAN|OPERASIONAL)$/);

            if (usahaMatch) {
                const usahaIndex = Number(usahaMatch[1]);
                const jenisDokumentasi = usahaMatch[2];

                if (!Array.isArray(response.usaha.items)) {
                    response.usaha.items = [];
                }

                while (response.usaha.items.length <= usahaIndex) {
                    response.usaha.items.push({
                        dokumentasi_keuangan: [],
                        dokumentasi_operasional: [],
                    });
                }

                const target = response.usaha.items[usahaIndex];

                if (!Array.isArray(target.dokumentasi_keuangan)) {
                    target.dokumentasi_keuangan = [];
                }

                if (!Array.isArray(target.dokumentasi_operasional)) {
                    target.dokumentasi_operasional = [];
                }

                if (jenisDokumentasi === 'KEUANGAN') {
                    target.dokumentasi_keuangan.push(item);
                } else {
                    target.dokumentasi_operasional.push(item);
                }
            } else if (kategori === 'USAHA_KEUANGAN') {
                response.usaha.dokumentasi_keuangan.push(item);
            } else if (kategori === 'USAHA_OPERASIONAL') {
                response.usaha.dokumentasi_operasional.push(item);
            } else {
                response.dokumentasi.push(item);
            }
        }

        res.json(response);
    } catch (error) {
        console.error('GET survey debitur error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/survey-debitur', handleUpload, async (req, res) => {
    const idPengajuan = req.params.id;
    let savedFiles = [];
    let data;
    try {
        data = parsePayload(req);
    } catch (error) {
        return res.status(400).json({ status: 'error', message: 'Payload JSON tidak valid.' });
    }
    const lingkungan = Array.isArray(data.lingkungan) ? data.lingkungan : [];
    const trade = Array.isArray(data.trade) ? data.trade : [];
    const tanggungan = Array.isArray(data.tanggungan) ? data.tanggungan : [];
    const pendapatan = Array.isArray(data.pendapatan) ? data.pendapatan : [];
    const pengeluaran = Array.isArray(data.pengeluaran) ? data.pengeluaran : [];
    const dokumentasi = Array.isArray(data.dokumentasi) ? data.dokumentasi : [];
    const surveyInfo = {
        tanggal_survey: data.tanggal_survey || null,
        petugas_pendamping_survey: data.petugas_pendamping_survey || null,
        status_tempat_kerja: data.status_tempat_kerja || null,
        kondisi_bangunan: data.kondisi_bangunan || null,
        lama_tinggal: data.lama_tinggal || null,
        mengikuti_ormas: data.mengikuti_ormas || null,
        permasalahan_hukum: data.permasalahan_hukum || null,
    };
    const usaha = data.usaha && typeof data.usaha === 'object' ? data.usaha : {};

    try {
        const pool = await getPool();
        await ensureSurveyDebiturNarasumberTable(pool);
        await ensureSurveyDebiturInfoTable(pool);
        savedFiles = await saveUploadedFiles(idPengajuan, req.files || []);
        const fileByField = new Map(savedFiles.map((file) => [file.field, file]));

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .query('DELETE FROM t_pengajuan_survey_debitur_narasumber WHERE id_pengajuan = @id_pengajuan');
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .query('DELETE FROM t_pengajuan_survey_debitur_tanggungan WHERE id_pengajuan = @id_pengajuan');
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .query('DELETE FROM t_pengajuan_survey_debitur_biaya_pendapatan WHERE id_pengajuan = @id_pengajuan');
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .query('DELETE FROM t_pengajuan_survey_debitur_dokumentasi WHERE id_pengajuan = @id_pengajuan');
            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .query('DELETE FROM t_pengajuan_survey_debitur_usaha WHERE id_pengajuan = @id_pengajuan');

            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .input('tanggal_survey', sql.VarChar, surveyInfo.tanggal_survey)
                .input('petugas_pendamping_survey', sql.NVarChar, surveyInfo.petugas_pendamping_survey)
                .input('status_tempat_kerja', sql.VarChar, surveyInfo.status_tempat_kerja)
                .input('kondisi_bangunan', sql.NVarChar, surveyInfo.kondisi_bangunan)
                .input('lama_tinggal', sql.NVarChar, surveyInfo.lama_tinggal)
                .input('mengikuti_ormas', sql.VarChar, surveyInfo.mengikuti_ormas)
                .input('permasalahan_hukum', sql.VarChar, surveyInfo.permasalahan_hukum)
                .query(`
        IF EXISTS (
            SELECT 1 FROM t_pengajuan_survey_debitur_info
            WHERE id_pengajuan = @id_pengajuan
        )
        BEGIN
            UPDATE t_pengajuan_survey_debitur_info
            SET tanggal_survey = @tanggal_survey,
                petugas_pendamping_survey = @petugas_pendamping_survey,
                status_tempat_kerja = @status_tempat_kerja,
                kondisi_bangunan = @kondisi_bangunan,
                lama_tinggal = @lama_tinggal,
                mengikuti_ormas = @mengikuti_ormas,
                permasalahan_hukum = @permasalahan_hukum,
                updated_at = GETDATE()
            WHERE id_pengajuan = @id_pengajuan
        END
        ELSE
        BEGIN
            INSERT INTO t_pengajuan_survey_debitur_info
                (
                    id_pengajuan,
                    tanggal_survey,
                    petugas_pendamping_survey,
                    status_tempat_kerja,
                    kondisi_bangunan,
                    lama_tinggal,
                    mengikuti_ormas,
                    permasalahan_hukum,
                    created_at,
                    updated_at
                )
            VALUES
                (
                    @id_pengajuan,
                    @tanggal_survey,
                    @petugas_pendamping_survey,
                    @status_tempat_kerja,
                    @kondisi_bangunan,
                    @lama_tinggal,
                    @mengikuti_ormas,
                    @permasalahan_hukum,
                    GETDATE(),
                    GETDATE()
                )
        END
    `);
            const insertRows = async (jenis, rows) => {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i] || {};
                    await new sql.Request(transaction)
                        .input('id_pengajuan', sql.VarChar, idPengajuan)
                        .input('jenis', sql.VarChar, jenis)
                        .input('urutan', sql.Int, i)
                        .input('nama', sql.NVarChar, row.nama || null)
                        .input('hubungan', sql.NVarChar, row.hubungan || null)
                        .input('telepon', sql.VarChar, row.telepon || null)
                        .input('alamat', sql.NVarChar, row.alamat || null)
                        .input('keterangan', sql.NVarChar, row.keterangan || null)
                        .query(`
                            INSERT INTO t_pengajuan_survey_debitur_narasumber
                                (id_pengajuan, jenis, urutan, nama, hubungan, telepon, alamat, keterangan, updated_at)
                            VALUES
                                (@id_pengajuan, @jenis, @urutan, @nama, @hubungan, @telepon, @alamat, @keterangan, GETDATE())
                        `);
                }
            };

            const insertTanggunganRows = async (rows) => {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i] || {};
                    await new sql.Request(transaction)
                        .input('id_pengajuan', sql.VarChar, idPengajuan)
                        .input('urutan', sql.Int, i)
                        .input('nama', sql.NVarChar, row.nama || null)
                        .input('usia', sql.VarChar, row.usia || null)
                        .input('pendidikan', sql.NVarChar, row.pendidikan || null)
                        .query(`
                            INSERT INTO t_pengajuan_survey_debitur_tanggungan
                                (id_pengajuan, urutan, nama, usia, pendidikan, updated_at)
                            VALUES
                                (@id_pengajuan, @urutan, @nama, @usia, @pendidikan, GETDATE())
                        `);
                }
            };

            const insertBiayaPendapatanRows = async (jenis, rows) => {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i] || {};
                    await new sql.Request(transaction)
                        .input('id_pengajuan', sql.VarChar, idPengajuan)
                        .input('jenis', sql.VarChar, jenis)
                        .input('urutan', sql.Int, i)
                        .input('keterangan', sql.NVarChar, row.keterangan || null)
                        .input('nominal', sql.VarChar, row.nominal || null)
                        .query(`
                            INSERT INTO t_pengajuan_survey_debitur_biaya_pendapatan
                                (id_pengajuan, jenis, urutan, keterangan, nominal, updated_at)
                            VALUES
                                (@id_pengajuan, @jenis, @urutan, @keterangan, @nominal, GETDATE())
                        `);
                }
            };

            const insertDokumentasiRows = async (rows, kategori = 'SURVEY') => {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i] || {};
                    const uploaded = row.file_field ? fileByField.get(row.file_field) : null;
                    const originalName = uploaded?.original_name || row.existing_name || null;
                    const fileName = uploaded?.filename || row.existing_name || null;
                    const filePath = uploaded?.path || row.existing_path || null;
                    if (!filePath && !row.keterangan) continue;

                    await new sql.Request(transaction)
                        .input('id_pengajuan', sql.VarChar, idPengajuan)
                        .input('kategori', sql.VarChar, kategori)
                        .input('urutan', sql.Int, i)
                        .input('original_name', sql.NVarChar, originalName)
                        .input('file_name', sql.NVarChar, fileName)
                        .input('file_path', sql.NVarChar, filePath)
                        .input('mime_type', sql.VarChar, uploaded?.mimetype || null)
                        .input('file_size', sql.Int, uploaded?.size || null)
                        .input('keterangan', sql.NVarChar, row.keterangan || null)
                        .query(`
                            INSERT INTO t_pengajuan_survey_debitur_dokumentasi
                                (id_pengajuan, kategori, urutan, original_name, file_name, file_path, mime_type, file_size, keterangan, updated_at)
                            VALUES
                                (@id_pengajuan, @kategori, @urutan, @original_name, @file_name, @file_path, @mime_type, @file_size, @keterangan, GETDATE())
                        `);
                }
            };

            const usahaToStore = { ...usaha };
            const usahaItems = Array.isArray(usahaToStore.items) ? usahaToStore.items : [];
            const usahaDokumentasiRows = [];
            if (usahaItems.length > 0) {
                usahaToStore.items = usahaItems.map((item, index) => {
                    const itemToStore = { ...(item || {}) };
                    const keuanganRows = Array.isArray(itemToStore.dokumentasi_keuangan) ? itemToStore.dokumentasi_keuangan : [];
                    const operasionalRows = Array.isArray(itemToStore.dokumentasi_operasional) ? itemToStore.dokumentasi_operasional : [];
                    usahaDokumentasiRows.push({ kategori: `USAHA_${index}_KEUANGAN`, rows: keuanganRows });
                    usahaDokumentasiRows.push({ kategori: `USAHA_${index}_OPERASIONAL`, rows: operasionalRows });
                    delete itemToStore.dokumentasi_keuangan;
                    delete itemToStore.dokumentasi_operasional;
                    return itemToStore;
                });
            } else {
                const usahaKeuanganDokumentasi = Array.isArray(usahaToStore.dokumentasi_keuangan) ? usahaToStore.dokumentasi_keuangan : [];
                const usahaOperasionalDokumentasi = Array.isArray(usahaToStore.dokumentasi_operasional) ? usahaToStore.dokumentasi_operasional : [];
                usahaDokumentasiRows.push({ kategori: 'USAHA_KEUANGAN', rows: usahaKeuanganDokumentasi });
                usahaDokumentasiRows.push({ kategori: 'USAHA_OPERASIONAL', rows: usahaOperasionalDokumentasi });
                delete usahaToStore.dokumentasi_keuangan;
                delete usahaToStore.dokumentasi_operasional;
            }

            await insertRows('LINGKUNGAN', lingkungan);
            await insertRows('TRADE', trade);
            await insertTanggunganRows(tanggungan);
            await insertBiayaPendapatanRows('PENDAPATAN', pendapatan);
            await insertBiayaPendapatanRows('PENGELUARAN', pengeluaran);
            await insertDokumentasiRows(dokumentasi);
            for (const item of usahaDokumentasiRows) {
                await insertDokumentasiRows(item.rows, item.kategori);
            }
            if (Object.keys(usahaToStore).length > 0) {
                await new sql.Request(transaction)
                    .input('id_pengajuan', sql.VarChar, idPengajuan)
                    .input('usaha_data', sql.NVarChar, JSON.stringify(usahaToStore))
                    .query(`
                        INSERT INTO t_pengajuan_survey_debitur_usaha
                            (id_pengajuan, usaha_data, updated_at)
                        VALUES
                            (@id_pengajuan, @usaha_data, GETDATE())
                    `);
            }
            await transaction.commit();

            await updatePengajuanStsflag(pool, idPengajuan, '6');
            const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
                idPengajuan,
                targetStsflag: '6',
                event: 'save',
            });
            res.json({
                status: 'success',
                message: 'Survey debitur berhasil disimpan',
                whatsapp_notification: whatsappNotification,
            });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('POST survey debitur error:', error);
        await cleanupSavedFiles(savedFiles);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.get('/api/pengajuan/:id/survey-agunan', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureSurveyAgunanTable(pool);

        const surveyResult = await pool.request()
            .input('id', sql.VarChar, req.params.id)
            .query(`
                SELECT survey_data
                FROM t_pengajuan_survey_agunan
                WHERE id_pengajuan = @id
            `);

        const dokumentasiResult = await pool.request()
            .input('id', sql.VarChar, req.params.id)
            .query(`
                SELECT urutan, original_name, file_name, file_path, mime_type, file_size, keterangan
                FROM t_pengajuan_survey_agunan_dokumentasi
                WHERE id_pengajuan = @id
                ORDER BY urutan, id_dokumentasi
            `);

        let response = {};
        const rawSurveyData = surveyResult.recordset[0]?.survey_data;
        if (rawSurveyData) {
            try {
                response = typeof rawSurveyData === 'string'
                    ? JSON.parse(rawSurveyData)
                    : rawSurveyData;
            } catch (_) {
                response = {};
            }
        }

        response.dokumentasi = dokumentasiResult.recordset.map((row) => ({
            original_name: row.original_name,
            file_name: row.file_name,
            file_path: row.file_path,
            mime_type: row.mime_type,
            file_size: row.file_size,
            keterangan: row.keterangan,
        }));

        res.json(response);
    } catch (error) {
        console.error('GET survey agunan error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/survey-agunan', handleUpload, async (req, res) => {
    const idPengajuan = req.params.id;
    let savedFiles = [];
    let data;
    try {
        data = parsePayload(req);
    } catch (error) {
        return res.status(400).json({ status: 'error', message: 'Payload JSON tidak valid.' });
    }

    const dokumentasi = Array.isArray(data.dokumentasi) ? data.dokumentasi : [];

    try {
        const pool = await getPool();
        await ensureSurveyAgunanTable(pool);
        savedFiles = await saveUploadedFiles(idPengajuan, req.files || []);
        const fileByField = new Map(savedFiles.map((file) => [file.field, file]));

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const dataToStore = { ...data };
            delete dataToStore.dokumentasi;

            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .input('survey_data', sql.NVarChar, JSON.stringify(dataToStore))
                .query(`
                    IF EXISTS (SELECT 1 FROM t_pengajuan_survey_agunan WHERE id_pengajuan = @id_pengajuan)
                    BEGIN
                        UPDATE t_pengajuan_survey_agunan
                        SET survey_data = @survey_data, updated_at = GETDATE()
                        WHERE id_pengajuan = @id_pengajuan
                    END
                    ELSE
                    BEGIN
                        INSERT INTO t_pengajuan_survey_agunan (id_pengajuan, survey_data, created_at)
                        VALUES (@id_pengajuan, @survey_data, GETDATE())
                    END
                `);

            await new sql.Request(transaction)
                .input('id_pengajuan', sql.VarChar, idPengajuan)
                .query('DELETE FROM t_pengajuan_survey_agunan_dokumentasi WHERE id_pengajuan = @id_pengajuan');

            for (let i = 0; i < dokumentasi.length; i++) {
                const row = dokumentasi[i] || {};
                const file = row.file_field ? fileByField.get(row.file_field) : null;
                await new sql.Request(transaction)
                    .input('id_pengajuan', sql.VarChar, idPengajuan)
                    .input('urutan', sql.Int, i)
                    .input('original_name', sql.NVarChar, file?.original_name || row.existing_name || null)
                    .input('file_name', sql.NVarChar, file?.filename || row.existing_name || null)
                    .input('file_path', sql.NVarChar, file?.path || row.existing_path || null)
                    .input('mime_type', sql.VarChar, file?.mimetype || null)
                    .input('file_size', sql.Int, file?.size || null)
                    .input('keterangan', sql.NVarChar, row.keterangan || null)
                    .query(`
                        INSERT INTO t_pengajuan_survey_agunan_dokumentasi
                            (id_pengajuan, urutan, original_name, file_name, file_path, mime_type, file_size, keterangan, updated_at)
                        VALUES
                            (@id_pengajuan, @urutan, @original_name, @file_name, @file_path, @mime_type, @file_size, @keterangan, GETDATE())
                    `);
            }

            await transaction.commit();
            await updatePengajuanStsflag(pool, idPengajuan, '7');
            const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
                idPengajuan,
                targetStsflag: '7',
                event: 'save',
            });
            res.json({
                status: 'success',
                message: 'Survey agunan berhasil disimpan',
                whatsapp_notification: whatsappNotification,
            });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('POST survey agunan error:', error);
        await cleanupSavedFiles(savedFiles);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.get('/api/pengajuan/:id/rekap-analisa', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureRekapAnalisaTable(pool);

        const result = await pool.request()
            .input('id', sql.VarChar, req.params.id)
            .query(`
                SELECT TOP 1 *
                FROM t_pengajuan_rekap_analisa
                WHERE id_pengajuan = @id
            `);

        res.json(result.recordset[0] || null);
    } catch (error) {
        console.error('GET rekap analisa error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

router.post('/api/pengajuan/:id/rekap-analisa', async (req, res) => {
    try {
        const pool = await getPool();
        await ensureRekapAnalisaTable(pool);

        const idPengajuan = req.params.id;
        const data = req.body || {};
        const boundedDecimalOrNull = (value, maxAbs = 9999999999999999) => {
            const number = nullableNumber(value);
            if (number === null || Math.abs(number) > maxAbs) return null;
            return number;
        };

        await pool.request()
            .input('id_pengajuan', sql.VarChar, idPengajuan)
            .input('penghasilan', sql.Decimal(18, 2), boundedDecimalOrNull(data.penghasilan))
            .input('biaya', sql.Decimal(18, 2), boundedDecimalOrNull(data.biaya))
            .input('sisa_penghasilan', sql.Decimal(18, 2), boundedDecimalOrNull(data.sisa_penghasilan))
            .input('angsuran', sql.Decimal(18, 2), boundedDecimalOrNull(data.angsuran))
            .input('dsr', sql.Decimal(9, 2), boundedDecimalOrNull(data.dsr, 9999999.99))
            .input('selected_slik', sql.NVarChar, JSON.stringify(data.selected_slik || []))
            .query(`
                IF EXISTS (SELECT 1 FROM t_pengajuan_rekap_analisa WHERE id_pengajuan = @id_pengajuan)
                BEGIN
                    UPDATE t_pengajuan_rekap_analisa
                    SET penghasilan = @penghasilan,
                        biaya = @biaya,
                        sisa_penghasilan = @sisa_penghasilan,
                        angsuran = @angsuran,
                        dsr = @dsr,
                        selected_slik = @selected_slik,
                        updated_at = GETDATE()
                    WHERE id_pengajuan = @id_pengajuan
                END
                ELSE
                BEGIN
                    INSERT INTO t_pengajuan_rekap_analisa
                        (id_pengajuan, penghasilan, biaya, sisa_penghasilan,
                         angsuran, dsr, selected_slik, created_at)
                    VALUES
                        (@id_pengajuan, @penghasilan, @biaya, @sisa_penghasilan,
                         @angsuran, @dsr, @selected_slik, GETDATE())
                END
            `);

        await updatePengajuanStsflag(pool, idPengajuan, '5');
        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan,
            targetStsflag: '5',
            event: 'save',
        });
        res.status(200).json({
            status: 'success',
            message: 'Rekap analisa berhasil disimpan',
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.error('POST rekap analisa error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// GET - Detail Pengajuan by ID
router.get('/api/pengajuan/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        await ensurePengajuanDetailTables(pool);

        // Query utama dengan SELECT lengkap
        const result = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT a.id_pengajuan, a.jenis_debitur, a.plafon_pengajuan, a.tenor_bulan, a.tgl_pengajuan, 
                       a.status_pengajuan, a.catatan_ao, a.stsflag,
                       b.nama_debitur, b.no_ktp, b.no_hp, 
                       b.nama_pasangan, b.ktp_pasangan, b.no_hp_pasangan, 
                       b.foto_ktp, b.foto_pasangan, b.foto_kk,
                       COALESCE(NULLIF(CAST(b.ttd_debitur AS VARCHAR(MAX)), ''), NULLIF(CAST(b.ttd_debitur_base64 AS VARCHAR(MAX)), '')) AS ttd_debitur,
                       COALESCE(NULLIF(CAST(b.ttd_pasangan AS VARCHAR(MAX)), ''), NULLIF(CAST(b.ttd_pasangan_base64 AS VARCHAR(MAX)), '')) AS ttd_pasangan,
                       b.tempat_lahir, b.tanggal_lahir, b.jenis_kelamin,
                       b.tempat_lahir_pasangan, b.tanggal_lahir_pasangan, b.jenis_kelamin_pasangan,
                       c.nama_perusahaan, c.npwp, c.alamat_perusahaan, c.alamat_domisili_perusahaan, c.no_telp_perusahaan, 
                       c.jenis_badan_usaha, c.tgl_berdiri, c.foto_npwp, c.nib, c.no_akta_pendirian, c.notaris,
                       c.no_sk_kemenhum, c.tgl_sk_kemenhum, c.modal_dasar, c.rt_rw AS bu_rt_rw, c.kode_pos AS bu_kode_pos,
                       c.provinsi_code AS bu_provinsi_code, c.provinsi AS bu_provinsi,
                       c.kabupaten_code AS bu_kabupaten_code, c.kabupaten AS bu_kabupaten,
                       c.kecamatan_code AS bu_kecamatan_code, c.kecamatan AS bu_kecamatan,
                       c.kelurahan_code AS bu_kelurahan_code, c.kelurahan AS bu_kelurahan,
                       c.tgl_perubahan, c.no_akta_perubahan, c.notaris_perubahan,
                       c.no_sk_kemenhum_perubahan, c.tgl_sk_kemenhum_perubahan, c.alasan_perubahan,
                       c.lama_usaha AS bu_lama_usaha, c.telp_usaha AS bu_telp_usaha,
                       c.sektor_usaha AS bu_sektor_usaha, c.nomor_npwp_usaha,
                       c.sektor_ekonomi AS bu_sektor_ekonomi, c.golongan_debitur AS bu_golongan_debitur,
                       c.pendapatan_usaha, c.total_penghasilan, c.total_biaya, c.file_akta_pendirian,
                       d.nama_panggilan, d.alamat_debitur AS detail_alamat_debitur, d.alamat_domisili_debitur AS detail_alamat_domisili_debitur, d.domisili_sesuai_ktp_debitur, d.tempat_lahir AS detail_tempat_lahir, d.tanggal_lahir AS detail_tanggal_lahir, d.agama, 
                       d.rt_rw, d.kode_pos, d.email, d.nama_ibu_kandung,
                       d.tgl_berlaku_ktp,
                       d.ktp_berlaku_seumur_hidup,
                       d.jenis_kelamin AS detail_jenis_kelamin, d.status_menikah, 
                       d.status_pendidikan, d.provinsi_code, d.provinsi, d.kabupaten_code, 
                       d.kabupaten, d.kecamatan_code, d.kecamatan, d.kelurahan_code, 
                       d.kelurahan, d.foto_pas_photo,
                       e.nama_panggilan_pasangan, e.tempat_lahir_pasangan AS detail_tempat_lahir_pasangan, e.tanggal_lahir_pasangan AS detail_tanggal_lahir_pasangan, 
                       e.agama_pasangan, e.alamat_pasangan, e.alamat_domisili_pasangan, e.domisili_sesuai_ktp_pasangan, e.rt_rw_pasangan, e.kode_pos_pasangan, 
                       e.email_pasangan, e.tgl_berlaku_ktp_pasangan,
                       e.ktp_berlaku_seumur_hidup_pasangan,
                       e.jenis_kelamin_pasangan AS detail_jenis_kelamin_pasangan, e.provinsi_code_pasangan, 
                       e.provinsi_pasangan, e.kabupaten_code_pasangan, e.kabupaten_pasangan, 
                       e.kecamatan_code_pasangan, e.kecamatan_pasangan, e.kelurahan_code_pasangan, 
                       e.kelurahan_pasangan, e.foto_pasangan_photo,
                       f.nama_keluarga_1, f.hp_keluarga_1, f.nama_keluarga_2, f.hp_keluarga_2,
                       g.form_pekerjaan, g.bekerja, g.nama_perusahaan_kerja, g.jabatan, 
                       g.bidang_usaha, g.jenis_pekerjaan, g.lama_bekerja, g.alamat_kantor, 
                       g.telp_kantor, g.gaji, g.nama_usaha, g.lama_usaha, g.alamat_usaha, g.telp_usaha, 
                       g.hasil_usaha,
                       g.sektor_usaha, g.nomor_npwp, g.pekerjaan_slik, g.sektor_ekonomi, 
                       g.golongan_debitur,
                       usp.form_pekerjaan AS pasangan_form_pekerjaan, usp.bekerja AS pasangan_bekerja,
                       usp.nama_perusahaan_kerja AS pasangan_nama_perusahaan_kerja, usp.jabatan AS pasangan_jabatan,
                       usp.bidang_usaha AS pasangan_bidang_usaha, usp.jenis_pekerjaan AS pasangan_jenis_pekerjaan,
                       usp.lama_bekerja AS pasangan_lama_bekerja, usp.alamat_kantor AS pasangan_alamat_kantor,
                       usp.telp_kantor AS pasangan_telp_kantor, usp.gaji AS pasangan_gaji, usp.nama_usaha AS pasangan_nama_usaha,
                       usp.lama_usaha AS pasangan_lama_usaha, usp.alamat_usaha AS pasangan_alamat_usaha,
                       usp.telp_usaha AS pasangan_telp_usaha, usp.hasil_usaha AS pasangan_hasil_usaha,
                       usp.sektor_usaha AS pasangan_sektor_usaha,
                       usp.nomor_npwp AS pasangan_nomor_npwp, usp.pekerjaan_slik AS pasangan_pekerjaan_slik,
                       usp.sektor_ekonomi AS pasangan_sektor_ekonomi, usp.golongan_debitur AS pasangan_golongan_debitur,
                       p.pendapatan_usaha_debitur, p.total_penghasilan_debitur, p.total_biaya_perbulan,
                       k.referensi, k.nama_referensi, k.hubungan_dengan_bank, k.tujuan_penggunaan,
                       k.jumlah_pengajuan_kredit, k.jangka_waktu_bulan, k.bunga_per_tahun,
                       k.jenis_hitung_bunga, k.jenis_kredit, k.no_rekening_bank_lain,
                       k.sumber_pembayaran_kredit, k.detail_tujuan, k.sindikasi, k.alasan,
                       k.asuransi_jiwa, k.asuransi_kredit, k.asuransi_lainnya
                FROM t_pengajuan a
                LEFT JOIN t_debitur_perorangan b ON a.id_pengajuan = CAST(b.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_debitur_badan_usaha c ON a.id_pengajuan = CAST(c.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_debitur d ON a.id_pengajuan = CAST(d.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_pasangan_debitur e ON a.id_pengajuan = CAST(e.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_keluarga_tidak_serumah f ON a.id_pengajuan = CAST(f.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_usaha_debitur g ON a.id_pengajuan = CAST(g.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_detail_usaha_pasangan usp ON a.id_pengajuan = CAST(usp.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_debitur_data_penghasilan p ON a.id_pengajuan = CAST(p.id_pengajuan AS VARCHAR(50))
                LEFT JOIN t_debitur_data_kredit k ON a.id_pengajuan = CAST(k.id_pengajuan AS VARCHAR(50))
                WHERE a.id_pengajuan = @id
            `);

        // Ambil data penjamin
        const penjamin = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_penjamin, nama_penjamin, ktp_penjamin, hubungan_debitur, no_hp_penjamin, 
                foto_penjamin,ttd_penjamin,tempat_lahir, tanggal_lahir, jenis_kelamin,
                tgl_berlaku_ktp, ktp_berlaku_seumur_hidup
                FROM t_pengajuan_penjamin 
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
                ORDER BY id_penjamin ASC
            `);

        // Ambil data pendiri
        const pendiri = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
        SELECT id_pendiri, nama_pendiri, ktp_pendiri, jabatan, 
               persentase_saham, foto_pendiri, ttd_pendiri,
               tempat_lahir, tanggal_lahir, jenis_kelamin,
               alamat_ktp, alamat_domisili, no_hp,
               tgl_berlaku_ktp, ktp_berlaku_seumur_hidup,
               agama, nama_ibu_kandung
        FROM t_pengajuan_pendiri 
        WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
        ORDER BY id_pendiri ASC
    `);

        // ========== AMBIL DATA DUKCAPIL ==========
        await ensureVerifikasiDukcapilColumns(pool);
        const verifikasiDukcapil = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT status_debitur, status_pasangan, catatan_admin, 
                       catatan_admin_debitur, catatan_admin_pasangan,
                       file_hasil_dukcapil_debitur, file_hasil_dukcapil_pasangan, 
                       verified_by, verified_at 
                FROM t_verifikasi_dukcapil 
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id 
                ORDER BY verified_at DESC
            `);

        await ensurePengajuanDukcapilTable(pool);

        // Ambil verifikasi Dukcapil penjamin dan pengurus dari tabel detail baru
        const pengajuanDukcapil = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT jenis, index_ke, status_dukcapil, file_hasil_dukcapil, catatan_admin, created_at
                FROM (
                    SELECT jenis, index_ke, status_dukcapil, file_hasil_dukcapil, catatan_admin, created_at,
                           ROW_NUMBER() OVER (PARTITION BY jenis, index_ke ORDER BY created_at DESC) AS rn
                    FROM t_pengajuan_dukcapil
                    WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
                      AND jenis IN ('PENJAMIN', 'PENGURUS', 'PENDIRI')
                ) x
                WHERE rn = 1
                ORDER BY jenis, index_ke
            `);

        // ========== AMBIL DATA SLIK ==========
        const slikData = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT id_slik, slik_data, created_at 
                FROM t_pengajuan_slik 
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id 
                ORDER BY created_at DESC
            `);

        const jaminan = await pool.request()
            .input('id', sql.VarChar, id)
            .query(`
                SELECT ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS id_jaminan, jenis_jaminan, data_jaminan
                FROM t_debitur_data_jaminan
                WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id
            `);

        // Format data SLIK untuk Frontend
        const listSlik = [];
        let slikCheck = null;
        const latestSlikByPerson = new Set();

        for (const s of slikData.recordset) {
            try {
                let parsedData;
                if (typeof s.slik_data === 'string') {
                    parsedData = JSON.parse(s.slik_data);
                } else {
                    parsedData = s.slik_data;
                }

                const jenisSlik = (parsedData.jenis || 'DEBITUR').toString().toUpperCase();
                const indexSlik = parsedData.index ?? '';
                const slikPersonKey = `${jenisSlik}:${indexSlik}`;
                if (latestSlikByPerson.has(slikPersonKey)) {
                    continue;
                }
                latestSlikByPerson.add(slikPersonKey);

                listSlik.push({
                    nama: parsedData.nama_debitur || 'Tidak diketahui',
                    nik: parsedData.nik || '-',
                    status_slik: parsedData.kesimpulan || 'Tidak diketahui',
                    detail_slik: parsedData.kesimpulan || null,
                    created_at: s.created_at,
                    jenis: parsedData.jenis || 'DEBITUR',
                    index: parsedData.index ?? null,
                    kredit: parsedData.kredit || [],
                    tanggal_lahir: parsedData.tanggal_lahir || '-',
                    alamat: parsedData.alamat || '-',
                    npwp: parsedData.npwp || '-',
                });

                if (!slikCheck) {
                    slikCheck = {
                        nama_debitur: parsedData.nama_debitur || 'Tidak diketahui',
                        identitas: parsedData.nik || '-',
                        status_slik: parsedData.kesimpulan || 'Tidak diketahui',
                        tanggal_cek: s.created_at,
                        keterangan: parsedData.kesimpulan || null,
                        jenis: parsedData.jenis || 'DEBITUR',
                        index: parsedData.index ?? null,
                        kredit: parsedData.kredit || [],
                        tanggal_lahir: parsedData.tanggal_lahir || '-',
                        alamat: parsedData.alamat || '-',
                        npwp: parsedData.npwp || '-',
                    };
                }
            } catch (e) {
                console.error('Error parsing SLIK data:', e);
                listSlik.push({
                    slik_data: s.slik_data,
                    created_at: s.created_at,
                    nama: 'Error parsing',
                    nik: '-',
                    status_slik: 'Error',
                });
            }
        }

        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Data tidak ditemukan' });
        }

        // Format data DUKCAPIL
        const dukcapilCheck = [];
        if (verifikasiDukcapil.recordset.length > 0) {
            const latestValue = (field) => {
                const row = verifikasiDukcapil.recordset.find(item => item[field] !== null && item[field] !== undefined && item[field] !== '');
                return row ? row[field] : null;
            };
            const v = {
                status_debitur: latestValue('status_debitur'),
                status_pasangan: latestValue('status_pasangan'),
                catatan_admin: latestValue('catatan_admin'),
                catatan_admin_debitur: latestValue('catatan_admin_debitur'),
                catatan_admin_pasangan: latestValue('catatan_admin_pasangan'),
                file_hasil_dukcapil_debitur: latestValue('file_hasil_dukcapil_debitur'),
                file_hasil_dukcapil_pasangan: latestValue('file_hasil_dukcapil_pasangan'),
            };
            dukcapilCheck.push({
                nik: result.recordset[0].no_ktp || result.recordset[0].npwp,
                nama: result.recordset[0].nama_debitur || result.recordset[0].nama_perusahaan,
                status: v.status_debitur == 1 ? 'VALID' : 'INVALID',
                jenis: 'DEBITUR',
                catatan_admin: v.catatan_admin_debitur || v.catatan_admin,
                foto_bukti_url: v.file_hasil_dukcapil_debitur,
            });

            if (result.recordset[0].nama_pasangan && result.recordset[0].nama_pasangan != 'null') {
                dukcapilCheck.push({
                    nik: result.recordset[0].ktp_pasangan,
                    nama: result.recordset[0].nama_pasangan,
                    status: v.status_pasangan == 1 ? 'VALID' : 'INVALID',
                    jenis: 'PASANGAN',
                    catatan_admin: v.catatan_admin_pasangan || v.catatan_admin,
                    foto_bukti_url: v.file_hasil_dukcapil_pasangan,
                });
            }
        }

        for (const p of pengajuanDukcapil.recordset) {
            const jenis = (p.jenis || '').toUpperCase();
            const itemIndex = Number(p.index_ke) || 0;
            const isPenjamin = jenis === 'PENJAMIN';
            const sumberData = isPenjamin
                ? (penjamin.recordset[itemIndex] || {})
                : (pendiri.recordset[itemIndex] || {});

            dukcapilCheck.push({
                nik: isPenjamin
                    ? (sumberData.ktp_penjamin || 'Penjamin')
                    : (sumberData.ktp_pendiri || 'Pengurus'),
                nama: isPenjamin
                    ? (sumberData.nama_penjamin || `Penjamin ${itemIndex + 1}`)
                    : (sumberData.nama_pendiri || `Pengurus ${itemIndex + 1}`),
                status: p.status_dukcapil == 1 ? 'VALID' : 'INVALID',
                jenis: isPenjamin ? 'PENJAMIN' : 'PENGURUS',
                index: itemIndex,
                catatan_admin: p.catatan_admin,
                foto_bukti_url: p.file_hasil_dukcapil,
            });
        }

        const responseData = {
            ...result.recordset[0],
            list_penjamin: penjamin.recordset,
            list_pendiri: pendiri.recordset,
            list_jaminan: jaminan.recordset.map((item) => {
                try {
                    const parsed = typeof item.data_jaminan === 'string'
                        ? JSON.parse(item.data_jaminan)
                        : item.data_jaminan;
                    return {
                        id_jaminan: item.id_jaminan,
                        jenis_jaminan: item.jenis_jaminan,
                        ...(parsed || {}),
                    };
                } catch (_) {
                    return {
                        id_jaminan: item.id_jaminan,
                        jenis_jaminan: item.jenis_jaminan,
                    };
                }
            }),
            dukcapil_check: dukcapilCheck,
            list_slik: listSlik,
            slik_check: slikCheck,
        };

        res.json(responseData);
    } catch (error) {
        console.error('Error detail:', error);
        res.status(500).json({ message: error.message, stack: error.stack });
    }
});

// DELETE - Hapus Pengajuan
router.delete('/api/pengajuan/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        const notificationSummary = await getPengajuanNotificationSummary(pool, id);
        const deletedStorageFiles = await cleanupPengajuanStorage(pool, id);
        const deletedTables = await deletePengajuanDatabaseRows(pool, id);

        const uploadDir = path.resolve(__dirname, '../../../uploads/pengajuan', id);
        await fs.rm(uploadDir, { recursive: true, force: true });
        const whatsappNotification = await notifyWorkflowUsersSafe(pool, {
            idPengajuan: id,
            fallback: notificationSummary,
            targetOverride: deleteNotificationTarget,
            event: 'delete',
        });
        res.json({
            status: 'success',
            message: 'Pengajuan berhasil dihapus',
            deleted_storage_files: deletedStorageFiles,
            deleted_database_tables: deletedTables,
            whatsapp_notification: whatsappNotification,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Di pengajuan.js, tambahkan:
router.post('/api/pengajuan/slik/:id', async (req, res) => {
    const { id } = req.params;
    const { slik_data, jenis, index } = req.body;

    try {
        const pool = await getPool();
        const normalizedJenis = (jenis || slik_data?.jenis || 'DEBITUR').toString().toUpperCase();
        const normalizedIndex = index ?? slik_data?.index ?? null;
        const finalSlikData = {
            ...(slik_data || {}),
            jenis: normalizedJenis,
            index: normalizedIndex,
        };

        await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .input('jenis', sql.VarChar, normalizedJenis)
            .input('index_key', sql.VarChar, normalizedIndex === null || normalizedIndex === undefined ? '' : normalizedIndex.toString())
            .input('slik_data', sql.NVarChar, JSON.stringify(finalSlikData))
            .input('created_at', sql.DateTime, new Date())
            .query(`
        DELETE FROM t_pengajuan_slik
        WHERE id_pengajuan = @id_pengajuan
          AND UPPER(ISNULL(JSON_VALUE(slik_data, '$.jenis'), 'DEBITUR')) = @jenis
          AND ISNULL(JSON_VALUE(slik_data, '$.index'), '') = @index_key

        INSERT INTO t_pengajuan_slik (id_pengajuan, slik_data, created_at)
        VALUES (@id_pengajuan, @slik_data, @created_at)
      `);

        res.json({ status: 'success', message: 'Data SLIK berhasil disimpan' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});


// Endpoint untuk upload file TTD
// ==================== UPLOAD TTD ====================

// Endpoint untuk upload file TTD
router.post('/api/pengajuan/upload-ttd', upload.single('ttd_file'), async (req, res) => {
    try {
        const { id_pengajuan, tipe_ttd, index_ke } = req.body;
        // tipe_ttd: 'debitur', 'pasangan', 'penjamin', 'pendiri'

        if (!req.file) {
            return res.status(400).json({ status: 'error', message: 'File TTD tidak ditemukan' });
        }

        const filename = `${Date.now()}-ttd-${tipe_ttd}-${safeFilename(req.file.originalname)}`;
        const ttdUrl = await uploadToB2({
            key: `pengajuan/${id_pengajuan}/ttd/${filename}`,
            buffer: req.file.buffer,
            contentType: req.file.mimetype,
        });

        const pool = await getPool();

        // Simpan URL ke database sesuai tipe
        if (tipe_ttd === 'debitur') {
            // Cek apakah kolom ttd_debitur sudah ada
            await ensureColumn(pool, 't_debitur_perorangan', 'ttd_debitur', 'NVARCHAR(500)');
            await pool.request()
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('ttd_url', sql.NVarChar, ttdUrl)
                .query(`UPDATE t_debitur_perorangan SET ttd_debitur = @ttd_url WHERE id_pengajuan = @id_pengajuan`);

        } else if (tipe_ttd === 'pasangan') {
            await ensureColumn(pool, 't_debitur_perorangan', 'ttd_pasangan', 'NVARCHAR(500)');
            await pool.request()
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('ttd_url', sql.NVarChar, ttdUrl)
                .query(`UPDATE t_debitur_perorangan SET ttd_pasangan = @ttd_url WHERE id_pengajuan = @id_pengajuan`);

        } else if (tipe_ttd === 'penjamin') {
            await ensureColumn(pool, 't_pengajuan_penjamin', 'ttd_penjamin', 'NVARCHAR(500)');
            const penjaminIndex = parseInt(index_ke) + 1;
            await pool.request()
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('ttd_url', sql.NVarChar, ttdUrl)
                .query(`UPDATE t_pengajuan_penjamin SET ttd_penjamin = @ttd_url WHERE id_pengajuan = @id_pengajuan AND id_penjamin = (SELECT MAX(id_penjamin) FROM t_pengajuan_penjamin WHERE id_pengajuan = @id_pengajuan)`);

        } else if (tipe_ttd === 'pendiri') {
            await ensureColumn(pool, 't_pengajuan_pendiri', 'ttd_pendiri', 'NVARCHAR(500)');
            const pendiriIndex = parseInt(index_ke) + 1;
            await pool.request()
                .input('id_pengajuan', sql.VarChar, id_pengajuan)
                .input('ttd_url', sql.NVarChar, ttdUrl)
                .query(`UPDATE t_pengajuan_pendiri SET ttd_pendiri = @ttd_url WHERE id_pengajuan = @id_pengajuan AND id_pendiri = @id_pendiri`);
        }

        res.json({
            status: 'success',
            message: 'File TTD berhasil diupload',
            url: ttdUrl
        });

    } catch (error) {
        console.error('Upload TTD error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Helper function untuk memastikan kolom ada
async function ensureColumn(pool, tableName, columnName, columnType) {
    try {
        await pool.request().query(`
            IF COL_LENGTH('dbo.${tableName}', '${columnName}') IS NULL
            BEGIN
                ALTER TABLE dbo.${tableName} ADD ${columnName} ${columnType} NULL
            END
        `);
    } catch (error) {
        console.log(`Note: Ensure column ${columnName} in ${tableName} - ${error.message}`);
    }
}

router.get('/api/nasabah/proses', async (req, res) => {
    try {
        const pool = await getPool();

        const result = await pool.request().query(`
      SELECT
        p.id_pengajuan,
        p.jenis_debitur,
        p.plafon_pengajuan,
        p.tenor_bulan,
        p.tgl_pengajuan,
        p.status_pengajuan,
        p.stsflag,

        COALESCE(dp.nama_debitur, dbu.nama_perusahaan, '-') AS nama_nasabah,
        COALESCE(dp.no_ktp, dbu.npwp, '-') AS identitas,

        CASE 
          WHEN p.stsflag = 1 THEN 'Pre FPK'
          WHEN p.stsflag = 2 THEN 'FPK Pengajuan'
          WHEN p.stsflag = 3 THEN 'Checklist Kelengkapan'
          WHEN p.stsflag = 4 THEN 'Survey Debitur'
          WHEN p.stsflag = 5 THEN 'Survey Agunan'
          WHEN p.stsflag = 6 THEN 'Rekap dan Analisa'
          WHEN p.stsflag = 7 THEN 'MUK'
          ELSE 'Tidak diketahui'
        END AS progress_terakhir

      FROM t_pengajuan p
      LEFT JOIN t_debitur_perorangan dp 
        ON dp.id_pengajuan = p.id_pengajuan
      LEFT JOIN t_debitur_badan_usaha dbu 
        ON dbu.id_pengajuan = p.id_pengajuan
      WHERE ISNULL(p.stsflag, 0) BETWEEN 1 AND 7
      ORDER BY p.tgl_pengajuan DESC
    `);

        res.json({
            success: true,
            data: result.recordset,
        });
    } catch (err) {
        console.error('GET NASABAH PROSES error:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat daftar nasabah proses',
            error: err.message,
        });
    }
});


router.post('/api/whatsapp/test', async (req, res) => {
    try {
        const { nohp } = req.body;

        if (!nohp) {
            return res.status(400).json({
                success: false,
                message: 'Nomor HP wajib diisi',
            });
        }

        const data = await sendWhatsAppTemplate(nohp);
        if (data?.skipped) {
            return res.status(400).json({
                success: false,
                message: data.reason || 'Konfigurasi WhatsApp belum lengkap',
            });
        }

        res.json({
            success: true,
            message: 'Pesan tes WhatsApp berhasil dikirim',
            data,
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
});

function val(value) {
    if (value === null || value === undefined) return '-';

    const text = String(value).trim();

    if (!text || text.toLowerCase() === 'null') {
        return '-';
    }

    return text;
}
function formatAngkaRupiah(value) {
    if (value === null || value === undefined) return '-';

    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return '-';
        return new Intl.NumberFormat('id-ID').format(Math.round(value));
    }

    let text = String(value).trim();
    if (!text || text.toLowerCase() === 'null') return '-';

    text = text.replace(/[^\d,.-]/g, '');

    const hasComma = text.includes(',');
    const hasDot = text.includes('.');

    if (hasComma && hasDot) {
        if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
            text = text.replace(/\./g, '').replace(',', '.');
        } else {
            text = text.replace(/,/g, '');
        }
    } else if (hasComma) {
        text = text.replace(/\./g, '').replace(',', '.');
    } else if (hasDot) {
        const parts = text.split('.');
        if (parts.length > 2) {
            text = text.replace(/\./g, '');
        } else if (parts[1]?.length === 3) {
            text = text.replace(/\./g, '');
        }
    }

    const number = Number(text);
    if (!Number.isFinite(number) || number <= 0) return '-';

    return new Intl.NumberFormat('id-ID').format(Math.round(number));
}


router.get('/api/laporan/:id/analisa', async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await getPool();
        await ensureMukTable(pool);
        await ensureRekapAnalisaTable(pool);

        const result = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT TOP 1
          p.*,
          dp.*,
          dbu.*,
          dd.alamat_debitur AS detail_alamat_debitur,
          dd.alamat_domisili_debitur AS detail_alamat_domisili_debitur,
          dd.nama_ibu_kandung,
          dd.status_menikah,
          dd.tgl_berlaku_ktp,
          dps.alamat_pasangan,
          dps.alamat_domisili_pasangan,
          du.form_pekerjaan,
          du.bekerja,
          du.nama_perusahaan_kerja,
          du.jabatan,
          du.lama_bekerja,
          du.gaji,
          du.nama_usaha,
          du.lama_usaha,
          du.alamat_usaha,
          du.telp_usaha,
          du.sektor_usaha,
          dk.referensi,
          dk.nama_referensi,
          dk.hubungan_dengan_bank,
          dk.tujuan_penggunaan,
          dk.jumlah_pengajuan_kredit,
          dk.jangka_waktu_bulan,
          dk.bunga_per_tahun,
          dk.jenis_hitung_bunga,
          dk.jenis_kredit,
          dk.no_rekening_bank_lain,
          dk.sumber_pembayaran_kredit,
          dk.detail_tujuan,
          dk.sindikasi,
          dk.alasan,
          ph.pendapatan_usaha_debitur,
          ph.total_penghasilan_debitur,
          ph.total_biaya_perbulan
        FROM t_pengajuan p
        LEFT JOIN t_debitur_perorangan dp
          ON CAST(dp.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_debitur_badan_usaha dbu
          ON CAST(dbu.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_detail_debitur dd
          ON CAST(dd.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_detail_pasangan_debitur dps
          ON CAST(dps.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_detail_usaha_debitur du
          ON CAST(du.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_debitur_data_kredit dk
          ON CAST(dk.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        LEFT JOIN t_debitur_data_penghasilan ph
          ON CAST(ph.id_pengajuan AS VARCHAR(50)) = CAST(p.id_pengajuan AS VARCHAR(50))
        WHERE p.id_pengajuan = @id_pengajuan
      `);

        if (!result.recordset.length) {
            return res.status(404).json({ message: 'Data pengajuan tidak ditemukan' });
        }

        const jaminan = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS id_jaminan,
               jenis_jaminan, data_jaminan
        FROM t_debitur_data_jaminan
        WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id_pengajuan
      `);

        const penjamin = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT id_penjamin, nama_penjamin, ktp_penjamin,
               hubungan_debitur, no_hp_penjamin, tempat_lahir, tanggal_lahir
        FROM t_pengajuan_penjamin
        WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id_pengajuan
        ORDER BY id_penjamin ASC
      `);

        const pendiri = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT id_pendiri, nama_pendiri, ktp_pendiri, jabatan,
               persentase_saham, alamat_ktp, alamat_domisili, no_hp
        FROM t_pengajuan_pendiri
        WHERE CAST(id_pengajuan AS VARCHAR(50)) = @id_pengajuan
        ORDER BY id_pendiri ASC
      `);

        const mukResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT TOP 1 muk_data
        FROM t_pengajuan_muk
        WHERE id_pengajuan = @id_pengajuan
        ORDER BY updated_at DESC, created_at DESC
      `);

        let mukData = {};
        try {
            const rawMuk = mukResult.recordset[0]?.muk_data;
            mukData = rawMuk ? JSON.parse(rawMuk) : {};
        } catch (_) {
            mukData = {};
        }

        const listJaminan = (jaminan.recordset || []).map((item) => {
            try {
                const parsed = typeof item.data_jaminan === 'string'
                    ? JSON.parse(item.data_jaminan)
                    : item.data_jaminan;
                return {
                    id_jaminan: item.id_jaminan,
                    jenis_jaminan: item.jenis_jaminan,
                    ...(parsed || {}),
                };
            } catch (_) {
                return {
                    id_jaminan: item.id_jaminan,
                    jenis_jaminan: item.jenis_jaminan,
                };
            }
        });

        const surveyUsahaResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
        SELECT TOP 1 usaha_data
        FROM t_pengajuan_survey_debitur_usaha
        WHERE id_pengajuan = @id_pengajuan
    `);

        let surveyUsahaItems = [];

        try {
            const rawUsaha = surveyUsahaResult.recordset[0]?.usaha_data;
            const usahaData = rawUsaha ? JSON.parse(rawUsaha) : {};
            surveyUsahaItems = Array.isArray(usahaData.items) ? usahaData.items : [];
        } catch (_) {
            surveyUsahaItems = [];
        }

        const pendapatanUsahaDebiturSurvey =
            totalUsahaBersihSurvey(surveyUsahaItems, 'debitur');

        const pendapatanUsahaPasanganSurvey =
            totalUsahaBersihSurvey(surveyUsahaItems, 'pasangan');
        const kemampuan =
            mukData.analisa_kemampuan_bayar ||
            mukData.analisaKemampuanBayar ||
            mukData.kemampuan_bayar ||
            mukData.kemampuanBayar ||
            {};

        const row = result.recordset[0] || {};
        const biayaPendapatanResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT jenis, nominal
                FROM t_pengajuan_survey_debitur_biaya_pendapatan
                WHERE id_pengajuan = @id_pengajuan
            `);
        const rekapAnalisaResult = await pool.request()
            .input('id_pengajuan', sql.VarChar, id)
            .query(`
                SELECT TOP 1 selected_slik
                FROM t_pengajuan_rekap_analisa
                WHERE id_pengajuan = @id_pengajuan
            `);

        const biayaPendapatanRows = biayaPendapatanResult.recordset || [];
        const totalByJenis = (jenis) => biayaPendapatanRows
            .filter((item) => String(item.jenis || '').trim().toUpperCase() === jenis)
            .reduce((sum, item) => sum + (nullableNumber(item.nominal) || 0), 0);

        let selectedSlik = [];
        try {
            const rawSelectedSlik = rekapAnalisaResult.recordset[0]?.selected_slik;
            selectedSlik = typeof rawSelectedSlik === 'string'
                ? JSON.parse(rawSelectedSlik || '[]')
                : Array.isArray(rawSelectedSlik)
                    ? rawSelectedSlik
                    : [];
        } catch (_) {
            selectedSlik = [];
        }

        const totalAngsuranSlik = (ownerTest) => selectedSlik
            .filter((item) => {
                const status = String(item.status || '').trim().toLowerCase();
                const owner = String(item.jenis_pemilik || item.ownerJenis || item.jenis || '').trim().toUpperCase();
                return (status === 'diperhitungkan' || status === 'take over') && ownerTest(owner);
            })
            .reduce((sum, item) => sum + (nullableNumber(item.angsuran) || 0), 0);

        const pickNumber = (...values) => {
            for (const value of values) {
                const number = nullableNumber(value);
                if (number !== null && number > 0) return number;
            }
            return 0;
        };

        const gajiDebitur = pickNumber(kemampuan.gaji_debitur, row.gaji);
        const pendapatanUsahaDebitur = pickNumber(
            kemampuan.pendapatan_usaha_debitur,
            pendapatanUsahaDebiturSurvey,
            row.pendapatan_usaha_debitur
        );
        const gajiPasangan = pickNumber(kemampuan.gaji_pasangan, row.gaji_pasangan);
        const pendapatanUsahaPasangan = pickNumber(
            kemampuan.pendapatan_usaha_pasangan,
            pendapatanUsahaPasanganSurvey
        );
        const pendapatanLainnya = pickNumber(kemampuan.pendapatan_lainnya, totalByJenis('PENDAPATAN'));
        const totalPendapatan = pickNumber(
            kemampuan.total_pendapatan,
            gajiDebitur + pendapatanUsahaDebitur + gajiPasangan + pendapatanUsahaPasangan + pendapatanLainnya
        );
        const totalPengeluaran = pickNumber(kemampuan.total_pengeluaran, totalByJenis('PENGELUARAN'));
        const kewajibanExisting = pickNumber(
            kemampuan.kewajiban_existing,
            totalAngsuranSlik((owner) => owner === 'DEBITUR' || owner === 'PASANGAN')
        );
        const kewajibanExistingPenjamin = pickNumber(
            kemampuan.kewajiban_existing_penjamin,
            totalAngsuranSlik((owner) => owner === 'PENJAMIN')
        );
        const pendapatanBersih = pickNumber(
            kemampuan.pendapatan_bersih,
            totalPendapatan - totalPengeluaran - kewajibanExisting - kewajibanExistingPenjamin
        );
        const angsuranBaru = pickNumber(kemampuan.angsuran_baru, kemampuan.angsuran_fasilitas_baru, mukData.angsuran);
        const totalAngsuran = pickNumber(kemampuan.total_angsuran, kewajibanExisting + angsuranBaru);
        const dsr = pickNumber(
            kemampuan.dsr,
            pendapatanBersih > 0 ? (totalAngsuran / pendapatanBersih) * 100 : 0
        );

        res.json({
            ...row,
            ...mukData,

            gaji_debitur: gajiDebitur,
            pendapatan_usaha_debitur: pendapatanUsahaDebitur,
            gaji_pasangan: gajiPasangan,
            pendapatan_usaha_pasangan: pendapatanUsahaPasangan,
            pendapatan_lainnya: pendapatanLainnya,
            total_pendapatan: totalPendapatan,
            total_pengeluaran: totalPengeluaran,
            kewajiban_existing: kewajibanExisting,
            kewajiban_existing_penjamin: kewajibanExistingPenjamin,
            pendapatan_bersih: pendapatanBersih,
            angsuran_baru: angsuranBaru,
            total_angsuran: totalAngsuran,
            dsr,

            id_pengajuan: row.id_pengajuan || id,
            nama_nasabah: row.nama_debitur || row.nama_perusahaan || mukData.nama_calon_debitur || '-',
            list_jaminan: listJaminan,
            list_penjamin: penjamin.recordset || [],
            list_pendiri: pendiri.recordset || [],
            survey_usaha: surveyUsahaItems,
            usaha: {
                items: surveyUsahaItems,
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            message: err.message,
        });
    }
});
module.exports = router;
