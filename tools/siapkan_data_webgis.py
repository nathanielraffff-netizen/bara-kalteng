# -*- coding: utf-8 -*-
"""
SIAPKAN DATA WEBGIS BARA/KALTENG
================================
Mengubah data kelompok (folder Google Drive "Data Yang Digunakan") menjadi
berkas ringan yang dibaca WebGIS di folder ../data.

CARA PAKAI (QGIS 3.x, tanpa instalasi tambahan):
  1. Unduh ketiga folder Drive kelompok ke laptop lalu ekstrak.
  2. Ubah DATA_DIRS (tiga folder Drive) dan OUT_DIR di bawah.
  3. QGIS > Plugins > Python Console > Show Editor > buka berkas ini > Run.
     (Bisa juga: OSGeo4W Shell > python siapkan_data_webgis.py)
  4. Tunggu sampai muncul "SELESAI". Raster besar (NDVI, SRTM) bisa makan
     beberapa menit.

Hanya memakai pustaka yang sudah ikut QGIS: GDAL/OGR (osgeo) dan numpy.

DASAR METODE (referensi)
- Faktor bahaya api: vegetasi/bahan bakar, topografi, kedekatan jalan dan
  permukiman -> Chuvieco, E. & Congalton, R.G. (1989). Application of remote
  sensing and geographic information systems to forest fire hazard mapping.
  Remote Sensing of Environment, 29(2), 147-159.
- NDVI dan suhu permukaan (LST) sebagai indikator kekeringan bahan bakar ->
  Chuvieco, E., Cocero, D., Riano, D., et al. (2004). Combining NDVI and
  surface temperature for the estimation of live fuel moisture content in
  forest fire danger rating. Remote Sensing of Environment, 92(3), 322-331.
- Gambut dan kanal drainase sebagai pemicu kebakaran gambut ->
  Page, S.E., et al. (2002). The amount of carbon released from peat and forest
  fires in Indonesia during 1997. Nature, 420, 61-65.
  Hooijer, A., et al. (2010). Current and future CO2 emissions from drained
  peatlands in Southeast Asia. Biogeosciences, 7, 1505-1514.
- Normalisasi skala linear 0-1 dan kombinasi linear berbobot (WLC) ->
  Malczewski, J. (1999). GIS and Multicriteria Decision Analysis. Wiley.
- Pemotongan persentil 2-98% sebelum normalisasi (linear stretch yang tahan
  pencilan) -> Richards, J.A. (2013). Remote Sensing Digital Image Analysis
  (5th ed.). Springer, Bab 4.
- Bobot dari AHP -> Saaty, T.L. (1980). The Analytic Hierarchy Process.
  McGraw-Hill.
- Penyederhanaan garis Douglas-Peucker -> Douglas, D.H. & Peucker, T.K. (1973).
  Cartographica, 10(2), 112-122.
- Hillshade (algoritma Horn di GDAL) -> Horn, B.K.P. (1981). Hill shading and
  the reflectance map. Proceedings of the IEEE, 69(1), 14-47.
- Data: CHIRPS -> Funk, C., et al. (2015). Scientific Data, 2, 150066.
  MODIS LST -> Wan, Z. (2014). Remote Sensing of Environment, 140, 36-45.
  VIIRS 375 m -> Schroeder, W., et al. (2014). RSE, 143, 85-96.
  MODIS C6.1 -> Giglio, L., et al. (2016). RSE, 178, 31-41.
  Dynamic World -> Brown, C.F., et al. (2022). Scientific Data, 9, 251.
  ESA WorldCover -> Zanaga, D., et al. (2022). ESA WorldCover 10 m 2021 v200.
"""

import os
import json
import math
import datetime

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()
gdal.SetConfigOption("SHAPE_RESTORE_SHX", "YES")  # adm_clip_reproject tidak punya .shx

# ---------------------------------------------------------------------------
# 1. UBAH BAGIAN INI
# ---------------------------------------------------------------------------
# Tiga folder Drive yang sudah diunduh dan diekstrak (boleh lebih/kurang).
DATA_DIRS = [
    r"C:\PJBL SIG\Data Yang Digunakan",
    r"C:\PJBL SIG\Hasil Aved",
    r"C:\PJBL SIG\HASIL",
]
OUT_DIR = r"C:\PJBL SIG\bara-kalteng\data"

PERIODE_MULAI = datetime.date(2026, 8, 1)
PERIODE_SELESAI = datetime.date(2026, 10, 31)

GRID_RES = 0.01      # derajat (~1,1 km) untuk model on-the-fly di browser
DISPLAY_RES = 0.004  # derajat (~450 m) untuk gambar layer tampilan
SIMPLIFY_TOL = 0.001 # derajat (~110 m), toleransi Douglas-Peucker
KELAS_JALAN = ["motorway", "trunk", "primary", "secondary", "tertiary",
               "motorway_link", "trunk_link", "primary_link", "secondary_link"]

# Nama berkas di Drive. Skrip mencari nama ini di semua subfolder DATA_DIRS,
# urutan pertama yang ditemukan dipakai.
BERKAS = {
    # batas kabupaten: hasil zonal histogram kelompok (14 kab/kota), cadangan adm BIG
    "adm": ["Zonal_Histogram_KabKota.gpkg", "adm_kalteng.zip", "adm_kalteng/", "adm_clip_reproject.shp"],
    # hasil model kelompok (AHP di QGIS)
    "indeks": ["Indeks_Kerawanan_Karhutla_Kalteng_FIXXX.tif"],
    "kelas": ["final_index_reclass.tif"],
    "skor_iklim": ["Skor_IklimTemperatur.tif"],
    "skor_akses": ["DNTY_SKOR_AKSESIBILITAS_FIX.tif"],
    "skor_lahan": ["Skor_KondisiLahanFIXXX.tif"],
    # parameter dan data pendukung
    "gambut": ["gambut_kalteng_gfw.shp", "Gambut_dissolve_32749.gpkg", "gambut_kalteng.zip", "gambut_kalteng/"],
    "tutupan": ["Tutupan_Lahan_Kalteng_2026.tif"],
    "ndvi": ["NDVI_Kalteng_2026.tif"],
    "hujan": ["Curah_Hujan_CHIRPS_Kalteng_2026.tif"],
    "lst": ["LST_MODIS_Kalteng_JanOkt2026.tif"],
    "dem": ["Topografi_Kalteng_SRTM30m.tif"],
    "jarak_mukim": ["Salinan Jarak_Pemukiman_Kalteng_2026_Murni.tif",
                    "Jarak_Pemukiman_Kalteng_2026_Murni.tif"],
    "bakar": ["area terbakar historis.tif", "area terbakar fikkksss.tif",
              "Area_Terbakar_Historis_Kalteng_2021_2025 (1).tif",
              "Area_Terbakar_Historis_Kalteng_2021_2025.tif", "area_terbakar_FIXX.tif"],
    "jalan": ["jalan.shp"],
    "sungai": ["sungai dan kanal.shp"],
    "places": ["places.shp"],
    "kebun": ["SHP Peta Perkebunan Pohon Indonesia.zip", "SHP Peta Perkebunan Pohon Indonesia/"],
    "viirs": ["sv-c2_clip.shp"],
    "modis": ["m-c61_clip.shp"],
    "sipongi": ["sipongi_clip.shp"],
}

