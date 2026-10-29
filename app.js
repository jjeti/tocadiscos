// Tocadiscos: reproductor de audio local con plato, brazo y visualizador animados.

const $ = (id) => document.getElementById(id);

const audio = $('audio');
const deckWrap = $('deckWrap');
const deck = $('deck');
const vinyl = $('vinyl');
const tonearm = $('tonearm');
const knob = $('knob');
const pilot = $('pilot');
const playBtn = $('playBtn');
const viz = $('viz');
const vctx = viz.getContext('2d');

// ---------- Geometría (coordenadas internas del deck 640x460) ----------
const DECK_W = 640;
const DECK_H = 460;
const PIVOT = { x: 540, y: 90 };
const REST = 0;      // brazo sobre el apoyo
const START = 33.5;  // aguja en el borde exterior del disco
const END = 52;      // aguja al final de los surcos
const SPIN = { 33: 200, 45: 270 };    // grados/segundo (33⅓ y 45 rpm)
const PITCH = { 33: 1, 45: 1.35 };    // velocidad de reproducción
const ACTIVE = ['cueing', 'dropping', 'playing'];

// ---------- Estado ----------
let tracks = [];
let current = -1;
let rpm = 33;
let volume = 0.8;
let scale = 1;

let ctx = null, analyser = null, gain = null, freqData = null;

let state = 'rest'; // rest | cueing | dropping | playing | lifting | returning | dragging
let stateTime = 0;
let armAngle = REST;
let platterAngle = 0;
let platterSpeed = 0;
let motorOn = false;
let pendingSeek = null;
let dragPreview = null;

// ---------- Persistencia: archivos en IndexedDB, ajustes en localStorage ----------
const SETTINGS_KEY = 'tocadiscos:settings';
let db = null;
let restored = false; // no guardar nada hasta haber restaurado lo anterior

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tocadiscos', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbRun(mode, fn) {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', mode);
    const req = fn(tx.objectStore('tracks'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

function saveTrack(t) {
  const record = { id: t.id, file: t.file, title: t.title, artist: t.artist, duration: t.duration };
  dbRun('readwrite', (s) => s.put(record)).catch((e) => console.warn('No se pudo guardar la pista:', e));
}

function deleteTrack(id) {
  dbRun('readwrite', (s) => s.delete(id)).catch((e) => console.warn('No se pudo borrar la pista:', e));
}

function saveSettings() {
  if (!restored) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      order: tracks.map((t) => t.id),
      currentId: current >= 0 ? tracks[current].id : null,
      time: audio.currentTime || 0,
      rpm,
      volume,
    }));
  } catch { /* almacenamiento no disponible */ }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const angleFor = (p) => START + (END - START) * clamp(p, 0, 1);

function progress() {
  return isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
}

function fmt(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setState(s) {
  state = s;
  stateTime = performance.now();
  tonearm.classList.toggle('lifted', ['cueing', 'lifting', 'returning', 'dragging'].includes(s));
  tonearm.classList.toggle('dragging', s === 'dragging');
  updateButtons();
}

function updateButtons() {
  const playing = ACTIVE.includes(state);
  playBtn.classList.toggle('is-playing', playing);
  playBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
  pilot.classList.toggle('on', motorOn);
}

// ---------- Audio (Web Audio API) ----------
function initAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function applyPitch() {
  audio.preservesPitch = false;
  audio.mozPreservesPitch = false;
  audio.webkitPreservesPitch = false;
  audio.defaultPlaybackRate = PITCH[rpm];
  audio.playbackRate = PITCH[rpm];
}

// ---------- Playlist ----------
function parseName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const parts = base.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: 'Artista desconocido', title: base };
}

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;

// Ruta relativa de los archivos que llegan arrastrando una carpeta
const dropPaths = new WeakMap();
const sortKey = (f) => dropPaths.get(f) || f.webkitRelativePath || f.name;
const byPath = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

function addFiles(fileList) {
  const files = [...fileList]
    .filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name))
    .sort((a, b) => byPath.compare(sortKey(a), sortKey(b))); // "02 …" antes que "10 …"
  if (!files.length && fileList.length) {
    $('plEmpty').hidden = false;
    $('plEmpty').textContent = 'No se encontraron archivos de audio en lo que has añadido.';
    return;
  }
  for (const file of files) {
    const track = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      ...parseName(file.name),
      url: URL.createObjectURL(file),
      duration: NaN,
    };
    tracks.push(track);
    saveTrack(track);
    probeDuration(track);
  }
  if (files.length && current < 0) loadTrack(0);
  saveSettings();
  renderPlaylist();
}

