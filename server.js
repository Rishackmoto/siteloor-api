const express = require('express');
const cors = require('cors');
const path = require('path');

require('./lib/config/env');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// IMPORT ROUTE
const pengajuanRoute = require('./lib/features/pengajuan/data/pengajuan');
const pengajuanStatusRoute = require('./lib/features/pengajuan/data/status');
const listPengajuanRoute = require('./lib/features/pengajuan/data/listpengajuan');

// MIDDLEWARE
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// UPLOAD GAMBAR
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ROUTE
app.use(pengajuanStatusRoute);
app.use(pengajuanRoute);
app.use(listPengajuanRoute);

// TEST
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send('API HONAI berjalan...');
});

// JALANKAN SERVER
(async () => {
  try {
    if (typeof pengajuanRoute.initializeDatabase === 'function') {
      await pengajuanRoute.initializeDatabase();
    }

    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT}`);
    });
  } catch (error) {
    console.error('STARTUP ERROR:', error);
    process.exit(1);
  }
})();