# ---------------------------------------------------------------------------
# Utilitas
# ---------------------------------------------------------------------------
WGS84 = osr.SpatialReference()
WGS84.ImportFromEPSG(4326)
WGS84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
NODATA = 255


def log(*a):
    print("[BARA]", *a)


def cari(kunci):
    """Cari berkas berdasarkan nama di semua subfolder DATA_DIRS.
    Nama berakhiran "/" berarti folder hasil ekstrak zip: dikembalikan .shp/.gpkg
    pertama di dalamnya."""
    for nama in BERKAS[kunci]:
        folder = nama.endswith("/")
        nama = nama.rstrip("/").lower()
        for d in DATA_DIRS:
            for root, dirs, files in os.walk(d):
                if folder:
                    for sub in dirs:
                        if sub.lower() == nama:
                            for r2, _, f2 in os.walk(os.path.join(root, sub)):
                                for f in sorted(f2):
                                    if f.lower().endswith((".shp", ".gpkg")):
                                        return os.path.join(r2, f)
                else:
                    for f in files:
                        if f.lower() == nama:
                            return os.path.join(root, f)
    return None


def cek_folder():
    ok = True
    for d in DATA_DIRS:
        ada = os.path.isdir(d)
        ok &= ada
        log(("ADA      " if ada else "TIDAK ADA"), d)
    log("Berkas yang ditemukan:")
    for k in BERKAS:
        p = cari(k)
        log("  %-12s %s" % (k, p if p else "-- tidak ditemukan --"))
    return ok


def buka_vektor(path):
    if path.lower().endswith(".zip"):
        vz = "/vsizip/" + path.replace("\\", "/")
        isi = gdal.ReadDirRecursive(vz) or []
        shp = [p for p in isi if p.lower().endswith(".shp")]
        if not shp:
            raise RuntimeError("Tidak ada .shp di dalam " + path)
        log("  isi zip:", shp)
        return ogr.Open(vz + "/" + shp[0])
    return ogr.Open(path)


def nama_field(lyr):
    d = lyr.GetLayerDefn()
    return [d.GetFieldDefn(i).GetName() for i in range(d.GetFieldCount())]


def pilih_field(fields, kandidat):
    low = {f.lower(): f for f in fields}
    for k in kandidat:
        if k.lower() in low:
            return low[k.lower()]
    return None


def transformasi(lyr):
    src = lyr.GetSpatialRef()
    if src is None:
        log("  PERINGATAN: layer tanpa CRS, dianggap EPSG:4326")
        return None
    src = src.Clone()
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    if src.IsSame(WGS84):
        return None
    return osr.CoordinateTransformation(src, WGS84)


def geom_4326(feat, ct):
    g = feat.GetGeometryRef()
    if g is None:
        return None
    g = g.Clone()
    if ct is not None:
        g.Transform(ct)
    return g


def bulatkan(obj, n=5):
    if isinstance(obj, list):
        return [bulatkan(o, n) for o in obj]
    if isinstance(obj, float):
        return round(obj, n)
    return obj


def tulis_geojson(path, fitur):
    fc = {"type": "FeatureCollection", "features": fitur}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))
    log("  ditulis", os.path.basename(path), "%.1f MB" % (os.path.getsize(path) / 1e6))


def fitur_geojson(g, props, tol):
    if tol:
        g = g.SimplifyPreserveTopology(tol)
    if g is None or g.IsEmpty():
        return None
    gj = json.loads(g.ExportToJson())
    gj["coordinates"] = bulatkan(gj["coordinates"])
    return {"type": "Feature", "properties": props, "geometry": gj}


def nilai_prop(feat, fields):
    out = {}
    for f in fields:
        v = feat.GetField(f)
        if isinstance(v, float):
            v = round(v, 3)
        out[f] = v
    return out


def parse_tanggal(s):
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    s = s.split("T")[0].split(" ")[0]
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%Y%m%d"):
        try:
            return datetime.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def conf_kelas(v):
    """0 = rendah, 1 = nominal/sedang, 2 = tinggi, -1 = tidak ada.
    VIIRS memakai l/n/h (Schroeder et al., 2014); MODIS memakai 0-100 dengan
    batas <30 rendah, 30-79 nominal, >=80 tinggi (Giglio et al., 2016)."""
    if v is None:
        return -1
    s = str(v).strip().lower()
    if s in ("l", "low", "rendah"):
        return 0
    if s in ("n", "nominal", "sedang", "medium"):
        return 1
    if s in ("h", "high", "tinggi"):
        return 2
    try:
        x = float(s)
    except ValueError:
        return -1
    return 0 if x < 30 else (1 if x < 80 else 2)