// Leer la duración sin cargar la pista en el reproductor
function probeDuration(track) {
  const probe = new Audio();
  probe.preload = 'metadata';
  probe.src = track.url;
  probe.addEventListener('loadedmetadata', () => {
    track.duration = probe.duration;
    saveTrack(track);
    renderPlaylist();
  }, { once: true });
}

function loadTrack(i) {
  current = i;
  const t = tracks[i];
  audio.src = t.url;
  applyPitch();
  $('labelTitle').textContent = t.title;
  $('labelArtist').textContent = t.artist;
  $('nowTitle').textContent = t.title;
  $('nowArtist').textContent = t.artist;
  document.title = `${t.title} · Tocadiscos`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist });
  }
  saveSettings();
  renderPlaylist();
}

function clearDeck() {
  current = -1;
  audio.removeAttribute('src');
  audio.load();
  $('labelTitle').textContent = 'Añade música';
  $('labelArtist').textContent = 'Arrastra archivos o una carpeta';
  $('nowTitle').textContent = 'Sin canción';
  $('nowArtist').textContent = 'Añade archivos de audio para empezar';
  document.title = 'Tocadiscos';
}

function renderPlaylist() {
  const list = $('plList');
  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'pl-item' + (i === current ? ' active' : '');
    li.innerHTML = `
      <span class="pl-num">${i + 1}</span>
      <div class="pl-meta"><div class="pl-title"></div><div class="pl-artist"></div></div>
      <span class="pl-dur">${fmt(t.duration)}</span>
      <button class="pl-del" title="Quitar">×</button>`;
    li.querySelector('.pl-title').textContent = t.title;
    li.querySelector('.pl-artist').textContent = t.artist;
    li.addEventListener('click', () => {
      if (ACTIVE.includes(state)) selectTrack(i);
      else { loadTrack(i); play(); }
    });
    li.querySelector('.pl-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTrack(i);
    });
    list.appendChild(li);
  });
  $('plEmpty').hidden = tracks.length > 0;
  $('clearBtn').hidden = tracks.length === 0;
}

function removeTrack(i) {
  const wasActive = ACTIVE.includes(state);
  URL.revokeObjectURL(tracks[i].url);
  deleteTrack(tracks[i].id);
  if (i === current) {
    tracks.splice(i, 1);
    if (tracks.length) {
      if (wasActive) {
        setState('cueing');
        audio.pause();
      }
      loadTrack(Math.min(i, tracks.length - 1));
    } else {
      motorOn = false;
      setState('returning');
      clearDeck();
    }
  } else {
    tracks.splice(i, 1);
    if (i < current) current--;
  }
  saveSettings();
  renderPlaylist();
}

function clearPlaylist() {
  motorOn = false;
  if (state !== 'rest') setState('returning');
  audio.pause();
  tracks.forEach((t) => URL.revokeObjectURL(t.url));
  tracks = [];
  clearDeck();
  dbRun('readwrite', (s) => s.clear()).catch((e) => console.warn('No se pudo vaciar:', e));
  saveSettings();
  renderPlaylist();
}

// Vaciar pide una segunda pulsación para evitar borrados accidentales
let clearArmed = null;
$('clearBtn').addEventListener('click', () => {
  const btn = $('clearBtn');
  if (clearArmed) {
    clearTimeout(clearArmed);
    clearArmed = null;
    btn.textContent = 'Vaciar playlist';
    clearPlaylist();
    return;
  }
  btn.textContent = '¿Seguro? Pulsa otra vez';
  clearArmed = setTimeout(() => {
    clearArmed = null;
    btn.textContent = 'Vaciar playlist';
  }, 3000);
});

// ---------- Controles de reproducción ----------
function play() {
  if (!tracks.length) {
    $('fileInput').click();
    return;
  }
  initAudio();
  if (current < 0) loadTrack(0);
  if (audio.ended || (isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.2)) {
    audio.currentTime = 0;
  }
  motorOn = true;
  setState('cueing'); // el brazo se levanta, viaja al surco y baja
}

