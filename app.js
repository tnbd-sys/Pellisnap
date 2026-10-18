'use strict';

/* ============ Utilitaires ============ */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => parse(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const addDay = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const plural = (n, a, b) => n + ' ' + (n > 1 ? b : a);

/* ============ Stockage (IndexedDB) ============ */
const DB = new Promise((res, rej) => {
  const r = indexedDB.open('pellisnap', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    d.createObjectStore('meta');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

function tx(store, mode, fn) {
  return DB.then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

const countPhotos = () => tx('photos', 'readonly', s => s.count());
const allKeys = () => tx('photos', 'readonly', s => s.getAllKeys());
const getPhoto = k => tx('photos', 'readonly', s => s.get(k));

/* ============ ZIP (sans compression, JPEG déjà compressés) ============ */
// ZIP-START
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function makeZip(files) { // files: [{ name, blob }]
  const parts = [], central = [];
  let offset = 0;
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);

    offset += 30 + name.length + data.length;
  }
  let csize = 0;
  for (const p of central) csize += p.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
// ZIP-END

/* ============ Filtres vintage (traitement pixel) ============ */
// FILTER-START
// Les 3 premiers reprennent les styles proposés par l'appareil Timelens (Classique, Rétro, Noir et blanc),
// d'après les descriptions publiées : neutre / teinte chaude + grain léger / fort contraste.
// Les 2 derniers sont des extras.
const FILTERS = {
  classique: { n: 'Classique',    gain: [1.00, 1.00, 1.00], off: [0, 0, 0],    sat: 1.00, con: 1.05, bri: 1.00, fade: 6,  vig: 0.12, grain: 4,  css: 'contrast(1.05)' },
  retro:     { n: 'Rétro',        gain: [1.07, 1.00, 0.90], off: [6, 2, -2],   sat: 0.95, con: 1.05, bri: 1.00, fade: 14, vig: 0.22, grain: 8,  css: 'sepia(.22) saturate(.95) contrast(1.05)' },
  noir:      { n: 'Noir & blanc', gain: [1, 1, 1],          off: [0, 0, 0],    sat: 0.00, con: 1.40, bri: 1.00, fade: 8,  vig: 0.30, grain: 14, css: 'grayscale(1) contrast(1.4)' },
  soleil:    { n: 'Soleil',       gain: [1.12, 1.05, 0.82], off: [14, 10, -6], sat: 1.05, con: 0.98, bri: 1.14, fade: 26, vig: 0.15, grain: 14, leak: 1, css: 'sepia(.35) brightness(1.15) saturate(1.1)' },
  froid:     { n: 'Froid',        gain: [0.92, 1.03, 1.10], off: [0, 6, 8],    sat: 0.95, con: 1.04, bri: 1.02, fade: 20, vig: 0.30, grain: 10, css: 'hue-rotate(-8deg) saturate(.95) brightness(1.02)' }
};

// data : Uint8ClampedArray RGBA d'une image de W x H pixels
function applyFilter(data, W, H, f, flash) {
  const con = f.con * (flash ? 1.08 : 1);
  const fk = f.fade / 255;
  const g0 = f.gain[0], g1 = f.gain[1], g2 = f.gain[2];
  const o0 = f.off[0], o1 = f.off[1], o2 = f.off[2];
  const MAXD = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    const ny = (y / H - 0.5) * 2;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      const nx = (x / W - 0.5) * 2;
      const dist = Math.min(1, Math.sqrt(nx * nx + ny * ny) / MAXD);

      r *= f.bri; g *= f.bri; b *= f.bri;

      if (flash) { // flash direct : centre brûlé, bords plus sombres
        const k = 1 + 0.32 * Math.pow(1 - dist, 1.6) - 0.22 * dist;
        r *= k; g *= k; b *= k;
      }

      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * f.sat;
      g = l + (g - l) * f.sat;
      b = l + (b - l) * f.sat;

      r = r * g0 + o0; g = g * g1 + o1; b = b * g2 + o2;

      r = (r - 128) * con + 128;
      g = (g - 128) * con + 128;
      b = (b - 128) * con + 128;

      r = r * (1 - fk) + f.fade;
      g = g * (1 - fk) + f.fade;
      b = b * (1 - fk) + f.fade;

      const v = 1 - f.vig * dist * dist;
      r *= v; g *= v; b *= v;

      if (f.leak) { // fuite de lumière orangée à gauche et en bas
        const lk = Math.max(0, 1 - x / (W * 0.35)) * 0.55 + Math.max(0, (y / H - 0.8) / 0.2) * 0.25;
        r += 230 * lk; g += 115 * lk; b += 25 * lk;
      }

      const n = (Math.random() - 0.5) * f.grain * 2;
      data[i] = r + n;       // Uint8ClampedArray borne à 0-255
      data[i + 1] = g + n;
      data[i + 2] = b + n;
    }
  }
}
// FILTER-END

/* ============ Etat ============ */
let trip = null;           // { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
let editing = false;
let filterKey = 'classique';
let flashOn = false;
let busy = false;
let stream = null;
let shown = 0;             // phase affichée, pour éviter de relancer la caméra
let galKeys = [];
let galPos = 0;

const standalone = () => navigator.standalone === true ||
  (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

async function loadTrip() {
  let t = null;
  try { t = await tx('meta', 'readonly', s => s.get('trip')); } catch (e) {}
  if (!t) { try { t = JSON.parse(localStorage.getItem('pellisnap.trip') || 'null'); } catch (e) {} }
  trip = t;
}

async function saveTrip(t) {
  trip = t;
  try { localStorage.setItem('pellisnap.trip', JSON.stringify(t)); } catch (e) {}
  try { await tx('meta', 'readwrite', s => s.put(t, 'trip')); } catch (e) {}
}

function phase() {
  if (!trip) return 'setup';
  const t = ymd(new Date());
  if (t < trip.start) return 'before';
  if (t <= trip.end) return 'active';
  return 'ended';
}

async function askPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}

/* ============ Affichage ============ */
async function render() {
  const p = editing ? 'setup' : phase();
  const key = p + (editing ? '*' : '');
  ['sSetup', 'sWait', 'sCam', 'sGal'].forEach(id => { $(id).hidden = true; });

  if (p !== 'active') stopCam();

  if (p === 'setup') {
    $('sSetup').hidden = false;
    const today = ymd(new Date());
    $('dStart').value = trip ? trip.start : today;
    $('dEnd').value = trip ? trip.end : '';
    $('setupErr').textContent = '';
    $('bCancelSetup').hidden = !trip;
    $('installHint').hidden = standalone();
  } else if (p === 'before') {
    $('sWait').hidden = false;
    const n = daysBetween(ymd(new Date()), trip.start);
    $('waitText').textContent = 'Ton voyage commence le ' + fmtDate(trip.start) + ' (dans ' +
      plural(n, 'jour', 'jours') + '). L\'appareil s\'activera ce jour-là.';
    $('installHint2').hidden = standalone();
  } else if (p === 'active') {
    $('sCam').hidden = false;
    await refreshCamInfo();
    if (shown !== 'active') startCam();
  } else {
    $('sGal').hidden = false;
    await renderGallery();
  }
  shown = p === 'active' && !editing ? 'active' : key;
}

async function refreshCamInfo() {
  const keys = await allKeys();
  const n = keys.length;
  $('cnt').textContent = n;
  const reveal = addDay(trip.end, 1);
  let t = 'Photos visibles à partir du ' + fmtDate(reveal) + '.';
  if (n > 0) {
    const b = await getBackup();
    const saved = new Set((b && b.keys) || []);
    const unsaved = keys.filter(k => !saved.has(k)).length;
    if (unsaved === 0) {
      t += '\nToutes les photos sont sauvegardées.';
    } else {
      t += '\n' + plural(unsaved, 'photo non sauvegardée', 'photos non sauvegardées') +
        (b ? ' (dernière sauvegarde le ' + new Date(b.ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ').' : ' (aucune sauvegarde).');
    }
  }
  $('camInfo').textContent = t;
}

/* Sauvegarde de secours : mémorise quelles photos ont été exportées en ZIP */
async function getBackup() {
  try { return (await tx('meta', 'readonly', s => s.get('backup'))) || null; } catch (e) { return null; }
}
async function markSaved(keys) {
  try {
    const b = (await getBackup()) || { keys: [] };
    const set = new Set(b.keys);
    keys.forEach(k => set.add(k));
    await tx('meta', 'readwrite', s => s.put({ ts: Date.now(), keys: [...set] }, 'backup'));
  } catch (e) {}
}

/* ============ Réglage des dates ============ */
$('bSave').onclick = async () => {
  const s = $('dStart').value, e = $('dEnd').value;
  const err = $('setupErr');
  if (!s || !e) { err.textContent = 'Renseigne les deux dates.'; return; }
  if (e < s) { err.textContent = 'La fin doit être après le début.'; return; }
  if (e < ymd(new Date())) { err.textContent = 'La date de fin est déjà passée.'; return; }
  await saveTrip({ start: s, end: e });
  askPersist();
  editing = false;
  shown = 0;
  render();
};
$('bCancelSetup').onclick = () => { editing = false; render(); };
$('bEditWait').onclick = () => { editing = true; render(); };
$('bEdit').onclick = async () => {
  if (await countPhotos() > 0) {
    alert('Impossible de modifier les dates une fois des photos prises.');
    return;
  }
  editing = true;
  render();
};

/* ============ Caméra ============ */
async function startCam() {
  stopCam();
  $('camMsg').hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamMsg('Caméra indisponible dans ce navigateur.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false
    });
    const v = $('video');
    v.srcObject = stream;
    await v.play().catch(() => {});
  } catch (e) {
    showCamMsg('Accès à la caméra refusé. Autorise-le dans Réglages > Safari > Caméra, puis rouvre l\'app.');
  }
}

function stopCam() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const v = $('video');
  if (v) v.srcObject = null;
}

