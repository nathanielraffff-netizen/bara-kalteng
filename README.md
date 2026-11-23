# BARA/KALTENG — WebGIS bahaya karhutla Kalimantan Tengah

WebGIS statis (Leaflet 1.9.4, tanpa server) untuk PjBL GD4103 SIG, Kelompok 2 Kelas 3.
Periode data 1 Agustus – 31 Oktober 2026.

## Isi folder

```
bara-kalteng/
├── index.html                  halaman utama
├── css/style.css               tampilan monokrom
├── js/config.js                PENGATURAN: bobot AHP, judul, warna kelas
├── js/app.js                   logika peta, model on-the-fly, statistik
├── data/                       DIISI oleh skrip (awalnya kosong)
└── tools/siapkan_data_webgis.py  skrip penyiapan data (jalan di QGIS)
```

## Langkah 1 — Unduh data dari Drive

Unduh ketiga folder Drive kelompok (klik kanan › Download), lalu ekstrak:
1. **Data Yang Digunakan**: titik api, gambut, tutupan lahan, NDVI, CHIRPS, LST, SRTM, jalan/sungai/places, batas administrasi.
2. Folder berisi **01_Proyek_QGIS, 02_Data_Vektor, 03_Data_Raster**: `Zonal_Histogram_KabKota.gpkg` (batas 14 kab/kota), `gambut_kalteng_gfw.shp`.
3. Folder berisi **Indeks_Kerawanan_Karhutla_Kalteng_FIXXX.tif, final_index_reclass.tif, Skor_*.tif**: hasil model AHP kelompok.

Beberapa raster berukuran >1 GB, jadi unduhnya bisa lama. `sungai_besar.tif` dan `sungai_kecil.tif` tidak dipakai, jadi boleh dilewati.
Struktur subfolder tidak perlu diubah karena skrip mencari berkas berdasarkan nama.

## Langkah 2 — Jalankan skrip penyiapan data (sekali saja)

1. Buka `tools/siapkan_data_webgis.py`, isi `DATA_DIRS` dengan lokasi ketiga folder dan `OUT_DIR` dengan folder `data` paket ini.
2. QGIS › Plugins › **Python Console** › ikon **Show Editor** › buka berkas skrip › **Run Script**.
3. Tunggu sampai muncul `[BARA] SELESAI`. Raster besar butuh beberapa menit.

Skrip menghasilkan di folder `data/`:

| Berkas | Isi |
| --- | --- |
| `meta.json` | daftar parameter, kabupaten, layer, grid |
| `stack.bin` | skor kriteria 0–250, kelas QGIS, kabupaten, gambut, area terbakar per sel 0,01° |
| `kelas_qgis.png`, `skor_iklim.png`, `skor_akses.png`, `skor_lahan.png` | peta bahaya resmi dan skor kriteria |
| `statistik_qgis.json` | tabel luas K1–K5 per kab/kota (sudah disertakan) |
| `kabupaten.geojson` | batas kabupaten (disederhanakan) |
| `titik_api.json` | titik api VIIRS, MODIS, SiPongi+ periode Agu–Okt 2026 |
| `gambut.geojson`, `jalan.geojson`, `sungai.geojson`, `permukiman.geojson` | layer vektor |
| `tutupan.png`, `ndvi.png`, `hujan.png`, `lst.png`, `jarak_mukim.png`, `topografi.png`, `bakar.png` | layer raster tampilan |

**Model kelompok.** Skrip membaca indeks kerawanan dan tiga skor kriteria, lalu:
- merekonstruksi bobot AHP dengan regresi `indeks = c0 + w1·iklim + w2·akses + w3·lahan` (lihat `regresi indeks: w = … R2 = …` di console). Bila R² mendekati 1, bobotnya sama dengan yang dipakai di QGIS. Bila R² < 0,98, isi bobot AHP asli di `js/config.js`.
- mengambil ambang kelas K1–K5 dari `final_index_reclass.tif`, sehingga dengan bobot awal model on-the-fly menghasilkan kelas yang sama dengan peta resmi (lihat "Kecocokan kelas dengan peta QGIS" di panel Validasi).
- menyimpan `final_index_reclass` sebagai layer "Peta bahaya (hasil QGIS)". `statistik_qgis.json` (tabel luas K1–K5 per kab/kota dari `Tabel_Luas_Distribusi_Kelas_Kabkota.xlsx`) sudah ada di folder `data/` dan tidak perlu dibuat ulang.

Kalau hasil model QGIS tidak ditemukan, skrip otomatis memakai parameter mentah (gambut, tutupan, NDVI, hujan, LST, jarak) sebagai cadangan.