function stop() {
  if (!ACTIVE.includes(state) && state !== 'dragging') return;
  motorOn = false;
  setState('lifting');
  audio.pause();
}

function togglePlay() {
  if (ACTIVE.includes(state)) stop();
  else play();
}

// Cambia de pista; si estaba sonando, el brazo vuelve a colocarse al inicio del nuevo surco
function selectTrack(i) {
  if (ACTIVE.includes(state)) {
    setState('cueing');
    audio.pause();
    loadTrack(i);
  } else {
    loadTrack(i);
  }
}

function next() {
  if (tracks.length) selectTrack((current + 1) % tracks.length);
}

function prev() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) {
    if (ACTIVE.includes(state)) {
      setState('cueing');
      audio.pause();
    }
    audio.currentTime = 0;
  } else {
    selectTrack((current - 1 + tracks.length) % tracks.length);
  }
}

function seekBy(sec) {
  if (current < 0 || !isFinite(audio.duration)) return;
  audio.currentTime = clamp(audio.currentTime + sec, 0, audio.duration - 0.1);
}

function startAudio() {
  setState('playing');
  audio.play().catch((err) => {
    console.warn('No se pudo reproducir:', err);
    stop();
  });
  renderPlaylist();
}

audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) {
    audio.currentTime = pendingSeek * audio.duration;
    pendingSeek = null;
  }
});

audio.addEventListener('ended', () => {
  if (current < tracks.length - 1) {
    // Siguiente pista: el brazo se levanta y vuelve al borde del disco
    setState('cueing');
    loadTrack(current + 1);
  } else {
    motorOn = false;
    setState('lifting');
    loadTrack(0);
  }
});

// Pausas externas (auriculares, teclas multimedia del sistema…)
audio.addEventListener('pause', () => {
  if (state === 'playing' && !audio.ended) {
    motorOn = false;
    setState('lifting');
  }
});

audio.addEventListener('error', () => {
  if (current < 0 || !audio.getAttribute('src')) return;
  $('nowArtist').textContent = 'No se puede reproducir este archivo';
  motorOn = false;
  if (state !== 'rest') setState('lifting');
});

// ---------- Bucle de animación ----------
let last = performance.now();

function moveArm(target, dt, k) {
  armAngle += (target - armAngle) * Math.min(1, dt * k);
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const elapsed = now - stateTime;

  // Plato: acelera y frena con inercia
  const targetSpeed = motorOn ? SPIN[rpm] : 0;
  platterSpeed += (targetSpeed - platterSpeed) * Math.min(1, dt * (motorOn ? 1.6 : 1.1));
  if (!motorOn && platterSpeed < 0.5) platterSpeed = 0;
  platterAngle = (platterAngle + platterSpeed * dt) % 360;
  vinyl.style.transform = `rotate(${platterAngle}deg)`;

  // Brazo
  switch (state) {
    case 'rest':
      moveArm(REST, dt, 3);
      break;
    case 'cueing': {
      const target = angleFor(progress());
      moveArm(target, dt, 3.5);
      if (elapsed > 350 && Math.abs(armAngle - target) < 0.2) setState('dropping');
      break;
    }
    case 'dropping':
      moveArm(angleFor(progress()), dt, 6);
      if (elapsed > 450) startAudio(); // la aguja toca el disco
      break;
    case 'playing':
      moveArm(angleFor(progress()), dt, 8);
      break;
    case 'lifting':
      if (elapsed > 350) setState('returning');
      break;
    case 'returning':
      moveArm(REST, dt, 3);
      if (Math.abs(armAngle - REST) < 0.1) {
        setState('rest');
        renderPlaylist();
      }
      break;
  }
  tonearm.style.transform = `rotate(${armAngle}deg)`;

  updateTimeUI();
  drawViz();
  requestAnimationFrame(frame);
}

let lastTimeText = '';
function updateTimeUI() {
  const dur = audio.duration;
  const p = dragPreview != null ? dragPreview : progress();
  const cur = dragPreview != null && isFinite(dur) ? dragPreview * dur : audio.currentTime;
  const text = `${fmt(cur)}|${fmt(dur)}`;
  if (text !== lastTimeText) {
    lastTimeText = text;
    $('timeCur').textContent = fmt(cur);
    $('timeDur').textContent = fmt(dur);
  }
  $('progressFill').style.width = `${p * 100}%`;
}