# ---------------------------------------------------------------------------
# 2. Batas kabupaten -> grid
# ---------------------------------------------------------------------------
def baca_kabupaten():
    path = cari("adm")
    if not path:
        raise RuntimeError("Berkas batas administrasi tidak ditemukan. Cek DATA_DIRS dan daftar 'Berkas yang ditemukan' di atas.")
    log("Batas administrasi:", path)
    ds = buka_vektor(path)
    lyr = ds.GetLayer(0)
    fields = nama_field(lyr)
    log("  field:", fields)
    kf = pilih_field(fields, ["WADMKK", "KABKOT", "KAB_KOTA", "KABKOTA", "NAMA_KAB", "NAMKAB",
                              "KABUPATEN", "Kabupaten/Kota", "NAME_2", "KAB", "NAMOBJ", "NAMA", "nama"])
    log("  field nama kabupaten:", kf)
    ct = transformasi(lyr)
    grup = {}
    for feat in lyr:
        g = geom_4326(feat, ct)
        if g is None:
            continue
        nama = (feat.GetField(kf) if kf else None) or "Kalimantan Tengah"
        grup.setdefault(str(nama).strip(), []).append(g)
    kab = []
    for i, (nama, gs) in enumerate(sorted(grup.items()), start=1):
        mg = ogr.Geometry(ogr.wkbMultiPolygon)
        for g in gs:
            t = ogr.GT_Flatten(g.GetGeometryType())
            if t == ogr.wkbPolygon:
                mg.AddGeometry(g)
            elif t == ogr.wkbMultiPolygon:
                for j in range(g.GetGeometryCount()):
                    mg.AddGeometry(g.GetGeometryRef(j))
        try:
            u = mg.UnionCascaded()
        except Exception:
            u = mg.Buffer(0)
        kab.append({"id": i, "nama": nama, "geom": u})
    if len(kab) > 60:
        log("  PERINGATAN: %d unit, kemungkinan bukan level kabupaten. Cek field." % len(kab))
    log("  jumlah kabupaten/kota:", len(kab))
    return kab


class Grid:
    def __init__(self, bbox, res):
        minx, maxx, miny, maxy = bbox
        self.res = res
        self.west = math.floor(minx / res) * res
        self.north = math.ceil(maxy / res) * res
        self.east = math.ceil(maxx / res) * res
        self.south = math.floor(miny / res) * res
        self.w = int(round((self.east - self.west) / res))
        self.h = int(round((self.north - self.south) / res))
        self.gt = (self.west, res, 0, self.north, 0, -res)

    def mem(self, dtype=gdal.GDT_Float32, fill=0, bands=1):
        ds = gdal.GetDriverByName("MEM").Create("", self.w, self.h, bands, dtype)
        ds.SetGeoTransform(self.gt)
        ds.SetProjection(WGS84.ExportToWkt())
        for b in range(1, bands + 1):
            ds.GetRasterBand(b).Fill(fill)
        return ds

    def bounds(self):
        return [[round(self.south, 6), round(self.west, 6)], [round(self.north, 6), round(self.east, 6)]]


def layer_memori(geoms, attr=None):
    drv = ogr.GetDriverByName("Memory")
    ds = drv.CreateDataSource("mem")
    lyr = ds.CreateLayer("l", WGS84, ogr.wkbUnknown)
    lyr.CreateField(ogr.FieldDefn("v", ogr.OFTInteger))
    for i, g in enumerate(geoms):
        f = ogr.Feature(lyr.GetLayerDefn())
        f.SetField("v", int(attr[i]) if attr is not None else 1)
        f.SetGeometry(g)
        lyr.CreateFeature(f)
    return ds, lyr


def rasterisasi(grid, geoms, attr=None, all_touched=False, tambah=False):
    ds = grid.mem(gdal.GDT_Float32, 0)
    vds, lyr = layer_memori(geoms, attr)
    opt = ["ATTRIBUTE=v"]
    if all_touched:
        opt.append("ALL_TOUCHED=TRUE")
    if tambah:
        opt.append("MERGE_ALG=ADD")
    gdal.RasterizeLayer(ds, [1], lyr, options=opt)
    return ds.GetRasterBand(1).ReadAsArray(), ds


def baca_geom_vektor(kunci, bbox, where_fn=None):
    path = cari(kunci)
    if not path:
        log("  LEWATI: berkas", BERKAS[kunci], "tidak ditemukan")
        return None, None, None
    log("Vektor", kunci, ":", path)
    ds = buka_vektor(path)
    lyr = ds.GetLayer(0)
    fields = nama_field(lyr)
    log("  field:", fields)
    ct = transformasi(lyr)
    minx, maxx, miny, maxy = bbox
    if ct is None:
        lyr.SetSpatialFilterRect(minx, miny, maxx, maxy)
    hasil = []
    for feat in lyr:
        if where_fn and not where_fn(feat, fields):
            continue
        g = geom_4326(feat, ct)
        if g is None:
            continue
        e = g.GetEnvelope()
        if e[1] < minx or e[0] > maxx or e[3] < miny or e[2] > maxy:
            continue
        hasil.append((g, feat))
    log("  fitur di area:", len(hasil))
    return hasil, fields, ds


# ---------------------------------------------------------------------------
# 3. Raster ke grid
# ---------------------------------------------------------------------------
def warp(path, grid, resample):
    ds = gdal.Warp("", path, format="MEM", dstSRS="EPSG:4326",
                   outputBounds=(grid.west, grid.south, grid.east, grid.north),
                   width=grid.w, height=grid.h, resampleAlg=resample,
                   outputType=gdal.GDT_Float32, dstNodata=-9999.0, multithread=True)
    arr = ds.ReadAsArray().astype("float32")
    if arr.ndim == 2:
        arr = arr[None, :, :]
    arr[arr == -9999.0] = np.nan
    return arr


def baca_raster(kunci, grid, resample="average", agregasi="mean"):
    path = cari(kunci)
    if not path:
        log("  LEWATI: berkas", BERKAS[kunci], "tidak ditemukan")
        return None
    info = gdal.Open(path)
    log("Raster", kunci, ":", os.path.basename(path), "| band:", info.RasterCount,
        "| ukuran:", info.RasterXSize, "x", info.RasterYSize)
    info = None
    arr = warp(path, grid, resample)
    if arr.shape[0] == 1:
        return arr[0]
    with np.errstate(all="ignore"):
        if agregasi == "sum":
            log("  %d band dijumlahkan (akumulasi)" % arr.shape[0])
            return np.nansum(arr, axis=0) * np.where(np.all(np.isnan(arr), axis=0), np.nan, 1)
        if agregasi == "max":
            return np.nanmax(arr, axis=0)
        log("  %d band dirata-ratakan" % arr.shape[0])
        return np.nanmean(arr, axis=0)


