/* BARA/KALTENG — WebGIS bahaya karhutla Kalimantan Tengah
 * Leaflet 1.9.4, tanpa server. Data dibaca dari folder data/ hasil
 * tools/siapkan_data_webgis.py.
 *
 * Model: Weighted Linear Combination (Malczewski, 1999)
 *   S = Σ (w_i · x_i) / Σ w_i,  x_i = nilai parameter ternormalisasi 0–1
 * Bobot awal = AHP kelompok (Saaty, 1980), bisa diubah langsung (on-the-fly).
 */
(function () {
  'use strict';

  var C = window.BARA_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var NODATA = 255;

  var S = {
    meta: null, N: 0, W: 0, H: 0, bands: {}, params: [], weights: {},
    score: null, cls: null, thresholds: [], rowArea: null,
    hot: null, hotFiltered: [], hotIdx: [], srcOn: [],
    kabGeo: null, kabSel: 0, kabBounds: {}, statsKab: [], statsProv: null,
    map: null, layers: {}, aktif: {}, hazardCanvas: null, hazardOverlay: null,
    basemaps: {}, basemapAktif: null, timer: null
  };

  var SRC_OVERLAY = { tutupan: 'GEE', ndvi: 'GEE', hujan: 'CHIRPS', lst: 'MODIS', jarak_mukim: 'GEE', topografi: 'SRTM', bakar: 'Historis',
    kelas_qgis: 'AHP · QGIS', skor_iklim: 'QGIS', skor_akses: 'QGIS', skor_lahan: 'QGIS' };

  // ------------------------------------------------------------------ util
  function ambil(f, tipe) {
    return fetch(C.dataDir + f).then(function (r) {
      if (!r.ok) throw new Error(f + ' (' + r.status + ')');
      return tipe === 'bin' ? r.arrayBuffer() : r.json();
    });
  }
  function fmt(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return Number(n).toLocaleString('id-ID', { maximumFractionDigits: d === undefined ? 0 : d, minimumFractionDigits: d || 0 });
  }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hexRgb(h) { h = h.replace('#', ''); return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
  // Tanggal dihitung dalam UTC supaya tidak bergeser oleh zona waktu browser
  function tglUTC(hariKe) {
    var p = S.hot.t0.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + hariKe));
  }
  function tanggal(hariKe) { return tglUTC(hariKe).toISOString().slice(0, 10); }
  function tglPendek(hariKe) {
    var d = tglUTC(hariKe);
    return ('0' + d.getUTCDate()).slice(-2) + ' ' + ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGU', 'SEP', 'OKT', 'NOV', 'DES'][d.getUTCMonth()];
  }
  function unduh(nama, isi, tipe) {
    var a = el('a', { href: URL.createObjectURL(new Blob([isi], { type: tipe })), download: nama });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function idxDariLatLng(lat, lng) {
    var g = S.meta.grid;
    var c = Math.floor((lng - g.west) / g.res), r = Math.floor((g.north - lat) / g.res);
    if (c < 0 || r < 0 || c >= S.W || r >= S.H) return -1;
    return r * S.W + c;
  }
  var jadwal = {};
  function nanti(nama, fn) {
    if (jadwal[nama]) return;
    jadwal[nama] = requestAnimationFrame(function () { jadwal[nama] = 0; fn(); });
  }

  // ------------------------------------------------------------------ mulai
  function mulai() {
    $('judul').textContent = C.judul;
    $('subjudul').textContent = C.subjudul;
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { gantiView(b.getAttribute('data-view')); });
    });

    Promise.all([ambil('meta.json'), ambil('stack.bin', 'bin')]).then(function (r) {
      S.meta = r[0];
      siapkanBand(new Uint8Array(r[1]));
      return Promise.all([
        ambil(S.meta.vectors.kabupaten),
        S.meta.titik_api ? ambil(S.meta.titik_api) : Promise.resolve({ t0: S.meta.periode[0], hari: 92, sumber: [], pts: [] }),
        ambil(S.meta.statistik_qgis || 'statistik_qgis.json').catch(function () { return null; })
      ]);
    }).then(function (r) {
      S.kabGeo = r[0];
      S.hot = r[1];
      S.resmi = r[2];
      siapkanPeta();
      siapkanLayer();
      siapkanModel();
      siapkanWaktu();
      siapkanCari();
      siapkanUnduh();
      isiHalaman();
      hitungModel();
      filterTitik();
      $('muat').hidden = true;
    }).catch(function (e) {
      console.error(e);
      var file = location.protocol === 'file:';
      $('muat').querySelector('.muat-isi').innerHTML =
        '<b>Data belum bisa dimuat</b>' +
        (file ? 'Halaman dibuka langsung dari berkas (file://), jadi browser memblokir pembacaan data. Buka lewat server lokal: di folder ini jalankan <code>python -m http.server</code> lalu buka <code>http://localhost:8000</code>.<br><br>'
              : 'Pastikan folder <code>data/</code> berisi hasil skrip <code>tools/siapkan_data_webgis.py</code> (meta.json, stack.bin, kabupaten.geojson, titik_api.json).<br><br>') +
        'Detail: ' + esc(e.message);
    });
  }

  function siapkanBand(stack) {
    var g = S.meta.grid;
    S.W = g.w; S.H = g.h; S.N = g.w * g.h;
    if (stack.length !== S.N * S.meta.bands.length) throw new Error('Ukuran stack.bin tidak cocok dengan meta.json');
    S.meta.bands.forEach(function (k, i) { S.bands[k] = stack.subarray(i * S.N, (i + 1) * S.N); });
    S.params = S.meta.params.slice();
    S.model = S.meta.model || null;
    S.bobotAwal = (S.model && S.model.bobot) ? S.model.bobot : C.bobotAHP;
    if (S.model && S.model.nama_kelas) C.namaKelas = S.model.nama_kelas;
    S.params.forEach(function (p) {
      var w = S.bobotAwal[p.key];
      S.weights[p.key] = (w === undefined || w === null) ? 1 : w;
    });
    // Luas sel (km²) per baris: (res·111,32)² · cos(lintang)
    S.rowArea = new Float32Array(S.H);
    var km = g.res * 111.32;
    for (var r = 0; r < S.H; r++) {
      var lat = g.north - (r + 0.5) * g.res;
      S.rowArea[r] = km * km * Math.cos(lat * Math.PI / 180);
    }
    S.score = new Float32Array(S.N);
    S.cls = new Uint8Array(S.N);
    S.meta.kab.forEach(function (k) { S.kabNama = S.kabNama || {}; S.kabNama[k.id] = k.nama; });
  }

  // ------------------------------------------------------------------ peta
  function siapkanPeta() {
    var map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 5, maxZoom: 16, attributionControl: true });
    S.map = map;
    map.fitBounds(L.latLngBounds(S.meta.grid.bounds), { padding: [10, 10] });
    L.control.zoom({ position: 'topleft', zoomInTitle: 'Perbesar', zoomOutTitle: 'Perkecil' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 160 }).addTo(map);

    [['raster', 350], ['bahaya', 360], ['vektor', 420], ['kab', 430], ['titik', 450]].forEach(function (p) {
      map.createPane(p[0]).style.zIndex = p[1];
    });
    map.getPane('kab').style.pointerEvents = 'none';

    S.basemaps = {
      terang: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19 }),
      gelap: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19 }),
      citra: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Citra &copy; Esri', maxZoom: 19 })
    };
    var CtrlBase = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'ctrl-basemap');
        d.setAttribute('role', 'group'); d.setAttribute('aria-label', 'Basemap');
        ['terang', 'gelap', 'citra'].forEach(function (k) {
          var b = L.DomUtil.create('button', '', d);
          b.type = 'button'; b.textContent = k; b.setAttribute('data-k', k);
          L.DomEvent.on(b, 'click', function (e) { L.DomEvent.stop(e); gantiBasemap(k); });
        });
        L.DomEvent.disableClickPropagation(d);
        return d;
      }
    });
    map.addControl(new CtrlBase());
    gantiBasemap(C.basemap || 'terang');

    var CtrlKoord = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () { var d = L.DomUtil.create('div', 'koordinat'); d.id = 'koordinat'; d.textContent = 'LAT — · LON —'; return d; }
    });
    map.addControl(new CtrlKoord());
    map.on('mousemove', function (e) {
      $('koordinat').textContent = 'LAT ' + e.latlng.lat.toFixed(4) + ' · LON ' + e.latlng.lng.toFixed(4) + ' · Z ' + map.getZoom();
    });
    map.on('click', klikPeta);

    // Lapisan bahaya (kanvas sebesar grid model)
    S.hazardCanvas = document.createElement('canvas');
    S.hazardCanvas.width = S.W; S.hazardCanvas.height = S.H;
    S.hazardOverlay = L.imageOverlay(S.hazardCanvas.toDataURL(), S.meta.grid.bounds,
      { pane: 'bahaya', opacity: 0.8, className: 'piksel', interactive: false });
  }

  function gantiBasemap(k) {
    if (S.basemapAktif) S.map.removeLayer(S.basemapAktif);
    S.basemapAktif = S.basemaps[k].addTo(S.map);
    S.basemapAktif.bringToBack();
    document.querySelectorAll('.ctrl-basemap button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-k') === k ? 'true' : 'false');
    });
    S.basemapNama = k;
    if (S.layers.kab) S.layers.kab.setStyle(gayaKab);
    if (S.layers.titik) S.layers.titik.redraw();
  }

  // ------------------------------------------------------------------ layer titik api (kanvas)
  var LayerTitik = L.Layer.extend({
    onAdd: function (map) {
      this._map = map;
      this._c = L.DomUtil.create('canvas', 'kanvas-titik');
      map.getPane('titik').appendChild(this._c);
      map.on('moveend zoomend resize', this.redraw, this);
      map.on('zoomstart movestart', this._sembunyi, this);
      this.redraw();
    },
    onRemove: function (map) {
      map.off('moveend zoomend resize', this.redraw, this);
      map.off('zoomstart movestart', this._sembunyi, this);
      this._c.remove();
      S.hotLayar = [];
    },
    _sembunyi: function () { if (this._c) this._c.style.opacity = 0; },
    redraw: function () {
      if (!this._map || !this._c) return;
      var map = this._map, size = map.getSize(), dpr = window.devicePixelRatio || 1;
      var c = this._c, ctx = c.getContext('2d');
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      c.width = size.x * dpr; c.height = size.y * dpr;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      c.style.opacity = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var z = map.getZoom();
      var r = z <= 7 ? 2 : (z <= 9 ? 3 : 4.5);
      var gelap = S.basemapNama !== 'terang';
      ctx.fillStyle = gelap ? '#FFFFFF' : '#0A0A0A';
      ctx.strokeStyle = gelap ? '#0A0A0A' : '#FFFFFF';
      ctx.lineWidth = r > 2 ? 1.2 : 0.8;
      var pts = S.hotFiltered, lay = [];
      var b = map.getBounds().pad(0.02);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p[1] < b._southWest.lat || p[1] > b._northEast.lat || p[0] < b._southWest.lng || p[0] > b._northEast.lng) continue;
        var q = map.latLngToContainerPoint([p[1], p[0]]);
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 6.2832); ctx.fill(); ctx.stroke();
        lay.push([q.x, q.y, i]);
      }
      S.hotLayar = lay;
    }
  });

  // ------------------------------------------------------------------ daftar layer
  function siapkanLayer() {
    var m = S.meta, ov = {};
    (m.overlays || []).forEach(function (o) { ov[o.key] = o; });
    var grup = [
      { nama: '01 / Parameter', item: [
        { key: 'skor_iklim', tipe: 'overlay' }, { key: 'skor_akses', tipe: 'overlay' }, { key: 'skor_lahan', tipe: 'overlay' },
        { key: 'gambut', label: 'Lahan gambut', src: 'GFW', tipe: 'vektor' },
        { key: 'tutupan', tipe: 'overlay' }, { key: 'ndvi', tipe: 'overlay' }, { key: 'hujan', tipe: 'overlay' },
        { key: 'lst', tipe: 'overlay' }, { key: 'jarak_mukim', tipe: 'overlay' }, { key: 'topografi', tipe: 'overlay' },
        { key: 'jalan', label: 'Jalan utama', src: 'OSM', tipe: 'vektor' },
        { key: 'sungai', label: 'Sungai dan kanal', src: 'OSM', tipe: 'vektor' },
        { key: 'permukiman', label: 'Permukiman', src: 'OSM', tipe: 'vektor' }
      ] },
      { nama: '02 / Hasil model', item: [
        { key: 'kelas_qgis', tipe: 'overlay', on: true },
        { key: 'bahaya', label: 'Peta bahaya on-the-fly', src: 'live', tipe: 'bahaya', on: !ov.kelas_qgis },
        { key: 'titik', label: 'Titik api', src: (S.hot.sumber || []).join(' + ') || '—', tipe: 'titik', on: true }
      ] },
      { nama: '03 / Dampak & validasi', item: [
        { key: 'kab', label: 'Dampak per kabupaten', src: '% bahaya tinggi+', tipe: 'kab' },
        { key: 'bakar', tipe: 'overlay' }
      ] }
    ];
    var wadah = $('layer-list');
    grup.forEach(function (g) {
      var d = el('div', { class: 'grup-layer' });
      d.appendChild(el('span', { class: 'lbl', text: g.nama }));
      g.item.forEach(function (it) {
        var ada = true;
        if (it.tipe === 'overlay') {
          var o = ov[it.key]; ada = !!o;
          it.label = o ? o.label : it.key; it.src = SRC_OVERLAY[it.key] || '';
          if (o) it.data = o;
        } else if (it.tipe === 'vektor') {
          ada = !!(m.vectors && m.vectors[it.key]);
        }
        if (it.tipe === 'overlay' && !ada) return; // tidak tersedia: disembunyikan
        var lab = el('label', { class: 'baris-layer' + (ada ? '' : ' kosong') });
        var cb = el('input', { type: 'checkbox' });
        S.cb = S.cb || {}; S.cb[it.key] = { cb: cb, it: it };
        cb.disabled = !ada;
        cb.checked = !!it.on && ada;
        lab.appendChild(cb);
        lab.appendChild(el('span', { text: it.label }));
        lab.appendChild(el('span', { class: 'src', text: ada ? it.src : 'belum ada' }));
        cb.addEventListener('change', function () { aturLayer(it, cb.checked); });
        d.appendChild(lab);
        if (cb.checked) aturLayer(it, true);
      });
      wadah.appendChild(d);
    });
  }

  function aturLayer(it, on) {
    var map = S.map, k = it.key;
    S.aktif[k] = on ? it : null;
    if (it.tipe === 'bahaya') {
      if (on) S.hazardOverlay.addTo(map); else map.removeLayer(S.hazardOverlay);
    } else if (it.tipe === 'titik') {
      if (!S.layers.titik) S.layers.titik = new LayerTitik();
      if (on) S.layers.titik.addTo(map); else map.removeLayer(S.layers.titik);
    } else if (it.tipe === 'kab') {
      if (!S.layers.kab) buatLayerKab();
      S.kabChoropleth = on;
      S.layers.kab.setStyle(gayaKab);
    } else if (it.tipe === 'overlay') {
      if (!S.layers[k]) S.layers[k] = L.imageOverlay(C.dataDir + it.data.file, it.data.bounds,
        { pane: 'raster', opacity: 0.85, className: it.data.legend.type === 'kategori' ? 'piksel' : '' });
      if (on) S.layers[k].addTo(map); else map.removeLayer(S.layers[k]);
    } else if (it.tipe === 'vektor') {
      if (on) {
        if (S.layers[k]) { S.layers[k].addTo(map); }
        else ambil(S.meta.vectors[k]).then(function (gj) { S.layers[k] = buatVektor(k, gj); if (S.aktif[k]) S.layers[k].addTo(map); });
      } else if (S.layers[k]) map.removeLayer(S.layers[k]);
    }
    if (!S.layers.kab) buatLayerKab();
    renderLegenda();
  }

  // Saat bobot digeser, tampilkan peta on-the-fly menggantikan peta resmi QGIS
  function setLayer(key, on) {
    var x = S.cb && S.cb[key];
    if (!x || x.cb.disabled || x.cb.checked === on) return;
    x.cb.checked = on; aturLayer(x.it, on);
  }

  function buatVektor(k, gj) {
    if (k === 'gambut') return L.geoJSON(gj, {
      pane: 'vektor', interactive: false,
      style: { color: '#0A0A0A', weight: 0.6, fillColor: '#0A0A0A', fillOpacity: 0.16 }
    });
    if (k === 'jalan') return L.geoJSON(gj, { pane: 'vektor', interactive: false, style: { color: '#0A0A0A', weight: 1.1, opacity: 0.85 } });
    if (k === 'sungai') return L.geoJSON(gj, { pane: 'vektor', interactive: false, style: { color: '#3B6EA8', weight: 1, opacity: 0.9 } });
    if (k === 'permukiman') return L.geoJSON(gj, {
      pane: 'vektor',
      pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 3, color: '#0A0A0A', weight: 1, fillColor: '#FFFFFF', fillOpacity: 1 }); },
      onEachFeature: function (f, l) { var p = f.properties || {}; if (p.nama) l.bindTooltip(esc(p.nama) + (p.kelas ? ' · ' + esc(p.kelas) : '')); }
    });
    return L.geoJSON(gj, { pane: 'vektor' });
  }

  function buatLayerKab() {
    S.layers.kab = L.geoJSON(S.kabGeo, { pane: 'kab', interactive: false, style: gayaKab }).addTo(S.map);
    S.layers.kab.eachLayer(function (l) { S.kabBounds[l.feature.properties.id] = l.getBounds(); });
  }

  function gayaKab(f) {
    var id = f.properties.id, sel = S.kabSel === id;
    var garis = S.basemapNama === 'terang' ? '#0A0A0A' : '#FFFFFF';
    var st = { color: garis, weight: sel ? 3 : 1, dashArray: sel ? null : '4 3', fill: false, fillOpacity: 0 };
    if (S.kabChoropleth && S.statsKab.length) {
      var s = S.statsKab.filter(function (x) { return x.id === id; })[0];
      if (s) {
        var abu = ['#F2F2F0', '#BDBDBA', '#8A8A8A', '#555555', '#0A0A0A'][Math.min(4, Math.floor(s.pctTinggi / 20))];
        st.fill = true; st.fillColor = abu; st.fillOpacity = 0.65;
        st.color = '#0A0A0A';
      }
    }
    return st;
  }

  // ------------------------------------------------------------------ model
  function siapkanModel() {
    var wadah = $('bobot-list');
    var skala = bobotSkala();
    S.params.forEach(function (p) {
      var d = el('div', { class: 'bobot' });
      var id = 'w-' + p.key;
      d.innerHTML = '<div class="bobot-atas"><label for="' + id + '">' + esc(p.label) + '</label><span class="mono" id="pct-' + p.key + '">—</span></div>' +
        '<input id="' + id + '" type="range" min="0" max="50" step="1">' +
        '<span class="ket">' + esc(p.sumber) + '</span>';
      wadah.appendChild(d);
      var inp = d.querySelector('input');
      inp.value = Math.round(S.weights[p.key] * skala);
      inp.addEventListener('input', function () {
        S.weights[p.key] = Number(inp.value) / skala;
        setLayer('bahaya', true); setLayer('kelas_qgis', false);
        nanti('model', hitungModel);
      });
    });
    if (S.model && S.model.ambang) {
      var opt = el('option', { value: 'qgis', text: 'Ambang QGIS (K1–K5)' });
      $('metode-kelas').insertBefore(opt, $('metode-kelas').firstChild);
      $('metode-kelas').value = 'qgis';
    } else {
      $('metode-kelas').value = C.metodeKelas || 'interval';
    }
    $('metode-kelas').addEventListener('change', function () { nanti('model', hitungModel); });
    $('opasitas').addEventListener('input', function () { S.hazardOverlay.setOpacity(Number($('opasitas').value) / 100); });
    $('reset-bobot').addEventListener('click', function () {
      S.params.forEach(function (p) {
        var w = S.bobotAwal[p.key]; S.weights[p.key] = (w === undefined || w === null ? 1 : w);
        $('w-' + p.key).value = Math.round(S.weights[p.key] * skala);
      });
      if (S.model && S.model.ambang) $('metode-kelas').value = 'qgis';
      setLayer('kelas_qgis', true); setLayer('bahaya', false);
      hitungModel();
    });
    if (S.model) {
      $('info-bobot').hidden = false;
      $('info-bobot').className = 'mono kecil redup';
      $('info-bobot').textContent = 'Bobot awal direkonstruksi dari indeks kerawanan QGIS kelompok (R² = ' + fmt(S.model.r2, 3) + '). Reset untuk kembali ke peta resmi.';
    } else if (!C.bobotSudahAHP) {
      $('info-bobot').hidden = false;
      $('info-bobot').textContent = 'Bobot masih sama rata (contoh). Isi bobot AHP kelompok di js/config.js.';
    }
  }

  // Skala supaya bobot relatif (mis. 0,35) muat di slider 0–50
  function bobotSkala() {
    var mx = 0;
    S.params.forEach(function (p) { var w = S.bobotAwal[p.key]; if (w > mx) mx = w; });
    return mx > 0 ? 30 / mx : 1;
  }

  function hitungModel() {
    var N = S.N, kab = S.bands.kab, ps = S.params.filter(function (p) { return S.weights[p.key] > 0; });
    var arr = ps.map(function (p) { return S.bands[p.key]; });
    var ws = ps.map(function (p) { return S.weights[p.key]; });
    var total = ws.reduce(function (a, b) { return a + b; }, 0);
    S.params.forEach(function (p) {
      $('pct-' + p.key).textContent = total > 0 ? Math.round(S.weights[p.key] / total * 100) + '%' : '0%';
    });
    var score = S.score, mn = Infinity, mx = -Infinity, nValid = 0, j, i;
    var np = arr.length;
    for (i = 0; i < N; i++) {
      if (!kab[i] || np === 0) { score[i] = NaN; continue; }
      var s = 0, sw = 0;
      for (j = 0; j < np; j++) { var v = arr[j][i]; if (v !== NODATA) { s += ws[j] * v; sw += ws[j]; } }
      if (sw === 0) { score[i] = NaN; continue; }
      var x = s / sw / 250;
      score[i] = x; nValid++;
      if (x < mn) mn = x; if (x > mx) mx = x;
    }
    // Ambang kelas
    var t = [];
    if ($('metode-kelas').value === 'qgis' && S.model && S.model.ambang) {
      t = S.model.ambang.slice();
    } else if ($('metode-kelas').value === 'kuantil' && nValid > 0) {
      var vals = new Float32Array(nValid), k = 0;
      for (i = 0; i < N; i++) if (score[i] === score[i]) vals[k++] = score[i];
      vals.sort();
      for (j = 1; j < 5; j++) t.push(vals[Math.min(nValid - 1, Math.floor(nValid * j / 5))]);
    } else {
      for (j = 1; j < 5; j++) t.push(mn + (mx - mn) * j / 5);
    }
    S.thresholds = t; S.scoreMin = mn; S.scoreMax = mx;
    var cls = S.cls;
    for (i = 0; i < N; i++) {
      var sc = score[i];
      if (sc !== sc) { cls[i] = NODATA; continue; }
      cls[i] = sc < t[0] ? 0 : sc < t[1] ? 1 : sc < t[2] ? 2 : sc < t[3] ? 3 : 4;
    }
    gambarBahaya();
    hitungStatistik();
    renderLegenda();
  }

  function gambarBahaya() {
    var ctx = S.hazardCanvas.getContext('2d');
    var img = ctx.createImageData(S.W, S.H), d = img.data;
    var warna = C.warnaKelas.map(hexRgb);
    for (var i = 0; i < S.N; i++) {
      var c = S.cls[i], o = i * 4;
      if (c === NODATA) { d[o + 3] = 0; continue; }
      d[o] = warna[c][0]; d[o + 1] = warna[c][1]; d[o + 2] = warna[c][2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    S.hazardOverlay.setUrl(S.hazardCanvas.toDataURL());
  }

  // ------------------------------------------------------------------ statistik
  function hitungStatistik() {
    var N = S.N, W = S.W, kab = S.bands.kab, cls = S.cls;
    var gambut = S.bands.gambut_ada || S.bands.gambut, kebun = S.bands.kebun, places = S.bands.places, bakar = S.bands.bakar;
    var per = {};
    S.meta.kab.forEach(function (k) {
      per[k.id] = { id: k.id, nama: k.nama, luas: 0, kelas: [0, 0, 0, 0, 0], gambutT: 0, kebunT: 0, placesT: 0, titik: 0, titikKelas: [0, 0, 0, 0, 0] };
    });
    var kq = S.bands.kelas_qgis;
    var prov = { cocok: 0, cocokTot: 0, id: 0, nama: 'Kalimantan Tengah', luas: 0, kelas: [0, 0, 0, 0, 0], gambutT: 0, kebunT: 0, placesT: 0, titik: 0, titikKelas: [0, 0, 0, 0, 0], bakarKelas: [0, 0, 0, 0, 0], bakarTot: 0 };
    for (var i = 0; i < N; i++) {
      var c = cls[i];
      if (c === NODATA) continue;
      var a = S.rowArea[(i / W) | 0], s = per[kab[i]];
      prov.luas += a; prov.kelas[c] += a;
      if (s) { s.luas += a; s.kelas[c] += a; }
      if (c >= 3) {
        if (gambut && gambut[i] > 0 && gambut[i] !== NODATA) { prov.gambutT += a; if (s) s.gambutT += a; }
        if (kebun && kebun[i] === 1) { prov.kebunT += a; if (s) s.kebunT += a; }
        if (places && places[i] !== NODATA && places[i] > 0) { prov.placesT += places[i]; if (s) s.placesT += places[i]; }
      }
      if (bakar && bakar[i] === 1) { prov.bakarKelas[c] += a; prov.bakarTot += a; }
      if (kq && kq[i] !== NODATA) { prov.cocokTot++; if (kq[i] === c) prov.cocok++; }
    }
    S.hotIdx.forEach(function (idx) {
      if (idx < 0) return;
      var c = cls[idx]; if (c === NODATA) return;
      prov.titik++; prov.titikKelas[c]++;
      var s = per[kab[idx]]; if (s) { s.titik++; s.titikKelas[c]++; }
    });
    S.statsProv = prov;
    S.statsKab = Object.keys(per).map(function (k) {
      var s = per[k]; s.pctTinggi = s.luas ? (s.kelas[3] + s.kelas[4]) / s.luas * 100 : 0; return s;
    });
    prov.pctTinggi = prov.luas ? (prov.kelas[3] + prov.kelas[4]) / prov.luas * 100 : 0;
    renderStatistik();
    if (S.layers.kab) S.layers.kab.setStyle(gayaKab);
  }

  function renderStatistik() {
    var s = S.kabSel ? S.statsKab.filter(function (x) { return x.id === S.kabSel; })[0] : S.statsProv;
    if (!s) return;
    $('stat-nama').textContent = S.kabSel ? s.nama : 'Kalteng';
    $('pilih-prov').hidden = !S.kabSel;
    var tinggi = s.kelas[3] + s.kelas[4];
    var kotak = [
      ['Bahaya tinggi+', fmt(tinggi) + ' km²', fmt(s.pctTinggi, 1) + '% wilayah'],
      ['Gambut di bahaya tinggi+', (S.bands.gambut_ada || S.bands.gambut) ? fmt(s.gambutT) + ' km²' : 'n/a', ''],
      S.bands.places ? ['Permukiman terpapar', fmt(s.placesT) + ' titik', 'OSM places'] : ['Perkebunan di bahaya tinggi+', S.bands.kebun ? fmt(s.kebunT) + ' km²' : 'n/a', ''],
      ['Titik api tampil', fmt(s.titik), 'sesuai filter']
    ];
    $('stat-kotak').innerHTML = kotak.map(function (k) {
      return '<div><div class="k-lbl">' + k[0] + '</div><div class="k-nilai">' + k[1] + '</div>' + (k[2] ? '<div class="k-lbl">' + k[2] + '</div>' : '') + '</div>';
    }).join('');
    var html = '';
    for (var c = 4; c >= 0; c--) {
      var pct = s.luas ? s.kelas[c] / s.luas * 100 : 0;
      html += '<div class="bar"><span>' + C.namaKelas[c] + '</span><span class="bar-luar"><span class="bar-dalam" style="width:' + pct.toFixed(1) + '%;background:' + C.warnaKelas[c] + '"></span></span><span class="mono">' + fmt(pct, 1) + '%</span></div>';
    }
    $('stat-kelas').innerHTML = html;
    var urut = S.statsKab.slice().sort(function (a, b) { return b.pctTinggi - a.pctTinggi; }).slice(0, 5);
    $('stat-peringkat').innerHTML = urut.map(function (k) {
      return '<li><button type="button" data-id="' + k.id + '">' + esc(k.nama) + '</button><span class="angka">' + fmt(k.pctTinggi, 1) + '%</span></li>';
    }).join('');
    $('stat-peringkat').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { pilihKab(Number(b.getAttribute('data-id')), true); });
    });
    renderValidasi();
  }

  function renderValidasi() {
    var p = S.statsProv, html = '', dens = [], mx = 0;
    for (var c = 0; c < 5; c++) {
      var d = p.kelas[c] > 0 ? p.titikKelas[c] / p.kelas[c] * 1000 : 0;
      dens.push(d); if (d > mx) mx = d;
    }
    for (c = 4; c >= 0; c--) {
      var w = mx ? dens[c] / mx * 100 : 0;
      html += '<div class="bar"><span>' + C.namaKelas[c] + '</span><span class="bar-luar"><span class="bar-dalam" style="width:' + w.toFixed(1) + '%;background:#0A0A0A"></span></span><span class="mono">' + fmt(dens[c], 1) + '</span></div>';
    }
    $('validasi').innerHTML = html;
    if (S.bands.bakar && p.bakarTot > 0) {
      var pb = (p.bakarKelas[3] + p.bakarKelas[4]) / p.bakarTot * 100;
      $('validasi-bakar').textContent = fmt(pb, 1) + '% area bekas terbakar historis jatuh di kelas tinggi+, padahal kelas itu ' + fmt(p.pctTinggi, 1) + '% luas provinsi.';
    } else {
      $('validasi-bakar').textContent = '';
    }
    if (p.cocokTot) {
      $('validasi-bakar').textContent += ' Kecocokan kelas dengan peta QGIS: ' + fmt(p.cocok / p.cocokTot * 100, 1) + '% sel.';
    }
    renderResmi();
  }

  function normNama(n) { return String(n || '').toLowerCase().replace(/kabupaten|kota/g, '').replace(/[^a-z]/g, ''); }

  function renderResmi() {
    var R = S.resmi, wadah = $('resmi');
    if (!R || !wadah) { if (wadah) wadah.parentNode.hidden = true; return; }
    var sel = S.kabSel ? normNama(S.kabNama[S.kabSel]) : null;
    var baris = R.baris.filter(function (b) { return !sel || normNama(b.kabupaten) === sel; });
    var html = '';
    if (sel && baris.length) {
      var b = baris[0];
      html += '<p class="mono kecil">' + esc(b.kabupaten) + ' · total ' + fmt(b.total_ha) + ' ha</p>';
      for (var c = 4; c >= 0; c--) {
        html += '<div class="bar"><span>' + R.kelas[c] + '</span><span class="bar-luar"><span class="bar-dalam" style="width:' + b.pct[c] + '%;background:' + C.warnaKelas[c] + '"></span></span><span class="mono">' + fmt(b.ha[c] / 1000, 1) + 'rb ha</span></div>';
      }
    } else {
      html += '<p class="mono kecil muted">% luas kelas K4+K5 per kabupaten/kota. Total Kalteng ' + fmt(R.total.k45_pct, 1) + '% (' + fmt(R.total.k45_ha) + ' ha).</p>';
      R.baris.slice().sort(function (a, b) { return b.k45_pct - a.k45_pct; }).forEach(function (b) {
        html += '<div class="bar"><span title="' + esc(b.kabupaten) + '">' + esc(b.kabupaten.replace('Kotawaringin', 'Kotawar.').replace('Kota ', '')) + '</span><span class="bar-luar"><span class="bar-dalam" style="width:' + b.k45_pct + '%;background:#0A0A0A"></span></span><span class="mono">' + fmt(b.k45_pct, 1) + '%</span></div>';
      });
    }
    wadah.innerHTML = html;
  }

  function pilihKab(id, zoom) {
    S.kabSel = id;
    if (S.layers.kab) S.layers.kab.setStyle(gayaKab);
    if (zoom && id && S.kabBounds[id]) S.map.fitBounds(S.kabBounds[id], { padding: [20, 20] });
    renderStatistik();
  }

  // ------------------------------------------------------------------ titik api & waktu
  function siapkanWaktu() {
    var h = S.hot, max = Math.max(0, (h.hari || 92) - 1);
    var inp = $('hari');
    inp.max = max; inp.value = max;
    var ticks = [0, Math.round(max / 3), Math.round(max * 2 / 3), max];
    $('skala-tgl').innerHTML = ticks.map(function (t) { return '<span>' + tglPendek(t) + '</span>'; }).join('');
    S.srcOn = (h.sumber || []).map(function () { return true; });
    $('filter-sumber').innerHTML = (h.sumber || []).map(function (s, i) {
      return '<label><input type="checkbox" data-i="' + i + '" checked> ' + esc(s) + '</label>';
    }).join('');
    $('filter-sumber').querySelectorAll('input').forEach(function (c) {
      c.addEventListener('change', function () { S.srcOn[Number(c.getAttribute('data-i'))] = c.checked; filterTitik(); });
    });
    inp.addEventListener('input', function () { nanti('titik', filterTitik); });
    $('mode-harian').addEventListener('change', filterTitik);
    $('filter-conf').addEventListener('change', filterTitik);
    $('play').addEventListener('click', putar);
  }

  function putar() {
    var inp = $('hari'), btn = $('play');
    if (S.timer) { clearInterval(S.timer); S.timer = null; btn.textContent = '▶'; btn.setAttribute('aria-label', 'Putar animasi'); return; }
    if (Number(inp.value) >= Number(inp.max)) inp.value = 0;
    btn.textContent = '❚❚'; btn.setAttribute('aria-label', 'Jeda animasi');
    S.timer = setInterval(function () {
      var v = Number(inp.value) + 1;
      if (v > Number(inp.max)) { clearInterval(S.timer); S.timer = null; btn.textContent = '▶'; btn.setAttribute('aria-label', 'Putar animasi'); return; }
      inp.value = v; filterTitik();
    }, 180);
  }

  function filterTitik() {
    var d = Number($('hari').value), harian = $('mode-harian').checked, cmin = Number($('filter-conf').value);
    var pts = S.hot.pts || [];
    S.hotFiltered = pts.filter(function (p) {
      if (harian ? p[2] !== d : p[2] > d) return false;
      if (!S.srcOn[p[3]]) return false;
      if (cmin >= 0 && p[4] >= 0 && p[4] < cmin) return false;
      return true;
    });
    S.hotIdx = S.hotFiltered.map(function (p) { return idxDariLatLng(p[1], p[0]); });
    $('tgl-label').textContent = (harian ? '' : '≤ ') + tanggal(d);
    $('jumlah-titik').textContent = fmt(S.hotFiltered.length);
    if (S.layers.titik && S.aktif.titik) S.layers.titik.redraw();
    if (S.cls && S.statsProv !== undefined) hitungStatistik();
    isiTicker();
  }

  // ------------------------------------------------------------------ klik peta
  function klikPeta(e) {
    var map = S.map;
    if (S.aktif.titik && S.hotLayar && S.hotLayar.length) {
      var q = map.latLngToContainerPoint(e.latlng), best = -1, bd = 64;
      S.hotLayar.forEach(function (t) { var dx = t[0] - q.x, dy = t[1] - q.y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = t[2]; } });
      if (best >= 0) {
        var p = S.hotFiltered[best], idx = S.hotIdx[best];
        var conf = ['rendah', 'nominal', 'tinggi'][p[4]] || '—';
        var jam = p[6] >= 0 ? ('000' + p[6]).slice(-4).replace(/(..)(..)/, '$1:$2') + ' UTC' : '—';
        L.popup().setLatLng([p[1], p[0]]).setContent(
          '<div class="pop-judul">Titik api · ' + esc(S.hot.sumber[p[3]]) + '</div><table class="pop-tabel">' +
          '<tr><td>Tanggal</td><td>' + tanggal(p[2]) + '</td></tr>' +
          '<tr><td>Jam</td><td>' + jam + '</td></tr>' +
          '<tr><td>Confidence</td><td>' + conf + '</td></tr>' +
          '<tr><td>FRP</td><td>' + (p[5] >= 0 ? fmt(p[5], 1) + ' MW' : '—') + '</td></tr>' +
          '<tr><td>Kelas bahaya</td><td>' + (idx >= 0 && S.cls[idx] !== NODATA ? C.namaKelas[S.cls[idx]] : '—') + '</td></tr>' +
          '<tr><td>Koordinat</td><td>' + p[1].toFixed(4) + ', ' + p[0].toFixed(4) + '</td></tr></table>').openOn(map);
        return;
      }
    }
    var i = idxDariLatLng(e.latlng.lat, e.latlng.lng);
    if (i < 0 || !S.bands.kab[i]) { pilihKab(0, false); map.closePopup(); return; }
    var kid = S.bands.kab[i];
    pilihKab(kid, false);
    var baris = S.params.map(function (p) {
      var v = S.bands[p.key][i];
      return '<tr><td>' + esc(p.label) + '</td><td>' + (v === NODATA ? '—' : Math.round(v / 2.5)) + '</td></tr>';
    }).join('');
    var c = S.cls[i];
    L.popup().setLatLng(e.latlng).setContent(
      '<div class="pop-judul">' + esc(S.kabNama[kid] || '') + '</div><table class="pop-tabel">' +
      '<tr><td>Kelas bahaya</td><td>' + (c === NODATA ? '—' : C.namaKelas[c]) + '</td></tr>' +
      '<tr><td>Skor</td><td>' + (S.score[i] === S.score[i] ? S.score[i].toFixed(3) : '—') + '</td></tr>' +
      (S.bands.bakar ? '<tr><td>Pernah terbakar</td><td>' + (S.bands.bakar[i] === 1 ? 'ya (2021–2025)' : 'tidak') + '</td></tr>' : '') +
      '<tr><td colspan="2" style="color:#FF8A63;padding-top:4px">Nilai rawan parameter (0–100)</td></tr>' + baris + '</table>').openOn(map);
  }

  // ------------------------------------------------------------------ legenda
  function renderLegenda() {
    var h = '';
    if (S.aktif.bahaya) {
      h += '<div class="leg-judul">Kelas bahaya api</div>';
      for (var c = 4; c >= 0; c--) h += '<div class="leg-baris"><span class="leg-kotak" style="background:' + C.warnaKelas[c] + '"></span><span>' + C.namaKelas[c] + '</span></div>';
    }
    if (S.aktif.titik) h += '<div class="leg-baris" style="margin-top:6px"><span class="leg-titik"><span></span></span><span>Titik api (' + esc((S.hot.sumber || []).join(', ')) + ')</span></div>';
    h += '<div class="leg-baris"><span class="leg-kotak" style="border:0;border-top:2px dashed #0A0A0A;height:0"></span><span>Batas kabupaten</span></div>';
    if (S.aktif.kab) {
      h += '<div class="leg-judul">Dampak: % wilayah bahaya tinggi+</div><div class="leg-ramp" style="background:linear-gradient(90deg,#F2F2F0,#BDBDBA,#8A8A8A,#555555,#0A0A0A)"></div><div class="leg-ramp-angka"><span>0%</span><span>40%</span><span>80–100%</span></div>';
    }
    if (S.aktif.gambut) h += '<div class="leg-baris"><span class="leg-kotak" style="background:rgba(10,10,10,.16)"></span><span>Lahan gambut</span></div>';
    if (S.aktif.jalan) h += '<div class="leg-baris"><span class="leg-kotak" style="border:0;border-top:2px solid #0A0A0A;height:0"></span><span>Jalan utama</span></div>';
    if (S.aktif.sungai) h += '<div class="leg-baris"><span class="leg-kotak" style="border:0;border-top:2px solid #3B6EA8;height:0"></span><span>Sungai dan kanal</span></div>';
    if (S.aktif.permukiman) h += '<div class="leg-baris"><span class="leg-titik"><span style="background:#fff;box-shadow:0 0 0 1.5px #0A0A0A"></span></span><span>Permukiman</span></div>';
    (S.meta.overlays || []).forEach(function (o) {
      if (!S.aktif[o.key]) return;
      h += '<div class="leg-judul">' + esc(o.label) + '</div>';
      if (o.legend.type === 'kategori') {
        o.legend.items.forEach(function (it) { h += '<div class="leg-baris"><span class="leg-kotak" style="background:' + it.warna + '"></span><span>' + esc(it.nama) + '</span></div>'; });
      } else {
        h += '<div class="leg-ramp" style="background:linear-gradient(90deg,' + o.legend.colors.join(',') + ')"></div>' +
          '<div class="leg-ramp-angka"><span>' + fmt(o.legend.min, 1) + '</span><span>' + esc(o.legend.unit || '') + '</span><span>' + fmt(o.legend.max, 1) + '</span></div>';
      }
    });
    $('legenda').innerHTML = h || '<p class="mono kecil muted">Tidak ada layer aktif.</p>';
  }

  // ------------------------------------------------------------------ cari & unduh
  function siapkanCari() {
    $('daftar-kab').innerHTML = S.meta.kab.map(function (k) { return '<option value="' + esc(k.nama) + '">'; }).join('');
    $('cari').addEventListener('change', function () {
      var q = $('cari').value.trim().toLowerCase();
      var k = S.meta.kab.filter(function (x) { return x.nama.toLowerCase() === q; })[0] ||
              S.meta.kab.filter(function (x) { return x.nama.toLowerCase().indexOf(q) >= 0; })[0];
      if (k) { gantiView('peta'); pilihKab(k.id, true); }
    });
    $('pilih-prov').addEventListener('click', function () { pilihKab(0, false); S.map.fitBounds(L.latLngBounds(S.meta.grid.bounds)); });
  }

  function siapkanUnduh() {
    $('unduh-titik').addEventListener('click', function () {
      var fc = { type: 'FeatureCollection', features: S.hotFiltered.map(function (p, i) {
        var idx = S.hotIdx[i];
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [p[0], p[1]] },
          properties: { tanggal: tanggal(p[2]), sumber: S.hot.sumber[p[3]], confidence: ['rendah', 'nominal', 'tinggi'][p[4]] || null,
            frp: p[5] >= 0 ? p[5] : null, jam_utc: p[6] >= 0 ? p[6] : null,
            kelas_bahaya: idx >= 0 && S.cls[idx] !== NODATA ? C.namaKelas[S.cls[idx]] : null,
            kabupaten: idx >= 0 ? (S.kabNama[S.bands.kab[idx]] || null) : null } };
      }) };
      unduh('titik_api_terfilter.geojson', JSON.stringify(fc), 'application/geo+json');
    });
    $('unduh-statistik').addEventListener('click', function () {
      var bobot = S.params.map(function (p) { return p.key + '=' + S.weights[p.key]; }).join(';');
      var rows = [['kabupaten', 'luas_km2'].concat(C.namaKelas.map(function (n) { return 'km2_' + n.toLowerCase().replace(/ /g, '_'); }))
        .concat(['pct_tinggi_plus', 'gambut_tinggi_km2', 'kebun_tinggi_km2', 'permukiman_tinggi', 'titik_api', 'bobot'])];
      S.statsKab.forEach(function (s) {
        rows.push(['"' + s.nama + '"', s.luas.toFixed(1)].concat(s.kelas.map(function (v) { return v.toFixed(1); }))
          .concat([s.pctTinggi.toFixed(2), s.gambutT.toFixed(1), s.kebunT.toFixed(1), s.placesT, s.titik, '"' + bobot + '"']));
      });
      unduh('statistik_kabupaten.csv', rows.map(function (r) { return r.join(','); }).join('\n'), 'text/csv');
    });
  }

  // ------------------------------------------------------------------ halaman teks
  function gantiView(v) {
    ['peta', 'metode', 'data', 'tentang'].forEach(function (k) { $('view-' + k).hidden = k !== v; });
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('aktif', b.getAttribute('data-view') === v); });
    if (v === 'peta' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  function isiTicker() {
    if (!S.meta) return;
    var p = S.meta.periode, n = (S.hot.pts || []).length;
    var t = ['Periode ' + p[0] + ' — ' + p[1], '✕ ' + fmt(n) + ' titik api (' + esc((S.hot.sumber || []).join(', ')) + ')',
      '✕ ' + S.params.length + ' parameter model', '✕ Bahaya tinggi+ ' + fmt(S.statsProv ? S.statsProv.pctTinggi : NaN, 1) + '% wilayah',
      '✕ Data diproses ' + esc(S.meta.dibuat || '')].map(function (s) { return '<span>' + s + '</span>'; }).join('');
    $('ticker').innerHTML = t + t;
  }

  function isiHalaman() {
    var baris = S.params.map(function (p) {
      var r = p.rentang ? fmt(p.rentang[0], 1) + ' – ' + fmt(p.rentang[1], 1) + ' ' + esc(p.satuan || '') : (p.key === 'gambut' ? 'gambut = 1, lainnya = 0' : 'skor per kelas');
      return '<tr><td>' + esc(p.label) + '</td><td>' + esc(p.sumber) + '</td><td>' + (p.arah === '+' ? 'makin besar makin rawan' : 'makin kecil/dekat makin rawan') + '</td><td>' + r + '</td><td>' + esc(p.alasan) + '</td></tr>';
    }).join('');
    $('isi-metode').innerHTML =
      '<h1>Metode pemodelan bahaya</h1>' +
      '<p>Peta bahaya api dihitung dengan <b>kombinasi linear berbobot</b> (Weighted Linear Combination; Malczewski, 1999). Setiap parameter diubah ke skala 0–1 (1 = paling rawan) setelah dipotong pada persentil 2–98% agar tidak didominasi pencilan (Richards, 2013). Bobot awal berasal dari AHP kelompok (Saaty, 1980) dan bisa diubah langsung di panel kiri.</p>' +
      '<span class="rumus">S = Σ (w<sub>i</sub> · x<sub>i</sub>) / Σ w<sub>i</sub></span>' +
      '<p>Skor dibagi menjadi 5 kelas, dengan interval sama antara skor minimum–maksimum atau kuantil (masing-masing 20% luas). Grid model berukuran ' + fmt(S.meta.grid.res, 3) + '° (sekitar ' + fmt(S.meta.grid.res * 111.32, 1) + ' km).</p>' +
      '<h3>Parameter</h3><table><tr><th>Parameter</th><th>Sumber</th><th>Arah</th><th>Rentang normalisasi</th><th>Alasan</th></tr>' + baris + '</table>' +
      '<h3>Validasi</h3><p>Dua indikator dihitung ulang setiap kali bobot berubah: (1) kepadatan titik api per 1.000 km² di tiap kelas, yang seharusnya naik dari kelas rendah ke tinggi; (2) persentase area terbakar historis yang jatuh di kelas tinggi+, dibandingkan dengan luas kelas itu. Validasi formal dengan ROC/AUC dilakukan di QGIS dan dilaporkan terpisah.</p>' +
      '<h3>Dampak</h3><p>Per kabupaten dihitung luas wilayah bahaya tinggi+, luas gambut di kelas tinggi+, jumlah titik permukiman (OpenStreetMap) di kelas tinggi+, dan jumlah titik api.</p>' +
      '<h3>Referensi</h3><ul>' +
      '<li>Chuvieco, E. &amp; Congalton, R.G. (1989). Application of remote sensing and GIS to forest fire hazard mapping. <i>Remote Sensing of Environment</i>, 29(2), 147–159.</li>' +
      '<li>Chuvieco, E., et al. (2004). Combining NDVI and surface temperature for the estimation of live fuel moisture content in forest fire danger rating. <i>Remote Sensing of Environment</i>, 92(3), 322–331.</li>' +
      '<li>Hooijer, A., et al. (2010). Current and future CO<sub>2</sub> emissions from drained peatlands in Southeast Asia. <i>Biogeosciences</i>, 7, 1505–1514.</li>' +
      '<li>Malczewski, J. (1999). <i>GIS and Multicriteria Decision Analysis</i>. Wiley.</li>' +
      '<li>Page, S.E., et al. (2002). The amount of carbon released from peat and forest fires in Indonesia during 1997. <i>Nature</i>, 420, 61–65.</li>' +
      '<li>Richards, J.A. (2013). <i>Remote Sensing Digital Image Analysis</i> (5th ed.). Springer.</li>' +
      '<li>Saaty, T.L. (1980). <i>The Analytic Hierarchy Process</i>. McGraw-Hill.</li></ul>';

    var ov = (S.meta.overlays || []).map(function (o) { return '<tr><td>' + esc(o.label) + '</td><td>Raster (PNG tampilan)</td><td>' + esc(o.file) + '</td></tr>'; }).join('');
    var vec = Object.keys(S.meta.vectors || {}).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>Vektor (GeoJSON)</td><td>' + esc(S.meta.vectors[k]) + '</td></tr>'; }).join('');
    var hitung = (S.hot.sumber || []).map(function (s, i) { return esc(s) + ': ' + fmt((S.hot.pts || []).filter(function (p) { return p[3] === i; }).length); }).join(' · ');
    $('isi-data').innerHTML =
      '<h1>Data</h1><p>Periode ' + S.meta.periode[0] + ' sampai ' + S.meta.periode[1] + '. Data diproses ' + esc(S.meta.dibuat) + '. Semua data memakai EPSG:4326.</p>' +
      '<h3>Titik api</h3><p>' + hitung + '. Confidence VIIRS mengikuti kelas rendah/nominal/tinggi (Schroeder et al., 2014); MODIS dikelompokkan &lt;30, 30–79, ≥80 (Giglio et al., 2016).</p>' +
      '<h3>Layer</h3><table><tr><th>Layer</th><th>Jenis</th><th>Berkas</th></tr>' + ov + vec + '</table>' +
      '<h3>Grid model</h3><p>' + S.W + ' × ' + S.H + ' sel, ' + S.meta.bands.length + ' band (' + esc(S.meta.bands.join(', ')) + ').</p>';
    $('isi-tentang').innerHTML =
      '<h1>' + esc(C.judul) + '</h1><p>' + esc(C.subjudul) + '. WebGIS pemantauan titik api dan pemodelan bahaya kebakaran hutan dan lahan Provinsi Kalimantan Tengah, dibuat untuk PjBL GD4103 Sistem Informasi Geografis, Teknik Geodesi dan Geomatika ITB, 2026.</p>' +
      '<p>Peta ini hasil pemodelan untuk keperluan pembelajaran, bukan informasi resmi. Untuk peringatan kebakaran gunakan SiPongi+ (Kementerian Kehutanan) dan BMKG.</p>' +
      '<p class="mono kecil">Dibangun dengan Leaflet 1.9.4 · basemap © OpenStreetMap, CARTO, Esri.</p>';
    isiTicker();
  }

  document.addEventListener('DOMContentLoaded', mulai);
})();
