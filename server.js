const express = require('express');
const cors = require('cors');

require('./lib/config/env');

const app = express();

// IMPORT ROUTE
const pengajuanRoute = require('./lib/features/pengajuan/data/pengajuan');
app.use(pengajuanRouter);

(async () => {
  await pengajuanRouter.initializeDatabase();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
const listPengajuanRoute = require('./lib/features/pengajuan/data/listpengajuan');
const path = require('path');



// MIDDLEWARE
app.use(cors({
    origin: '*',
    methods: ['GET','POST','PUT','DELETE'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
app.use((req, res, next) => {

    res.header(
        'Access-Control-Allow-Origin',
        '*'
    );

    res.header(
        'Cross-Origin-Resource-Policy',
        'cross-origin'
    );

    next();

});
// UPLOAD GAMBAR
app.use(
  '/uploads',
  express.static(
    path.join(__dirname, 'uploads')
  )
);
// ROUTE
app.use(pengajuanRoute);
app.use(listPengajuanRoute);

// TEST
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.send('API LAS berjalan...');
});

// JALANKAN SERVER
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