def satuan_lst(a):
    v = a[np.isfinite(a)]
    if v.size == 0:
        return a, "°C"
    med = float(np.median(v))
    if med > 7000:  # nilai mentah MOD11 (skala 0,02 K)
        return a * 0.02 - 273.15, "°C"
    if 200 < med < 400:  # Kelvin
        return a - 273.15, "°C"
    return a, "°C"


def normalisasi(a, mask, arah):
    """Skala linear 0-1 (Malczewski, 1999) setelah dipotong persentil 2-98
    (Richards, 2013). arah=+1: makin besar makin rawan; -1: sebaliknya."""
    v = a[mask & np.isfinite(a)]
    if v.size == 0:
        return None, None
    lo, hi = np.percentile(v, [2, 98])
    if hi <= lo:
        hi = lo + 1e-6
    n = np.clip((a - lo) / (hi - lo), 0, 1)
    if arah < 0:
        n = 1 - n
    return n, [float(lo), float(hi)]


def jarak_km(grid, geoms):
    """Jarak euclidean (km) dari setiap sel ke garis/titik terdekat."""
    src = grid.mem(gdal.GDT_Byte, 0)
    vds, lyr = layer_memori(geoms)
    gdal.RasterizeLayer(src, [1], lyr, burn_values=[1], options=["ALL_TOUCHED=TRUE"])
    dst = grid.mem(gdal.GDT_Float32, 0)
    gdal.ComputeProximity(src.GetRasterBand(1), dst.GetRasterBand(1),
                          ["VALUES=1", "DISTUNITS=GEO"])
    return dst.GetRasterBand(1).ReadAsArray() * 111.32


# Skor bahan bakar per kelas tutupan lahan (0 = tidak terbakar, 1 = paling
# mudah terbakar). Urutan mengikuti logika Chuvieco & Congalton (1989):
# semak/rumput/lahan terbuka bervegetasi > lahan pertanian > hutan > terbangun/air.
SKOR_DYNAMIC_WORLD = {0: 0.0, 1: 0.4, 2: 0.9, 3: 0.7, 4: 0.6, 5: 1.0, 6: 0.1, 7: 0.3, 8: 0.0}
NAMA_DYNAMIC_WORLD = {0: "Air", 1: "Pohon", 2: "Rumput", 3: "Vegetasi tergenang", 4: "Pertanian",
                      5: "Semak", 6: "Terbangun", 7: "Lahan terbuka", 8: "Salju/es"}
SKOR_WORLDCOVER = {10: 0.4, 20: 1.0, 30: 0.9, 40: 0.6, 50: 0.1, 60: 0.3, 70: 0.0, 80: 0.0,
                   90: 0.7, 95: 0.3, 100: 0.5}
NAMA_WORLDCOVER = {10: "Pohon", 20: "Semak", 30: "Rumput", 40: "Pertanian", 50: "Terbangun",
                   60: "Lahan terbuka", 70: "Salju/es", 80: "Air", 90: "Lahan basah",
                   95: "Mangrove", 100: "Lumut"}
WARNA_TUTUPAN = ["#2F4A1F", "#C9A227", "#E3D26F", "#7FB3A6", "#B97A57", "#E07B39",
                 "#222222", "#BDB6A6", "#FFFFFF", "#4A90C2", "#8AA05B", "#6B8E8E"]


def skor_tutupan(a):
    kode = sorted(set(int(x) for x in np.unique(a[np.isfinite(a)])))
    log("  kode tutupan lahan:", kode)
    if kode and max(kode) <= 8:
        skor, nama, skema = SKOR_DYNAMIC_WORLD, NAMA_DYNAMIC_WORLD, "Dynamic World"
    else:
        skor, nama, skema = SKOR_WORLDCOVER, NAMA_WORLDCOVER, "ESA WorldCover"
    log("  skema kelas dianggap:", skema)
    out = np.full(a.shape, np.nan, dtype="float32")
    for k in kode:
        s = skor.get(k)
        if s is None:
            log("  PERINGATAN: kode %d tidak dikenal, skor 0,5" % k)
            s = 0.5
        out[a == k] = s
    legenda = [{"kode": k, "nama": nama.get(k, "Kelas %d" % k),
                "warna": WARNA_TUTUPAN[i % len(WARNA_TUTUPAN)]} for i, k in enumerate(kode)]
    return out, legenda, skema


# ---------------------------------------------------------------------------
# 4. Gambar tampilan (PNG)
# ---------------------------------------------------------------------------
def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def ramp(n, warna):
    """n: array 0-1 -> RGB dengan interpolasi linear antar warna."""
    cs = np.array([hex_rgb(c) for c in warna], dtype="float32")
    x = np.clip(n, 0, 1) * (len(cs) - 1)
    i = np.clip(np.floor(x).astype(int), 0, len(cs) - 2)
    t = (x - i)[..., None]
    return (cs[i] * (1 - t) + cs[i + 1] * t).astype("uint8")


def tulis_png(path, rgb, alpha):
    h, w = alpha.shape
    ds = gdal.GetDriverByName("MEM").Create("", w, h, 4, gdal.GDT_Byte)
    for b in range(3):
        ds.GetRasterBand(b + 1).WriteArray(rgb[..., b])
    ds.GetRasterBand(4).WriteArray(alpha)
    gdal.Translate(path, ds, format="PNG")
    aux = path + ".aux.xml"
    if os.path.exists(aux):
        os.remove(aux)
    log("  ditulis", os.path.basename(path), "%.1f MB" % (os.path.getsize(path) / 1e6))


