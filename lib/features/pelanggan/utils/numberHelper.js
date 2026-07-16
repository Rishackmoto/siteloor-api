function parseIndonesianNumber(str) {
  if (!str) return 0;
  // Hapus spasi, lalu ganti titik ribuan dengan kosong, koma desimal jadi titik
  let cleaned = str.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  // Ambil hanya angka, tanda minus, dan titik desimal
  const match = cleaned.match(/^-?\d+(\.\d+)?/);
  if (!match) return 0;
  return parseFloat(match[0]);
}

function formatDateDMYtoISO(dateStr) {
  // dd/MM/yyyy -> ISO
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`;
}

module.exports = { parseIndonesianNumber, formatDateDMYtoISO };