function showCamMsg(t) { const m = $('camMsg'); m.textContent = t; m.hidden = false; }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCam();
  else if (phase() === 'active' && !editing) startCam();
});

/* Filtres */
function buildFilters() {
  const box = $('filters');
  box.innerHTML = '';
  Object.keys(FILTERS).forEach(k => {
    const b = document.createElement('button');
    b.className = 'fbtn' + (k === filterKey ? ' on' : '');
    b.textContent = FILTERS[k].n;
    b.onclick = () => {
      filterKey = k;
      box.querySelectorAll('.fbtn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('video').style.filter = FILTERS[k].css;
    };
    box.appendChild(b);
  });
  $('video').style.filter = FILTERS[filterKey].css;
}

$('bFlash').onclick = () => {
  flashOn = !flashOn;
  $('bFlash').setAttribute('aria-pressed', String(flashOn));
  $('bFlash').textContent = 'Flash : ' + (flashOn ? 'oui' : 'non');
};

/* Prise de vue */
const wait = ms => new Promise(r => setTimeout(r, ms));

$('bShoot').onclick = async () => {
  if (busy) return;
  const v = $('video');
  if (!stream || !v.videoWidth) return;
  busy = true;
  $('bShoot').disabled = true;
  try {
    const fl = $('flash');
    if (flashOn) {
      fl.className = 'on';
      await wait(110);
    }
    // Format jetable 3:2, paysage ou portrait selon l'orientation du flux caméra
    const land = v.videoWidth >= v.videoHeight;
    const W = land ? 1536 : 1024, H = land ? 1024 : 1536;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    let sw = v.videoWidth, sh = v.videoHeight;
    if (sw / sh > W / H) sw = sh * W / H; else sh = sw * H / W;
    ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, W, H);
    if (flashOn) { fl.className = 'off'; }

    const img = ctx.getImageData(0, 0, W, H);
    applyFilter(img.data, W, H, FILTERS[filterKey], flashOn);
    ctx.putImageData(img, 0, 0);

    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('encodage');
    await tx('photos', 'readwrite', s => s.add({ blob, ts: Date.now(), filter: filterKey, flash: flashOn }));

    await refreshCamInfo();
    const ej = $('eject');
    ej.classList.remove('go');
    void ej.offsetWidth;
    ej.classList.add('go');
  } catch (e) {
    alert('La photo n\'a pas pu être enregistrée. Réessaie.');
    $('flash').className = '';
  } finally {
    busy = false;
    $('bShoot').disabled = false;
  }
};