def overlay_kontinu(kunci, label, gridd, maskd, warna, satuan, olah=None, resample="average", agregasi="mean"):
    a = baca_raster(kunci, gridd, resample, agregasi)
    if a is None:
        return None
    if olah:
        a, satuan = olah(a)
    v = a[maskd & np.isfinite(a)]
    if v.size == 0:
        log("  LEWATI: tidak ada nilai di dalam Kalteng")
        return None
    lo, hi = np.percentile(v, [2, 98])
    n = (a - lo) / (hi - lo if hi > lo else 1)
    rgb = ramp(np.nan_to_num(n), warna)
    alpha = np.where(maskd & np.isfinite(a), 235, 0).astype("uint8")
    tulis_png(os.path.join(OUT_DIR, kunci + ".png"), rgb, alpha)
    return {"key": kunci, "label": label, "file": kunci + ".png", "bounds": gridd.bounds(),
            "legend": {"type": "ramp", "min": round(float(lo), 2), "max": round(float(hi), 2),
                       "unit": satuan, "colors": warna}}


# ---------------------------------------------------------------------------
# 5. Titik api
# ---------------------------------------------------------------------------
def baca_titik(kunci, idx_sumber, bbox):
    path = cari(kunci)
    if not path:
        log("  LEWATI: berkas", BERKAS[kunci], "tidak ditemukan")
        return []
    log("Titik api", kunci, ":", path)
    ds = buka_vektor(path)
    lyr = ds.GetLayer(0)
    fields = nama_field(lyr)
    log("  field:", fields)
    df = pilih_field(fields, ["acq_date", "tanggal", "date", "tgl", "waktu", "datetime",
                              "tanggal_hotspot", "hs_date"])
    tf = pilih_field(fields, ["acq_time", "jam", "time"])
    cf = pilih_field(fields, ["confidence", "conf", "kepercayaan", "confidence_level", "tingkat"])
    ff = pilih_field(fields, ["frp"])
    log("  field tanggal/jam/conf/frp:", df, tf, cf, ff)
    if df is None:
        log("  LEWATI: field tanggal tidak ditemukan. Tambahkan namanya ke daftar kandidat.")
        return []
    ct = transformasi(lyr)
    minx, maxx, miny, maxy = bbox
    t0 = PERIODE_MULAI
    out, gagal = [], 0
    for feat in lyr:
        d = parse_tanggal(feat.GetFieldAsString(df))
        if d is None:
            gagal += 1
            continue
        if d < PERIODE_MULAI or d > PERIODE_SELESAI:
            continue
        g = geom_4326(feat, ct)
        if g is None:
            continue
        x, y = g.GetX(), g.GetY()
        if not (minx <= x <= maxx and miny <= y <= maxy):
            continue
        jam = -1
        if tf:
            try:
                jam = int(str(feat.GetField(tf)).replace(":", "")[:4])
            except (TypeError, ValueError):
                jam = -1
        frp = -1
        if ff:
            try:
                frp = round(float(feat.GetField(ff)), 1)
            except (TypeError, ValueError):
                frp = -1
        conf = conf_kelas(feat.GetField(cf)) if cf else -1
        out.append([round(x, 4), round(y, 4), (d - t0).days, idx_sumber, conf, frp, jam])
    if gagal:
        log("  PERINGATAN: %d fitur tanggalnya tidak terbaca" % gagal)
    log("  titik dalam periode:", len(out))
    return out


# ---------------------------------------------------------------------------
# 6. Model kelompok dari QGIS
# ---------------------------------------------------------------------------
KRITERIA = [
    ("iklim", "skor_iklim", "Iklim & temperatur", "Skor_IklimTemperatur (QGIS kelompok)",
     "Hujan rendah dan suhu tinggi mengeringkan bahan bakar (Chuvieco et al., 2004)"),
    ("akses", "skor_akses", "Aksesibilitas", "DNTY_SKOR_AKSESIBILITAS (QGIS kelompok)",
     "Akses jalan, sungai, dan permukiman sebagai sumber api manusia (Chuvieco & Congalton, 1989)"),
    ("lahan", "skor_lahan", "Kondisi lahan", "Skor_KondisiLahan (QGIS kelompok)",
     "Bahan bakar: tutupan lahan, gambut, vegetasi (Page et al., 2002; Chuvieco & Congalton, 1989)"),
]


def model_qgis(grid, mask):
    """Membaca indeks kerawanan dan tiga skor kriteria hasil AHP kelompok.

    Bobot AHP direkonstruksi dengan regresi linear kuadrat terkecil
    indeks = c0 + w1*iklim + w2*akses + w3*lahan. Karena indeks dibuat dengan
    kombinasi linear berbobot (WLC; Malczewski, 1999), regresi ini memulihkan
    bobot yang dipakai di QGIS (R^2 mendekati 1 bila tidak ada faktor lain).
    Rata-rata spasial (resampling 'average') mempertahankan hubungan linear,
    sehingga bobot tetap berlaku di grid 0,01 derajat.

    Ambang kelas K1-K5 diestimasi dari final_index_reclass: untuk tiap pasangan
    kelas bersebelahan dipilih nilai indeks yang meminimalkan salah kelas.
    """
    kunci = [k[1] for k in KRITERIA]
    if not cari("indeks") or not all(cari(k) for k in kunci):
        log("Hasil model QGIS tidak lengkap -> memakai parameter mentah")
        return None
    idx = baca_raster("indeks", grid, "average")
    sk = [baca_raster(k, grid, "average") for k in kunci]
    kl = baca_raster("kelas", grid, "mode") if cari("kelas") else None
    valid = mask & np.isfinite(idx)
    for a in sk:
        valid &= np.isfinite(a)
    n = int(valid.sum())
    if n < 100:
        log("  LEWATI: sel valid terlalu sedikit")
        return None
    y = idx[valid].astype("float64")
    X = np.column_stack([a[valid].astype("float64") for a in sk] + [np.ones(n)])
    coef = np.linalg.lstsq(X, y, rcond=None)[0]
    pred = X @ coef
    r2 = float(1 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum())
    w, c0 = coef[:3], float(coef[3])
    log("  regresi indeks: w =", [round(float(x), 4) for x in w], "c0 =", round(c0, 4), "R2 =", round(r2, 4))
    if r2 < 0.98:
        log("  PERINGATAN: R2 < 0,98, indeks bukan kombinasi linear murni ketiga skor.")
    if np.any(w <= 0):
        log("  PERINGATAN: ada bobot <= 0, dipotong ke nilai kecil positif.")
        w = np.clip(w, 1e-6, None)
    W = float(w.sum())
    wn = w / W
    gmin = float(min(np.nanmin(a[mask]) for a in sk))
    gmax = float(max(np.nanmax(a[mask]) for a in sk))
    if gmax <= gmin:
        gmax = gmin + 1e-6
    q = {KRITERIA[i][0]: np.clip((sk[i] - gmin) / (gmax - gmin), 0, 1) for i in range(3)}

    ambang, kode = None, None
    if kl is not None:
        kode = sorted(int(k) for k in np.unique(kl[valid & np.isfinite(kl)]))
        log("  kode kelas final_index_reclass:", kode)
        if len(kode) == 5:
            ambang = []
            for k in range(4):
                a_ = idx[valid & (kl == kode[k])]
                b_ = idx[valid & (kl == kode[k + 1])]
                if a_.size == 0 or b_.size == 0:
                    ambang = None
                    break
                cand = np.linspace(float(np.median(a_)), float(np.median(b_)), 400)
                err = [int((a_ > t).sum() + (b_ <= t).sum()) for t in cand]
                t = float(cand[int(np.argmin(err))])
                ambang.append(((t - c0) / W - gmin) / (gmax - gmin))
            if ambang:
                log("  ambang kelas (ruang skor web 0-1):", [round(x, 4) for x in ambang])
        else:
            log("  PERINGATAN: jumlah kelas bukan 5, ambang QGIS tidak dipakai")
    return {"bands": q, "bobot": {KRITERIA[i][0]: round(float(wn[i]), 4) for i in range(3)},
            "r2": round(r2, 4), "ambang": ambang, "kelas": kl, "kode": kode}


