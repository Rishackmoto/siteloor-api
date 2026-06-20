router.post('/api/login', async (req, res) => {
    console.time('LOGIN');

    try {
        const { userid, pass } = req.body;

        if (!userid || !pass) {
            console.timeEnd('LOGIN');
            return res.status(400).json({
                success: false,
                message: 'User ID dan password wajib diisi',
            });
        }

        const pool = await getPool();

        const result = await pool.request()
            .input('userid', sql.VarChar(30), userid)
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

        if (!user || String(user.pass).trim() !== String(pass).trim()) {
            console.timeEnd('LOGIN');
            return res.status(401).json({
                success: false,
                message: 'User ID atau password salah / user tidak aktif',
            });
        }

        const { pass: _ignoredPass, ...safeUser } = user;

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

        return res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server',
            error: error.message,
        });
    }
});