**Baca keluaran console.** Skrip mencetak nama field yang ditemukan. Hal yang perlu dicek:
- `field nama kabupaten:` harus berisi field nama kabupaten (mis. `WADMKK`). Kalau `None` atau jumlah unit lebih dari 60, tambahkan nama field yang benar ke daftar kandidat di fungsi `baca_kabupaten`.
- `kode tutupan lahan:` dan `skema kelas dianggap:` memastikan skor bahan bakar dipakai dengan benar (Dynamic World 0–8 atau ESA WorldCover 10–100).
- `field tanggal/jam/conf/frp:` untuk ketiga sumber titik api. Kalau field tanggal SiPongi tidak dikenali, tambahkan namanya di `baca_titik`.

## Langkah 3 — Cek bobot

Bobot awal otomatis diambil dari hasil rekonstruksi di `data/meta.json`. `js/config.js` hanya dipakai bila model QGIS tidak ditemukan.

## Langkah 4 — Coba di laptop

Browser memblokir pembacaan data kalau `index.html` dibuka langsung (dobel klik). Jalankan server lokal:

```
cd bara-kalteng
python -m http.server 8000
```

lalu buka `http://localhost:8000`.

## Langkah 5 — Terbitkan di GitHub Pages (URL stabil, gratis)

1. Buat repositori publik di GitHub, misalnya `bara-kalteng`.
2. **Add file › Upload files**, lalu seret seluruh isi folder (termasuk `data/`).
3. **Settings › Pages › Source: Deploy from a branch › main / (root) › Save**.
4. Setelah 1–2 menit, situs ada di `https://<username>.github.io/bara-kalteng/`.

Batas GitHub: 100 MB per berkas, situs maksimal 1 GB. Kalau `titik_api.json` atau `jalan.geojson` terlalu besar, naikkan `SIMPLIFY_TOL` atau kurangi `KELAS_JALAN` di skrip.

## Fitur

- Layer dalam tiga kelompok KAK: parameter, hasil model, dampak dan validasi.
- Basemap terang, gelap, atau citra; skala, koordinat kursor, legenda dinamis, pop-up.
- **Model on-the-fly**: geser bobot, peta bahaya 5 kelas dan semua statistik dihitung ulang di browser. Klasifikasi interval sama atau kuantil.
- **Time slider** titik api (kumulatif atau harian), animasi, saring sumber dan confidence.
- Statistik per kabupaten: luas bahaya tinggi+, gambut di bahaya tinggi+, permukiman terpapar, titik api, dan peringkat kabupaten.
- Validasi live: kepadatan titik api per kelas dan persentase area terbakar historis di kelas tinggi+.
- Unduh titik api terfilter (GeoJSON) dan statistik kabupaten (CSV, mencatat bobot yang dipakai).
- Halaman Metode, Data, dan Tentang terisi otomatis dari `meta.json`.

## Asumsi yang perlu dicek kelompok

- **Arah parameter**: gambut, semak/rumput, NDVI rendah, hujan rendah, LST tinggi, dekat permukiman/jalan/sungai dianggap makin rawan.
- **Skor tutupan lahan** per kelas ada di `SKOR_DYNAMIC_WORLD` / `SKOR_WORLDCOVER` dalam skrip. Sesuaikan dengan reklasifikasi kelompok bila berbeda.
- **Curah hujan** yang berisi banyak band dijumlahkan, sedangkan LST yang berisi banyak band dirata-ratakan.
- Perkebunan dan permukiman (OSM `places`) hanya dipakai untuk analisis dampak, bukan sebagai parameter model.
- Peta bahaya di WebGIS dihitung dari parameter di grid 0,01° (sekitar 1,1 km), jadi bisa sedikit berbeda dari hasil QGIS resolusi penuh. Validasi resmi (ROC/AUC) tetap dari QGIS.

## Referensi metode

Chuvieco & Congalton (1989) RSE 29:147–159 · Chuvieco et al. (2004) RSE 92:322–331 ·
Malczewski (1999) *GIS and Multicriteria Decision Analysis* · Saaty (1980) *The Analytic Hierarchy Process* ·
Page et al. (2002) Nature 420:61–65 · Hooijer et al. (2010) Biogeosciences 7:1505–1514 ·
Richards (2013) *Remote Sensing Digital Image Analysis* · Schroeder et al. (2014) RSE 143:85–96 ·
Giglio et al. (2016) RSE 178:31–41 · Funk et al. (2015) Sci. Data 2:150066 · Wan (2014) RSE 140:36–45.