# ---------------------------------------------------------------------------
# 7. Jalankan
# ---------------------------------------------------------------------------
WARNA_KELAS = ["#FFE9E1", "#FFBFA8", "#FF8A63", "#FF4B14", "#A82600"]
NAMA_KELAS = ["K1 Sangat rendah", "K2 Rendah", "K3 Sedang", "K4 Tinggi", "K5 Sangat tinggi"]


def main():
    cek_folder()
    os.makedirs(OUT_DIR, exist_ok=True)
    meta = {"dibuat": datetime.datetime.now().isoformat(timespec="minutes"),
            "periode": [PERIODE_MULAI.isoformat(), PERIODE_SELESAI.isoformat()],
            "nodata": NODATA, "params": [], "overlays": [], "vectors": {}}

    # --- Kabupaten
    kab = baca_kabupaten()
    prov = ogr.Geometry(ogr.wkbMultiPolygon)
    for k in kab:
        g = k["geom"]
        if ogr.GT_Flatten(g.GetGeometryType()) == ogr.wkbPolygon:
            prov.AddGeometry(g)
        else:
            for j in range(g.GetGeometryCount()):
                prov.AddGeometry(g.GetGeometryRef(j))
    minx, maxx, miny, maxy = prov.GetEnvelope()
    bbox = (minx - 0.02, maxx + 0.02, miny - 0.02, maxy + 0.02)
    grid = Grid(bbox, GRID_RES)
    gridd = Grid(bbox, DISPLAY_RES)
    log("Grid model: %d x %d sel (%.3f°)" % (grid.w, grid.h, GRID_RES))

    fitur = []
    for k in kab:
        ft = fitur_geojson(k["geom"], {"id": k["id"], "nama": k["nama"]}, SIMPLIFY_TOL)
        if ft:
            fitur.append(ft)
    tulis_geojson(os.path.join(OUT_DIR, "kabupaten.geojson"), fitur)
    meta["vectors"]["kabupaten"] = "kabupaten.geojson"
    meta["kab"] = [{"id": k["id"], "nama": k["nama"]} for k in kab]

    kab_id, _ = rasterisasi(grid, [k["geom"] for k in kab], [k["id"] for k in kab])
    mask = kab_id > 0
    kabd, _ = rasterisasi(gridd, [k["geom"] for k in kab], [k["id"] for k in kab])
    maskd = kabd > 0

    bands = {"kab": kab_id.astype("float32")}
    params = []

    def tambah_param(key, arr, label, arah, sumber, alasan, rentang=None, satuan=""):
        if arr is None:
            return
        bands[key] = arr
        params.append({"key": key, "label": label, "arah": arah, "sumber": sumber,
                       "alasan": alasan, "rentang": rentang, "satuan": satuan})

    # --- Model kelompok (prioritas utama)
    model = None
    try:
        model = model_qgis(grid, mask)
    except Exception as e:
        log("  GAGAL membaca model QGIS:", e)
    if model:
        for key, _, label, sumber, alasan in KRITERIA:
            tambah_param(key, np.where(mask, model["bands"][key], np.nan), label, "+", sumber, alasan)
        meta["model"] = {"mode": "qgis", "bobot": model["bobot"], "r2": model["r2"],
                         "ambang": model["ambang"], "nama_kelas": NAMA_KELAS}
        if model["kelas"] is not None and model["kode"] and len(model["kode"]) == 5:
            kl = model["kelas"]
            arr = np.full(kl.shape, np.nan, dtype="float32")
            for i, k in enumerate(model["kode"]):
                arr[kl == k] = i
            bands["kelas_qgis"] = np.where(mask, arr, np.nan)
            # gambar resmi resolusi tampilan
            kd = baca_raster("kelas", gridd, "mode")
            rgb = np.zeros(kd.shape + (3,), dtype="uint8")
            on = np.zeros(kd.shape, dtype=bool)
            for i, k in enumerate(model["kode"]):
                sel = maskd & (kd == k)
                rgb[sel] = hex_rgb(WARNA_KELAS[i])
                on |= sel
            tulis_png(os.path.join(OUT_DIR, "kelas_qgis.png"), rgb, np.where(on, 255, 0).astype("uint8"))
            meta["overlays"].append({"key": "kelas_qgis", "label": "Peta bahaya (hasil QGIS)", "file": "kelas_qgis.png",
                                     "bounds": gridd.bounds(),
                                     "legend": {"type": "kategori", "items": [
                                         {"kode": i + 1, "nama": NAMA_KELAS[i], "warna": WARNA_KELAS[i]} for i in range(5)]}})
        for key, kunci, label, _, _ in KRITERIA:
            try:
                o = overlay_kontinu(kunci, "Skor " + label.lower(), gridd, maskd,
                                    ["#F2F2F0", "#BDBDBA", "#6E6E6A", "#161612"], "skor")
                if o:
                    meta["overlays"].append(o)
            except Exception as e:
                log("  GAGAL overlay", kunci, e)

    # --- Gambut (vektor tampilan; jadi parameter hanya bila model QGIS tidak ada)
    hasil, fields, _ = baca_geom_vektor("gambut", bbox)
    if hasil:
        arr, _ = rasterisasi(grid, [g for g, _ in hasil])
        bands["gambut_ada"] = np.where(mask, (arr > 0).astype("float32"), np.nan)
        if not model:
            tambah_param("gambut", bands["gambut_ada"], "Lahan gambut", "+", "Peta gambut",
                         "Gambut kering mudah terbakar dan membara lama (Page et al., 2002)")
        ft = []
        for g, feat in hasil:
            f2 = fitur_geojson(g, nilai_prop(feat, fields[:6]), SIMPLIFY_TOL * 2)
            if f2:
                ft.append(f2)
        tulis_geojson(os.path.join(OUT_DIR, "gambut.geojson"), ft)
        meta["vectors"]["gambut"] = "gambut.geojson"

    # --- Tutupan lahan (gambar selalu; parameter hanya cadangan)
    if cari("tutupan"):
        ad = baca_raster("tutupan", gridd, "mode")
        _, legenda, skema = skor_tutupan(ad)
        rgb = np.zeros(ad.shape + (3,), dtype="uint8")
        for item in legenda:
            rgb[ad == item["kode"]] = hex_rgb(item["warna"])
        tulis_png(os.path.join(OUT_DIR, "tutupan.png"), rgb,
                  np.where(maskd & np.isfinite(ad), 235, 0).astype("uint8"))
        meta["overlays"].append({"key": "tutupan", "label": "Tutupan lahan 2026", "file": "tutupan.png",
                                 "bounds": gridd.bounds(), "legend": {"type": "kategori", "items": legenda}})
        if not model:
            a = baca_raster("tutupan", grid, "mode")
            skor, _, skema = skor_tutupan(a)
            tambah_param("tutupan", np.where(mask, skor, np.nan), "Tutupan lahan (bahan bakar)", "+",
                         "Tutupan lahan 2026 (" + skema + ")",
                         "Semak dan rumput paling mudah terbakar (Chuvieco & Congalton, 1989)")

    # --- Parameter mentah sebagai cadangan bila model QGIS tidak ada
    if not model:
        a = baca_raster("ndvi", grid, "average")
        if a is not None:
            if np.nanmax(a) > 1.5:
                a = a / 10000.0
            n, r = normalisasi(a, mask, -1)
            tambah_param("ndvi", n, "NDVI rendah", "-", "NDVI 2026",
                         "Vegetasi kering/jarang lebih mudah terbakar (Chuvieco et al., 2004)", r)
        a = baca_raster("hujan", grid, "average", "sum")
        if a is not None:
            n, r = normalisasi(a, mask, -1)
            tambah_param("hujan", n, "Curah hujan rendah", "-", "CHIRPS 2026 (Funk et al., 2015)",
                         "Musim kering menurunkan kelembapan bahan bakar", r, "mm")
        a = baca_raster("lst", grid, "average")
        if a is not None:
            a, sat = satuan_lst(a)
            n, r = normalisasi(a, mask, +1)
            tambah_param("lst", n, "Suhu permukaan tinggi", "+", "MODIS LST (Wan, 2014)",
                         "Suhu tinggi mengeringkan bahan bakar (Chuvieco et al., 2004)", r, sat)
        a = baca_raster("jarak_mukim", grid, "average")
        if a is not None:
            n, r = normalisasi(a, mask, -1)
            tambah_param("mukim", n, "Dekat permukiman", "-", "Jarak permukiman 2026",
                         "Aktivitas manusia sebagai sumber api (Chuvieco & Congalton, 1989)", r)

    # --- Jalan dan sungai (vektor tampilan; jarak hanya untuk model cadangan)
    def filter_jalan(feat, fields):
        fc = pilih_field(fields, ["fclass"])
        return True if not fc else str(feat.GetField(fc)) in KELAS_JALAN

    for kunci, label_param, alasan, filt in [
        ("jalan", "Dekat jalan", "Akses manusia ke lahan (Chuvieco & Congalton, 1989)", filter_jalan),
        ("sungai", "Dekat sungai/kanal", "Kanal mengeringkan gambut dan membuka akses (Hooijer et al., 2010)", None),
    ]:
        hasil, fields, _ = baca_geom_vektor(kunci, bbox)
        if not hasil:
            continue
        if not model:
            d = jarak_km(grid, [g for g, _ in hasil])
            n, r = normalisasi(np.where(mask, d, np.nan), mask, -1)
            tambah_param(kunci, n, label_param, "-", kunci.capitalize(), alasan, r, "km")
        fc = pilih_field(fields, ["fclass"])
        nm = pilih_field(fields, ["name", "nama", "namobj"])
        ft = []
        for g, feat in hasil:
            if filt and not filt(feat, fields):
                continue
            props = {}
            if fc:
                props["kelas"] = feat.GetField(fc)
            if nm:
                props["nama"] = feat.GetField(nm)
            f2 = fitur_geojson(g, props, SIMPLIFY_TOL)
            if f2:
                ft.append(f2)
        tulis_geojson(os.path.join(OUT_DIR, kunci + ".geojson"), ft)
        meta["vectors"][kunci] = kunci + ".geojson"

    # --- Band pendukung dampak dan validasi
    hasil, fields, _ = baca_geom_vektor("places", bbox)
    if hasil:
        arr, _ = rasterisasi(grid, [g for g, _ in hasil], tambah=True)
        bands["places"] = np.where(mask, np.minimum(arr, 250), np.nan)
        fc = pilih_field(fields, ["fclass", "type", "jenis"])
        nm = pilih_field(fields, ["name", "nama", "namobj"])
        ft = []
        for g, feat in hasil:
            f2 = fitur_geojson(g, {"nama": feat.GetField(nm) if nm else None,
                                   "kelas": feat.GetField(fc) if fc else None}, 0)
            if f2:
                ft.append(f2)
        tulis_geojson(os.path.join(OUT_DIR, "permukiman.geojson"), ft)
        meta["vectors"]["permukiman"] = "permukiman.geojson"

    hasil, fields, _ = baca_geom_vektor("kebun", bbox)
    if hasil:
        arr, _ = rasterisasi(grid, [g for g, _ in hasil])
        bands["kebun"] = np.where(mask, (arr > 0).astype("float32"), np.nan)

    if cari("bakar"):
        a = baca_raster("bakar", grid, "max", "max")
        bands["bakar"] = np.where(mask, (np.nan_to_num(a) > 0).astype("float32"), np.nan)
        ad = baca_raster("bakar", gridd, "max", "max")
        on = maskd & (np.nan_to_num(ad) > 0)
        rgb = np.zeros(ad.shape + (3,), dtype="uint8")
        tulis_png(os.path.join(OUT_DIR, "bakar.png"), rgb, np.where(on, 255, 0).astype("uint8"))
        meta["overlays"].append({"key": "bakar", "label": "Area terbakar historis", "file": "bakar.png",
                                 "bounds": gridd.bounds(),
                                 "legend": {"type": "kategori",
                                            "items": [{"kode": 1, "nama": "Pernah terbakar", "warna": "#0A0A0A"}]}})

    # --- Gambar parameter mentah
    for kunci, label, warna, sat, olah, agg in [
        ("ndvi", "NDVI 2026", ["#F4F1E8", "#C8D5A8", "#7FA25A", "#2F4A1F"], "",
         lambda a: (a / 10000.0 if np.nanmax(a) > 1.5 else a, ""), "mean"),
        ("hujan", "Curah hujan 2026", ["#F4F6F8", "#B9CCE0", "#5B86B5", "#1E3F66"], "mm", None, "sum"),
        ("lst", "Suhu permukaan (LST)", ["#F2F2F0", "#BDBDBA", "#6E6E6A", "#161612"], "°C", satuan_lst, "mean"),
        ("jarak_mukim", "Jarak ke permukiman", ["#161612", "#6E6E6A", "#BDBDBA", "#F2F2F0"], "", None, "mean"),
    ]:
        try:
            o = overlay_kontinu(kunci, label, gridd, maskd, warna, sat, olah, "average", agg)
            if o:
                meta["overlays"].append(o)
        except Exception as e:
            log("  GAGAL overlay", kunci, e)

    # --- Topografi: hillshade (Horn, 1981)
    path = cari("dem")
    if path:
        try:
            log("Topografi:", os.path.basename(path))
            dem = gdal.Warp("", path, format="MEM", dstSRS="EPSG:4326",
                            outputBounds=(gridd.west, gridd.south, gridd.east, gridd.north),
                            width=gridd.w, height=gridd.h, resampleAlg="average",
                            outputType=gdal.GDT_Float32, dstNodata=-9999.0, multithread=True)
            hs = gdal.DEMProcessing("", dem, "hillshade", format="MEM", scale=111120, zFactor=2,
                                    computeEdges=True)
            h = hs.GetRasterBand(1).ReadAsArray().astype("float32")
            rgb = np.repeat(h[..., None], 3, axis=2).astype("uint8")
            tulis_png(os.path.join(OUT_DIR, "topografi.png"), rgb, np.where(maskd, 200, 0).astype("uint8"))
            meta["overlays"].append({"key": "topografi", "label": "Topografi (hillshade SRTM)",
                                     "file": "topografi.png", "bounds": gridd.bounds(),
                                     "legend": {"type": "ramp", "min": 0, "max": 255, "unit": "relief",
                                                "colors": ["#161612", "#F2F2F0"]}})
        except Exception as e:
            log("  GAGAL hillshade:", e)

    # --- Titik api
    sumber = ["VIIRS", "MODIS", "SiPongi+"]
    pts = []
    for i, kunci in enumerate(["viirs", "modis", "sipongi"]):
        try:
            pts += baca_titik(kunci, i, bbox)
        except Exception as e:
            log("  GAGAL titik api", kunci, e)
    with open(os.path.join(OUT_DIR, "titik_api.json"), "w", encoding="utf-8") as f:
        json.dump({"t0": PERIODE_MULAI.isoformat(),
                   "hari": (PERIODE_SELESAI - PERIODE_MULAI).days + 1,
                   "sumber": sumber,
                   "kolom": ["lon", "lat", "hari_ke", "sumber", "conf", "frp", "jam"],
                   "pts": pts}, f, separators=(",", ":"))
    log("Titik api total:", len(pts))
    meta["titik_api"] = "titik_api.json"

    # --- Tumpukan band -> stack.bin (uint8; parameter 0-250, 255 = nodata)
    kunci_param = [p["key"] for p in params]
    urutan = kunci_param + [k for k in ["kab", "kelas_qgis", "gambut_ada", "bakar", "kebun", "places"] if k in bands]
    buf = []
    for key in urutan:
        a = bands[key]
        if key in kunci_param:
            q = np.where(np.isfinite(a) & mask, np.round(a * 250), NODATA)
        elif key == "kab":
            q = np.where(mask, a, 0)
        else:
            q = np.where(np.isfinite(a), np.clip(np.round(a), 0, 250), NODATA)
        buf.append(q.astype("uint8"))
    stack = np.stack(buf)
    stack.tofile(os.path.join(OUT_DIR, "stack.bin"))
    log("stack.bin: %d band, %.1f MB" % (stack.shape[0], stack.nbytes / 1e6))

    meta["grid"] = {"w": grid.w, "h": grid.h, "west": grid.west, "north": grid.north,
                    "res": GRID_RES, "bounds": grid.bounds()}
    meta["bands"] = urutan
    meta["params"] = params
    if os.path.exists(os.path.join(OUT_DIR, "statistik_qgis.json")):
        meta["statistik_qgis"] = "statistik_qgis.json"
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log("SELESAI. Parameter model:", kunci_param)
    if model:
        log("Bobot rekonstruksi:", model["bobot"], "R2:", model["r2"])
    log("Berkas ada di:", OUT_DIR)


main()
