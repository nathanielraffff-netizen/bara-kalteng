// =====================================================================
// PENGATURAN WEBGIS BARA/KALTENG — ubah di sini, tidak perlu menyentuh app.js
// =====================================================================
window.BARA_CONFIG = {
  judul: "BARA/KALTENG",
  subjudul: "WebGIS bahaya karhutla · Kelompok 2 · Kelas 3",

  // Folder hasil skrip tools/siapkan_data_webgis.py
  dataDir: "data/",

  // Bobot AHP kelompok (angka relatif, otomatis dinormalisasi ke 100%).
  // Kunci harus sama dengan "key" parameter di data/meta.json:
  // gambut, tutupan, ndvi, hujan, lst, mukim, jalan, sungai
  // GANTI dengan hasil AHP kalian (Saaty, 1980), lalu ubah bobotSudahAHP ke true.
  bobotAHP: {
    gambut: 1,
    tutupan: 1,
    ndvi: 1,
    hujan: 1,
    lst: 1,
    mukim: 1,
    jalan: 1,
    sungai: 1
  },
  bobotSudahAHP: false,

  // "interval" = interval sama antara skor min–maks, "kuantil" = 20% sel per kelas
  metodeKelas: "interval",

  // Warna 5 kelas bahaya (satu hue, terang -> gelap)
  warnaKelas: ["#FFE9E1", "#FFBFA8", "#FF8A63", "#FF4B14", "#A82600"],
  namaKelas: ["Sangat rendah", "Rendah", "Sedang", "Tinggi", "Sangat tinggi"],

  basemap: "terang" // terang | gelap | citra
};