// ---------- Visualizador ----------
const BARS = 56;
const levels = new Float32Array(BARS);

function drawViz() {
  const dpr = window.devicePixelRatio || 1;
  const w = viz.clientWidth;
  const h = viz.clientHeight;
  if (viz.width !== Math.round(w * dpr) || viz.height !== Math.round(h * dpr)) {
    viz.width = Math.round(w * dpr);
    viz.height = Math.round(h * dpr);
  }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.clearRect(0, 0, w, h);

  const live = analyser && !audio.paused;
  if (live) analyser.getByteFrequencyData(freqData);
  const bins = freqData ? freqData.length : 0;

  const gap = 3;
  const bw = (w - gap * (BARS + 1)) / BARS;
  vctx.fillStyle = 'rgba(245, 245, 247, 0.28)';

  for (let i = 0; i < BARS; i++) {
    // Escala casi logarítmica: más barras para graves y medios
    const target = live ? freqData[Math.floor(Math.pow(i / BARS, 1.6) * bins * 0.85)] / 255 : 0;
    levels[i] += (target - levels[i]) * (target > levels[i] ? 0.5 : 0.12);
    const bh = Math.max(2, levels[i] * (h - 14));
    const x = gap + i * (bw + gap);
    const y = h - 7 - bh;
    vctx.beginPath();
    if (vctx.roundRect) vctx.roundRect(x, y, bw, bh, Math.min(2, bw / 2));
    else vctx.rect(x, y, bw, bh);
    vctx.fill();
  }
}

// ---------- Arrastrar la aguja ----------
function deckPoint(e) {
  const rect = deck.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
}

function dragTo(e) {
  const p = deckPoint(e);
  const deg = (Math.atan2(-(p.x - PIVOT.x), p.y - PIVOT.y) * 180) / Math.PI;
  armAngle = clamp(deg, REST, END);
  dragPreview = armAngle >= START - 1.5 && current >= 0 ? clamp((armAngle - START) / (END - START), 0, 1) : null;
}

tonearm.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  tonearm.setPointerCapture(e.pointerId);
  setState('dragging');
  audio.pause();
  dragTo(e);
});

tonearm.addEventListener('pointermove', (e) => {
  if (state === 'dragging') dragTo(e);
});

function endDrag() {
  if (state !== 'dragging') return;
  dragPreview = null;
  if (armAngle >= START - 1.5 && tracks.length) {
    // Aguja soltada sobre el disco: saltar a esa posición y sonar
    initAudio();
    if (current < 0) loadTrack(0);
    const p = clamp((armAngle - START) / (END - START), 0, 0.995);
    if (isFinite(audio.duration)) audio.currentTime = p * audio.duration;
    else pendingSeek = p;
    motorOn = true;
    setState('dropping');
  } else {
    motorOn = false;
    setState('returning');
  }
  renderPlaylist();
}

tonearm.addEventListener('pointerup', endDrag);
tonearm.addEventListener('pointercancel', endDrag);

// ---------- Volumen ----------
function setVolume(v) {
  volume = clamp(v, 0, 1);
  knob.style.transform = `rotate(${-135 + 270 * volume}deg)`;
  knob.title = `Volumen ${Math.round(volume * 100)} %`;
  if (gain) gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  saveSettings();
}

let knobDrag = null;
knob.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  knob.setPointerCapture(e.pointerId);
  knobDrag = { y: e.clientY, vol: volume };
});
knob.addEventListener('pointermove', (e) => {
  if (knobDrag) setVolume(knobDrag.vol + (knobDrag.y - e.clientY) / 150);
});
knob.addEventListener('pointerup', () => (knobDrag = null));
knob.addEventListener('pointercancel', () => (knobDrag = null));
knob.addEventListener('wheel', (e) => {
  e.preventDefault();
  setVolume(volume - Math.sign(e.deltaY) * 0.05);
}, { passive: false });