/* ============ Galerie ============ */
const PAGE = 60;
const BATCH = 30;
let urls = [];

function revokeAll() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }

async function renderGallery() {
  galKeys = (await allKeys()).sort((a, b) => a - b);
  galPos = 0;
  revokeAll();
  $('grid').innerHTML = '';
  $('galInfo').textContent = galKeys.length
    ? plural(galKeys.length, 'photo', 'photos') + ' prises du ' + fmtDate(trip.start) + ' au ' + fmtDate(trip.end) + '.'
    : 'Aucune photo prise pendant ce voyage.';
  buildBatches($('batches'), galKeys, false);
  await showMore();
}

async function showMore() {
  const slice = galKeys.slice(galPos, galPos + PAGE);
  for (const k of slice) {
    const rec = await getPhoto(k);
    if (!rec) continue;
    const u = URL.createObjectURL(rec.blob);
    urls.push(u);
    const im = document.createElement('img');
    im.src = u;
    im.loading = 'lazy';
    im.alt = '';
    im.onclick = () => { $('viewImg').src = u; $('viewer').hidden = false; };
    $('grid').appendChild(im);
  }
  galPos += slice.length;
  $('bMore').hidden = galPos >= galKeys.length;
}

$('bMore').onclick = showMore;
$('viewer').onclick = () => { $('viewer').hidden = true; $('viewImg').removeAttribute('src'); };

