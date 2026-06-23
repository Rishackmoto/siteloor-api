const express = require('express');
const cors = require('cors');

require('./lib/config/env');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// IMPORT ROUTE
const pengajuanRoute = require('./lib/features/pengajuan/data/pengajuan');
const laporanRoute = require('./lib/features/laporan/data/laporan');

// MIDDLEWARE
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ROUTE
app.use(pengajuanRoute);
app.use('/api/laporan', laporanRoute);

// TEST
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'siteloor-api',
  });
});

app.get('/', (req, res) => {
  res.send('API SITELOOR berjalan...');
});

// JALANKAN SERVER
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  console.log('SERVER FILE:', __filename);
});