// ---------- Velocidad 33/45 ----------
function setRpm(r) {
  rpm = r === 45 ? 45 : 33;
  document.querySelectorAll('.speed-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.rpm) === rpm));
  document.querySelector('.label-side').textContent = rpm === 33 ? '33⅓ rpm' : '45 rpm';
  applyPitch();
  saveSettings();
}

document.querySelectorAll('.speed-btn').forEach((btn) => {
  btn.addEventListener('click', () => setRpm(Number(btn.dataset.rpm)));
});

// ---------- Botones, progreso, teclado ----------
$('startBtn').addEventListener('click', togglePlay);
playBtn.addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', next);
$('prevBtn').addEventListener('click', prev);

$('progress').addEventListener('click', (e) => {
  if (current < 0 || !isFinite(audio.duration)) return;
  const rect = e.currentTarget.getBoundingClientRect();
  audio.currentTime = clamp((e.clientX - rect.left) / rect.width, 0, 0.995) * audio.duration;
});

for (const id of ['fileInput', 'folderInput']) {
  $(id).addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight': seekBy(10); break;
    case 'ArrowLeft': seekBy(-10); break;
    case 'ArrowUp':
      e.preventDefault();
      setVolume(volume + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setVolume(volume - 0.05);
      break;
    case 'n': case 'N': next(); break;
    case 'p': case 'P': prev(); break;
  }
});

// Evita que el espacio "pulse" el botón enfocado además del atajo
document.querySelectorAll('button').forEach((b) => b.addEventListener('keydown', (e) => {
  if (e.key === ' ') e.preventDefault();
}));

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  try {
    ms.setActionHandler('play', play);
    ms.setActionHandler('pause', stop);
    ms.setActionHandler('nexttrack', next);
    ms.setActionHandler('previoustrack', prev);
  } catch { /* acción no soportada */ }
}

// ---------- Arrastrar archivos a la página ----------
let dragDepth = 0;
const overlay = $('dropOverlay');
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  overlay.classList.add('show');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.classList.remove('show');
});
window.addEventListener('dragover', (e) => e.preventDefault());
// Recorre carpetas (y subcarpetas) soltadas en la página
async function walkEntry(entry, path, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    dropPaths.set(file, path + file.name);
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do { // readEntries devuelve los resultados por lotes
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walkEntry(child, `${path}${entry.name}/`, out);
    } while (batch.length);
  }
}

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.remove('show');
  // Las entradas hay que obtenerlas antes del primer await
  const entries = [...e.dataTransfer.items]
    .map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
    .filter(Boolean);
  if (!entries.length) {
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    return;
  }
  const files = [];
  for (const entry of entries) await walkEntry(entry, '', files);
  addFiles(files);
});

// ---------- Escalado del tocadiscos ----------
new ResizeObserver(([entry]) => {
  scale = Math.min(1, entry.contentRect.width / DECK_W);
  deck.style.setProperty('--scale', scale);
  deckWrap.style.height = `${DECK_H * scale}px`;
}).observe(deckWrap);

// ---------- Restaurar la sesión anterior ----------
async function restore() {
  const s = loadSettings();
  if (s.rpm) setRpm(s.rpm);
  if (typeof s.volume === 'number') setVolume(s.volume);
  try {
    db = await openDb();
    const records = (await dbRun('readonly', (st) => st.getAll())) || [];
    const order = s.order || [];
    const rank = (id) => {
      const i = order.indexOf(id);
      return i < 0 ? order.length : i;
    };
    records.sort((a, b) => rank(a.id) - rank(b.id));
    tracks = records.map((r) => ({ ...r, url: URL.createObjectURL(r.file) }));
    tracks.filter((t) => !isFinite(t.duration)).forEach(probeDuration);
    if (tracks.length) {
      loadTrack(Math.max(0, tracks.findIndex((t) => t.id === s.currentId)));
      if (s.time > 0) {
        audio.addEventListener('loadedmetadata', () => {
          audio.currentTime = Math.min(s.time, audio.duration - 0.5);
        }, { once: true });
      }
    }
    // Pide al navegador que no borre estos datos si le falta espacio
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {
    console.warn('La playlist no se podrá guardar:', e);
    db = null;
  }
  restored = true;
  renderPlaylist();
}

// Guardar la posición de reproducción de vez en cuando y al salir
let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  if (performance.now() - lastSave > 5000) {
    lastSave = performance.now();
    saveSettings();
  }
});
window.addEventListener('pagehide', saveSettings);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveSettings();
});

setVolume(volume);
renderPlaylist();
updateButtons();
requestAnimationFrame(frame);
restore();