const photoName = (rec, k) => {
  const d = new Date(rec.ts);
  return 'pellisnap_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '_' + k + '.jpg';
};

async function loadBatch(keys) {
  const out = [];
  for (const k of keys) {
    const rec = await getPhoto(k);
    if (rec) out.push({ name: photoName(rec, k), blob: rec.blob });
  }
  return out;
}

// Premier appui : prépare (le partage iOS exige un geste récent). Second appui : partage / télécharge.
function twoStep(btn, label, prepare, go) {
  let ready = null;
  btn.textContent = label;
  btn.onclick = async () => {
    if (!ready) {
      btn.disabled = true;
      btn.textContent = 'Préparation…';
      try {
        ready = await prepare();
        btn.textContent = 'Enregistrer';
        btn.classList.add('ready');
      } catch (e) {
        btn.textContent = 'Erreur, réessayer';
      }
      btn.disabled = false;
      return;
    }
    try {
      await go(ready);
    } catch (e) {
      if (!e || e.name !== 'AbortError') alert('Partage impossible. Essaie le ZIP, ou ouvre une photo et appuie longuement dessus.');
    }
  };
}

function download(file) {
  const u = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = u;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

// box : conteneur ; allK : clés triées ; zipOnly : sauvegarde de secours (ZIP seulement, sans bouton « Photos »)
function buildBatches(box, allK, zipOnly) {
  box.innerHTML = '';
  for (let i = 0; i < allK.length; i += BATCH) {
    const keys = allK.slice(i, i + BATCH);
    const n = i / BATCH + 1;
    const row = document.createElement('div');
    row.className = 'batch';
    const lab = document.createElement('span');
    lab.textContent = 'Lot ' + n + ' · ' + (i + 1) + '–' + (i + keys.length);
    const bz = document.createElement('button');
    row.appendChild(lab);
    if (!zipOnly) {
      const bp = document.createElement('button');
      row.appendChild(bp);
      twoStep(bp, 'Photos',
        async () => (await loadBatch(keys)).map(f => new File([f.blob], f.name, { type: 'image/jpeg' })),
        async files => {
          if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files });
          else throw new Error('no-share');
        });
    }
    row.appendChild(bz);
    box.appendChild(row);

    twoStep(bz, 'ZIP',
      async () => new File([await makeZip(await loadBatch(keys))], 'pellisnap_lot' + n + '.zip', { type: 'application/zip' }),
      async file => {
        if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
        else download(file);
        await markSaved(keys);
        bz.textContent = 'Sauvegardé ✓';
        if (!$('sCam').hidden) refreshCamInfo();
      });
  }
}

/* Filet de sécurité : sauvegarde ZIP pendant le voyage, sans afficher les photos */
$('bBackup').onclick = async () => {
  const p = $('backup');
  if (!p.hidden) { p.hidden = true; return; }
  const keys = (await allKeys()).sort((a, b) => a - b);
  if (!keys.length) { alert('Aucune photo à sauvegarder pour l\'instant.'); return; }
  buildBatches($('backupBatches'), keys, true);
  p.hidden = false;
};

/* Viseur : format 3:2, paysage ou portrait selon le flux caméra */
function updateVF() {
  const v = $('video');
  if (!v.videoWidth) return;
  $('vf').className = 'vf ' + (v.videoWidth >= v.videoHeight ? 'land' : 'port');
}
$('video').addEventListener('loadedmetadata', updateVF);
$('video').addEventListener('resize', updateVF);
window.addEventListener('resize', updateVF);
window.addEventListener('orientationchange', () => setTimeout(updateVF, 300));

$('bWipe').onclick = async () => {
  if (!confirm('Supprimer toutes les photos de l\'app ? Vérifie d\'abord qu\'elles sont enregistrées dans Photos ou Fichiers.')) return;
  if (!confirm('Dernière confirmation : suppression définitive.')) return;
  await tx('photos', 'readwrite', s => s.clear());
  renderGallery();
};

/* ============ Démarrage ============ */
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev =>
  document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('contextmenu', e => { if (e.target.id !== 'viewImg') e.preventDefault(); });

(async function init() {
  buildFilters();
  await loadTrip();
  askPersist();
  await render();
  setInterval(() => { if (!editing && phase() + '' !== shown) render(); }, 60000);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
