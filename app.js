'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const A = window.Android || null;
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let PIN = LS.get('rp.pin', '');
const settings = Object.assign({ mode: 'pad', wheelMax: 900, autoCenter: true, bg: true, bgOpacity: .75, volUp: 'a', volDown: 'b',
  vib: true, sens: 1.6, q: 55, scale: .6, fps: 20, mon: 1, padQ: 45, padScale: .5, padFps: 30 }, LS.get('rp.settings', {}));
const cam = Object.assign({ front: false, res: '1280x720', fps: 30, q: 70 }, LS.get('rp.cam', {}));
const saveSettings = () => LS.set('rp.settings', settings);
const vib = () => { if (settings.vib && navigator.vibrate) navigator.vibrate(12); };
const srv = {};
let curTab = 'screen', padOpen = false, padEdit = false;

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- modal ----------
function openModal(html, mount) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); if (mount) mount($('#modalBody')); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });
function askConfirm(msg) {
  return new Promise(res => openModal(`<p>${esc(msg)}</p><div class="row"><button id="mNo">Cancelar</button><button id="mYes" class="primary">Confirmar</button></div>`, b => {
    $('#mNo', b).onclick = () => { closeModal(); res(false); }; $('#mYes', b).onclick = () => { closeModal(); res(true); };
  }));
}
function askText(title, val) {
  return new Promise(res => openModal(`<p>${esc(title)}</p><input id="mIn" value="${esc(val || '')}"><div class="row"><button id="mNo">Cancelar</button><button id="mYes" class="primary">OK</button></div>`, b => {
    const i = $('#mIn', b); i.focus(); $('#mNo', b).onclick = () => { closeModal(); res(null); }; $('#mYes', b).onclick = () => { closeModal(); res(i.value); };
  }));
}

// ---------- API / PIN ----------
async function api(path, opt = {}) {
  opt.headers = Object.assign({ 'X-Pin': PIN }, opt.headers || {});
  const r = await fetch(path, opt);
  if (r.status === 401) { showGate('PIN incorreto (ou bloqueado por 60 s)'); throw new Error('pin'); }
  return r;
}
const apiJson = async (path, body) => (await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
function showGate(msg) { $('#gate').classList.remove('hidden'); $('#gateMsg').textContent = msg || ''; $('#pinInput').value = ''; }
async function tryPin(p) {
  PIN = p;
  try {
    const r = await fetch('/api/info', { headers: { 'X-Pin': p } });
    if (r.status === 401) { showGate('PIN incorreto'); return; }
    LS.set('rp.pin', p); $('#gate').classList.add('hidden'); onAuthed(await r.json());
  } catch (e) { showGate('Servidor não responde'); }
}
$('#pinBtn').onclick = () => tryPin($('#pinInput').value.trim());
$('#pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pinBtn').click(); });

let wsStarted = false;
function onAuthed(inf) {
  Object.assign(srv, inf); $('#title').textContent = inf.host;
  if (!wsStarted) { wsStarted = true; connectWS(); }
  setTab(curTab); renderMore(); updateCamUI();
}

// ---------- WebSocket de controle ----------
let ws = null, wsOpen = false;
function connectWS() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?pin=' + encodeURIComponent(PIN));
  ws.onopen = () => { wsOpen = true; $('#dot').classList.add('on'); send({ t: 'mon', i: settings.mon }); };
  ws.onclose = () => { wsOpen = false; $('#dot').classList.remove('on'); setTimeout(connectWS, 1500); };
  ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'toast') toast(m.msg, 4000); } catch (_) {} };
}
const send = o => { if (wsOpen) ws.send(JSON.stringify(o)); };

// ---------- stream da tela ----------
const screenImg = $('#screenImg'), info = { w: 1920, h: 1080, monitors: 1, mon: 1 };
let sws = null, imgBusy = false, curUrl = null, shownUrl = null;
screenImg.onload = () => { if (shownUrl) URL.revokeObjectURL(shownUrl); shownUrl = curUrl; imgBusy = false; };
screenImg.onerror = () => { imgBusy = false; };
const screenCfg = () => padOpen ? { q: settings.padQ, scale: settings.padScale, fps: settings.padFps, mon: settings.mon }
  : { q: settings.q, scale: settings.scale, fps: settings.fps, mon: settings.mon };
const screenWanted = () => !document.hidden && ((padOpen && settings.bg) || (!padOpen && curTab === 'screen'));
function attachScreen(host) { if (screenImg.parentElement !== host) host.prepend(screenImg); }
function updateScreen() {
  if (!PIN || !wsStarted) return;
  if (screenWanted()) { if (!sws) startScreen(); else sendScreenCfg(); }
  else if (sws) { const s = sws; sws = null; s.onclose = null; s.close(); }
}
function sendScreenCfg() { if (sws && sws.readyState === 1) sws.send(JSON.stringify(Object.assign({ t: 'cfg' }, screenCfg()))); }
function startScreen() {
  const c = screenCfg();
  const s = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/screen?pin=' + encodeURIComponent(PIN) +
    `&q=${c.q}&scale=${c.scale}&fps=${c.fps}&mon=${c.mon}`);
  sws = s; s.binaryType = 'blob';
  s.onmessage = e => {
    if (typeof e.data === 'string') { try { const m = JSON.parse(e.data); if (m.t === 'info') Object.assign(info, m); } catch (_) {} return; }
    if (imgBusy) return;
    imgBusy = true; curUrl = URL.createObjectURL(e.data); screenImg.src = curUrl;
    setTimeout(() => { imgBusy = false; }, 1000);
  };
  s.onclose = () => { if (sws === s) { sws = null; setTimeout(updateScreen, 1500); } };
}
document.addEventListener('visibilitychange', updateScreen);

// ---------- abas ----------
function setTab(name) {
  if (name === 'pad') { openPad(); return; }
  curTab = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'screen') attachScreen($('#screenHost'));
  updateScreen();
  if (name === 'files' && !fsLoaded) loadDir('');
  if (name === 'shortcuts') loadShortcuts();
}
$$('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
let fsOn = false;
$('#btnFs').onclick = () => { fsOn = !fsOn; if (A) A.setFullscreen(fsOn); };
$('#btnExit').onclick = () => { if (A) A.disconnect(); else { LS.set('rp.pin', ''); PIN = ''; showGate(''); } };
$('#btnLogout').onclick = $('#btnExit').onclick;
window.onBackKey = () => {
  if (!$('#modal').classList.contains('hidden')) { closeModal(); return true; }
  if (padOpen) { closePad(); return true; }
  return false;
};

// ---------- touchpad / mouse ----------
let mouseMode = 'rel', pendX = 0, pendY = 0, pendAbs = null;
$('#btnMode').onclick = () => { mouseMode = mouseMode === 'rel' ? 'abs' : 'rel'; $('#btnMode').textContent = mouseMode === 'rel' ? 'Touchpad' : 'Toque direto'; };
setInterval(() => {
  const ix = Math.trunc(pendX), iy = Math.trunc(pendY);
  if (ix || iy) { send({ t: 'mm', dx: ix, dy: iy }); pendX -= ix; pendY -= iy; }
  if (pendAbs) { send(pendAbs); pendAbs = null; }
}, 16);
$$('.hold').forEach(b => {
  const up = () => { if (b._d) { b._d = false; send({ t: 'mb', b: b.dataset.b, d: 0 }); } };
  b.addEventListener('pointerdown', e => { b._d = true; b.setPointerCapture(e.pointerId); send({ t: 'mb', b: b.dataset.b, d: 1 }); });
  b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
});
(function touchpad() {
  const host = $('#screenHost');
  let st = null, lp = null, dragging = false, scrollAcc = 0;
  function abs(c) {
    const r = host.getBoundingClientRect(), ar = info.w / info.h;
    let w = r.width, h = r.height, ox = 0, oy = 0;
    if (w / h > ar) { const nw = h * ar; ox = (w - nw) / 2; w = nw; } else { const nh = w / ar; oy = (h - nh) / 2; h = nh; }
    const fx = (c.clientX - r.left - ox) / w, fy = (c.clientY - r.top - oy) / h;
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) pendAbs = { t: 'ma', x: fx, y: fy };
  }
  host.addEventListener('touchstart', e => {
    e.preventDefault(); const t = e.touches;
    if (t.length === 1) {
      st = { x: t[0].clientX, y: t[0].clientY, lx: t[0].clientX, ly: t[0].clientY, t: Date.now(), moved: false, two: false };
      if (mouseMode === 'abs') abs(t[0]);
      clearTimeout(lp);
      lp = setTimeout(() => { if (st && !st.moved && !st.two) { dragging = true; send({ t: 'mb', b: 'left', d: 1 }); vib(); } }, 450);
    } else if (t.length === 2 && st) {
      clearTimeout(lp); st.two = true; st.twoT = Date.now(); st.sy = st.ly2 = (t[0].clientY + t[1].clientY) / 2; st.twoMoved = false;
    }
  }, { passive: false });
  host.addEventListener('touchmove', e => {
    e.preventDefault(); if (!st) return; const t = e.touches;
    if (t.length >= 2) {
      const y = (t[0].clientY + t[1].clientY) / 2; scrollAcc += y - st.ly2; st.ly2 = y;
      if (Math.abs(y - st.sy) > 6) st.twoMoved = true;
      const n = Math.trunc(scrollAcc / 12);
      if (n) { send({ t: 'sc', dx: 0, dy: n }); scrollAcc -= n * 12; }
    } else if (!st.two) {
      const c = t[0], dx = c.clientX - st.lx, dy = c.clientY - st.ly; st.lx = c.clientX; st.ly = c.clientY;
      if (!st.moved && Math.hypot(c.clientX - st.x, c.clientY - st.y) > 8) { st.moved = true; clearTimeout(lp); }
      if (mouseMode === 'abs') abs(c);
      else if (st.moved || dragging) { pendX += dx * settings.sens; pendY += dy * settings.sens; }
    }
  }, { passive: false });
  host.addEventListener('touchend', e => {
    e.preventDefault(); if (e.touches.length > 0 || !st) return;
    clearTimeout(lp);
    if (dragging) { dragging = false; send({ t: 'mb', b: 'left', d: 0 }); }
    else if (st.two) { if (!st.twoMoved && Date.now() - st.twoT < 300) send({ t: 'mc', b: 'right' }); }
    else if (!st.moved && Date.now() - st.t < 300) send({ t: 'mc', b: 'left' });
    st = null; scrollAcc = 0;
  }, { passive: false });
})();

// ---------- teclado ----------
const KEYROWS = [
  [['Esc', 'esc'], ['Tab', 'tab'], ['Ctrl', 'ctrl', 1], ['Alt', 'alt', 1], ['Shift', 'shift', 1], ['Win', 'win', 1], ['Del', 'delete'], ['⌫', 'backspace']],
  [['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right'], ['Home', 'home'], ['End', 'end'], ['PgUp', 'pageup'], ['PgDn', 'pagedown']],
  [['Ctrl+C', ['ctrl', 'c']], ['Ctrl+V', ['ctrl', 'v']], ['Ctrl+A', ['ctrl', 'a']], ['Ctrl+Z', ['ctrl', 'z']], ['Alt+Tab', ['alt', 'tab']], ['Win+D', ['win', 'd']], ['Alt+F4', ['alt', 'f4']]],
  Array.from({ length: 12 }, (_, i) => ['F' + (i + 1), 'f' + (i + 1)])
];
const mods = new Set();
KEYROWS.flat().forEach(([label, key, isMod]) => {
  const b = document.createElement('button'); b.textContent = label;
  b.onclick = () => {
    if (isMod) { mods.has(key) ? mods.delete(key) : mods.add(key); b.classList.toggle('on'); return; }
    send({ t: 'hk', keys: [...mods, ...(Array.isArray(key) ? key : [key])] });
    mods.clear(); $$('#kbKeys .on').forEach(x => x.classList.remove('on'));
  };
  $('#kbKeys').appendChild(b);
});
$('#btnKb').onclick = () => $('#kbPanel').classList.toggle('hidden');
$('#kbSend').onclick = () => { const v = $('#kbText').value; if (v) { send({ t: 'txt', s: v }); $('#kbText').value = ''; } };
$('#kbEnter').onclick = () => { $('#kbSend').click(); send({ t: 'tap', k: 'enter' }); };

// ---------- atalhos ----------
const SC_TYPES = { hotkey: ['Combinação de teclas', 'ctrl+shift+esc'], text: ['Digitar texto', 'texto'], open: ['Abrir programa/arquivo', 'C:\\Windows\\notepad.exe'],
  url: ['Abrir site', 'https://'], cmd: ['Comando (cmd)', 'ipconfig'], media: ['Mídia', ''], power: ['Energia', ''] };
const SC_OPTS = { media: ['playpause', 'next', 'prev', 'volup', 'voldown', 'mute'], power: ['lock', 'sleep', 'shutdown', 'restart', 'cancel'] };
let shortcuts = [], scEdit = false;
async function loadShortcuts() { try { shortcuts = await (await api('/api/shortcuts')).json(); renderShortcuts(); } catch (e) {} }
function renderShortcuts() {
  const g = $('#scGrid'); g.innerHTML = '';
  shortcuts.forEach(sc => {
    const b = document.createElement('button'); b.className = 'sc';
    b.innerHTML = `<span class="ic">${esc(sc.icon || '⚡')}</span><span>${esc(sc.label)}</span>`;
    b.onclick = () => {
      if (scEdit) return editShortcut(sc);
      send({ t: 'sh', id: sc.id }); vib(); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 200);
    };
    g.appendChild(b);
  });
}
$('#scEditBtn').onclick = () => { scEdit = !scEdit; $('#scEditBtn').classList.toggle('on', scEdit); $('#scAdd').classList.toggle('hidden', !scEdit); };
$('#scAdd').onclick = () => editShortcut(null);
const saveShortcuts = async () => { await apiJson('/api/shortcuts', shortcuts); renderShortcuts(); };
function editShortcut(sc) {
  const isNew = !sc; sc = sc || { id: Date.now().toString(36), label: '', icon: '⚡', type: 'hotkey', value: '' };
  const types = Object.entries(SC_TYPES).map(([k, v]) => `<option value="${k}"${k === sc.type ? ' selected' : ''}>${v[0]}</option>`).join('');
  openModal(`<h3>${isNew ? 'Novo atalho' : 'Editar atalho'}</h3><div class="col"><input id="seIcon" maxlength="4" value="${esc(sc.icon)}"><input id="seLabel" placeholder="Nome" value="${esc(sc.label)}"><select id="seType">${types}</select><div id="seWrap"></div><div class="row">${isNew ? '' : '<button id="seDel">Excluir</button>'}<button id="seSave" class="primary">Salvar</button></div></div>`, b => {
    const wrap = $('#seWrap', b), sel = $('#seType', b);
    const draw = keep => {
      const t = sel.value, cur = keep ? sc.value : '';
      wrap.innerHTML = SC_OPTS[t] ? '<select id="seVal">' + SC_OPTS[t].map(o => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join('') + '</select>'
        : `<input id="seVal" placeholder="${esc(SC_TYPES[t][1])}" value="${esc(cur)}">`;
    };
    draw(true); sel.onchange = () => draw(false);
    $('#seSave', b).onclick = async () => {
      const n = { id: sc.id, icon: $('#seIcon', b).value || '⚡', label: $('#seLabel', b).value || 'Atalho', type: sel.value, value: $('#seVal', b).value };
      const i = shortcuts.findIndex(s => s.id === sc.id); if (i >= 0) shortcuts[i] = n; else shortcuts.push(n);
      closeModal(); await saveShortcuts();
    };
    const d = $('#seDel', b); if (d) d.onclick = async () => { shortcuts = shortcuts.filter(s => s.id !== sc.id); closeModal(); await saveShortcuts(); };
  });
}

// ---------- arquivos ----------
let cwd = '', fsParent = '', fsLoaded = false;
const fmtSize = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
function joinPath(base, name) { if (!base) return name; const sep = base.includes('\\') ? '\\' : '/'; return base.endsWith(sep) ? base + name : base + sep + name; }
async function loadDir(p) {
  try {
    const d = await (await api('/api/fs/list?path=' + encodeURIComponent(p))).json();
    if (d.error) return toast(d.error);
    cwd = d.path; fsParent = d.parent; fsLoaded = true;
    $('#fsPath').textContent = d.path || 'Este computador';
    const l = $('#fsList'); l.innerHTML = '';
    d.items.forEach(it => {
      const full = joinPath(d.path, it.name), row = document.createElement('div'); row.className = 'fsrow';
      row.innerHTML = `<span class="fi">${it.dir ? '📁' : '📄'}</span><span class="fn">${esc(it.name)}</span><span class="fs">${it.dir ? '' : fmtSize(it.size)}</span><button class="mini">⋮</button>`;
      row.querySelector('.fn').onclick = row.querySelector('.fi').onclick = () => it.dir ? loadDir(full) : fileMenu(full, it);
      row.querySelector('button').onclick = () => fileMenu(full, it);
      l.appendChild(row);
    });
  } catch (e) { if (e.message !== 'pin') toast('Erro ao listar'); }
}
async function fsOp(body) { try { const d = await apiJson('/api/fs/op', body); if (d.error) toast(d.error); else if (body.op === 'open') toast('Aberto no PC'); } catch (e) {} }
function download(full) {
  const a = document.createElement('a'); a.href = '/api/fs/download?path=' + encodeURIComponent(full) + '&pin=' + encodeURIComponent(PIN); a.download = '';
  document.body.appendChild(a); a.click(); a.remove(); toast('Iniciando download…');
}
function fileMenu(full, it) {
  openModal(`<h3>${esc(it.name)}</h3><div class="col">${it.dir ? '' : '<button id="fmDl">⬇️ Baixar no celular</button>'}<button id="fmOpen">🖥️ Abrir no PC</button><button id="fmRen">✏️ Renomear</button><button id="fmDel">🗑️ Excluir</button></div>`, b => {
    const dl = $('#fmDl', b); if (dl) dl.onclick = () => { closeModal(); download(full); };
    $('#fmOpen', b).onclick = async () => { closeModal(); await fsOp({ op: 'open', path: full }); };
    $('#fmRen', b).onclick = async () => { closeModal(); const n = await askText('Novo nome', it.name); if (n && n !== it.name) { await fsOp({ op: 'rename', path: full, new: n }); loadDir(cwd); } };
    $('#fmDel', b).onclick = async () => { closeModal(); if (await askConfirm('Excluir "' + it.name + '"?')) { await fsOp({ op: 'delete', path: full }); loadDir(cwd); } };
  });
}
$('#fsUp').onclick = () => { if (cwd) loadDir(fsParent || ''); };
$('#fsRoot').onclick = () => loadDir('');
$('#fsNew').onclick = async () => { if (!cwd) return toast('Entre numa pasta primeiro'); const n = await askText('Nome da nova pasta', ''); if (n) { await fsOp({ op: 'mkdir', path: joinPath(cwd, n) }); loadDir(cwd); } };
$('#fsUpload').onclick = () => { if (!cwd) return toast('Entre numa pasta primeiro'); $('#fsFile').click(); };
$('#fsFile').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    await new Promise(res => {
      const fd = new FormData(); fd.append('file', f, f.name);
      const x = new XMLHttpRequest(); x.open('POST', '/api/fs/upload?path=' + encodeURIComponent(cwd)); x.setRequestHeader('X-Pin', PIN);
      x.upload.onprogress = ev => { if (ev.lengthComputable) toast(`Enviando ${f.name} ${Math.round(ev.loaded / ev.total * 100)}%`, 4000); };
      x.onload = () => { toast('Enviado: ' + f.name); res(); }; x.onerror = () => { toast('Falha ao enviar'); res(); };
      x.send(fd);
    });
  }
  loadDir(cwd);
};

// ---------- webcam ----------
let camOn = false;
function updateCamUI() {
  $('#camFacing').value = cam.front ? 'front' : 'back'; $('#camRes').value = cam.res; $('#camFps').value = String(cam.fps); $('#camQ').value = cam.q;
  $('#camStart').textContent = camOn ? 'Parar webcam' : 'Iniciar webcam';
  $('#camWarn').textContent = !A ? 'Disponível apenas no app (APK).' : (srv.vcam === false ? 'Servidor sem câmera virtual: instale o OBS Studio e reinicie o servidor.' : '');
}
['camFacing', 'camRes', 'camFps', 'camQ'].forEach(id => $('#' + id).onchange = () => {
  cam.front = $('#camFacing').value === 'front'; cam.res = $('#camRes').value; cam.fps = +$('#camFps').value; cam.q = +$('#camQ').value; LS.set('rp.cam', cam);
});
$('#camStart').onclick = () => {
  if (!A) return toast('Disponível apenas no app (APK)');
  if (camOn) { A.stopCamera(); camOn = false; $('#camStatus').textContent = 'Parado'; }
  else {
    const [w, h] = cam.res.split('x').map(Number);
    A.startCamera((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/cam?pin=' + encodeURIComponent(PIN), cam.front, w, h, cam.fps, cam.q);
    camOn = true;
  }
  updateCamUI();
};
window.onCamStatus = msg => { $('#camStatus').textContent = msg; if (/Falha|Erro|negada|encerrada|PC:/i.test(msg)) { camOn = false; updateCamUI(); } };

// ---------- aba Mais ----------
function renderMore() {
  const sel = $('#optMon'); sel.innerHTML = '<option value="0">Todos os monitores</option>';
  for (let i = 1; i <= Math.max(1, srv.monitors || 1); i++) sel.innerHTML += `<option value="${i}">Monitor ${i}</option>`;
  sel.value = settings.mon; sel.onchange = () => { settings.mon = +sel.value; saveSettings(); send({ t: 'mon', i: settings.mon }); sendScreenCfg(); };
  const bind = (id, key, mul, vid, fmt) => {
    const el = $('#' + id), lab = $('#' + vid), show = () => { lab.textContent = fmt(settings[key]); };
    el.value = settings[key] * mul; show();
    el.oninput = () => { settings[key] = el.value / mul; saveSettings(); show(); sendScreenCfg(); };
  };
  bind('optQ', 'q', 1, 'vQ', v => v + '%'); bind('optScale', 'scale', 100, 'vScale', v => Math.round(v * 100) + '%');
  bind('optFps', 'fps', 1, 'vFps', v => v); bind('optSens', 'sens', 10, 'vSens', v => v.toFixed(1) + 'x');
  $('#srvInfo').innerHTML = `${esc(srv.host || '')}<br>${esc(srv.os || '')}<br>IP: ${(srv.ips || []).map(esc).join(', ')}:${srv.port}<br>Gamepad virtual: ${srv.vg ? 'ok' : 'sem ViGEmBus'} · Webcam virtual: ${srv.vcam ? 'ok' : 'sem OBS'}`;
}
$$('[data-k]').forEach(b => b.onclick = () => send({ t: 'tap', k: b.dataset.k }));
$$('[data-pw]').forEach(b => b.onclick = async () => {
  const a = b.dataset.pw;
  if (a !== 'cancel' && a !== 'lock' && !(await askConfirm('Confirmar: ' + b.textContent + ' o PC?'))) return;
  try { const d = await apiJson('/api/power', { a }); if (d.error) toast(d.error); else toast('Comando enviado'); } catch (e) {}
});

// ---------- gamepad / volante ----------
const gp = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 }, held = new Set();
let gpDirty = false, wheelDeg = 0;
function setAxis(k, v) { v = Math.round(v * 1000) / 1000; if (gp[k] !== v) { gp[k] = v; gpDirty = true; } }
setInterval(() => { if (gpDirty) { send(Object.assign({ t: 'gps' }, gp)); gpDirty = false; } }, 10);
function gpb(b, d) {
  if (d) held.add(b); else held.delete(b);
  if (b === 'lt' || b === 'rt') { setAxis(b, d ? 1 : 0); if (d) vib(); return; }
  send({ t: 'gpb', b, d: d ? 1 : 0 }); if (d) vib();
}
const tapBtn = b => { gpb(b, 1); setTimeout(() => gpb(b, 0), 60); };
function releaseAll() { [...held].forEach(b => gpb(b, 0)); Object.keys(gp).forEach(k => setAxis(k, 0)); }

const PAD_DEFS = {
  pad: [
    { id: 'ls', type: 'stick', x: 14, y: 68, s: 1, ax: ['lx', 'ly'], click: 'l3' }, { id: 'rs', type: 'stick', x: 74, y: 68, s: 1, ax: ['rx', 'ry'], click: 'r3' },
    { id: 'dpad', type: 'dpad', x: 14, y: 30, s: 1 }, { id: 'abxy', type: 'abxy', x: 88, y: 32, s: 1 },
    { id: 'lb', type: 'btn', b: 'lb', label: 'LB', x: 7, y: 8, s: 1 }, { id: 'lt', type: 'btn', b: 'lt', label: 'LT', x: 20, y: 8, s: 1 },
    { id: 'rb', type: 'btn', b: 'rb', label: 'RB', x: 93, y: 8, s: 1 }, { id: 'rt', type: 'btn', b: 'rt', label: 'RT', x: 80, y: 8, s: 1 },
    { id: 'back', type: 'btn', b: 'back', label: '⧉', x: 42, y: 12, s: .8 }, { id: 'start', type: 'btn', b: 'start', label: '☰', x: 58, y: 12, s: .8 }],
  wheel: [
    { id: 'wheel', type: 'wheel', x: 24, y: 56, s: 1.3 }, { id: 'brake', type: 'pedal', t: 'lt', label: 'FREIO', x: 62, y: 62, s: 1 },
    { id: 'gas', type: 'pedal', t: 'rt', label: 'ACEL', x: 78, y: 62, s: 1 }, { id: 'abxy', type: 'abxy', x: 90, y: 26, s: .8 },
    { id: 'dpad', type: 'dpad', x: 52, y: 26, s: .7 }, { id: 'lb', type: 'btn', b: 'lb', label: 'LB', x: 7, y: 8, s: 1 },
    { id: 'rb', type: 'btn', b: 'rb', label: 'RB', x: 93, y: 8, s: 1 },
    { id: 'back', type: 'btn', b: 'back', label: '⧉', x: 40, y: 8, s: .7 }, { id: 'start', type: 'btn', b: 'start', label: '☰', x: 60, y: 8, s: .7 }]
};
let layouts = LS.get('rp.layout', { pad: {}, wheel: {} });
layouts.pad = layouts.pad || {}; layouts.wheel = layouts.wheel || {};
const saveLayout = () => LS.set('rp.layout', layouts);
const getL = def => Object.assign({}, def, layouts[settings.mode][def.id] || {});
function setL(id, o) { layouts[settings.mode][id] = Object.assign(layouts[settings.mode][id] || {}, o); }

function holdBtn(el, onDown, onUp) {
  let pid = null;
  el.addEventListener('pointerdown', e => { if (padEdit || pid !== null) return; pid = e.pointerId; el.setPointerCapture(pid); el.classList.add('down'); onDown(); e.preventDefault(); });
  const up = e => { if (e.pointerId !== pid) return; pid = null; el.classList.remove('down'); onUp(); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function buildControl(el, L) {
  if (L.type === 'stick') {
    el.innerHTML = '<div class="knob"></div>'; const knob = el.firstChild;
    let pid = null, cx = 0, cy = 0, r = 1, t0 = 0, mv = 0;
    const upd = e => {
      let dx = e.clientX - cx, dy = e.clientY - cy; const d = Math.hypot(dx, dy); mv = Math.max(mv, d);
      if (d > r) { dx *= r / d; dy *= r / d; }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      setAxis(L.ax[0], dx / r); setAxis(L.ax[1], -dy / r);
    };
    el.addEventListener('pointerdown', e => {
      if (padEdit || pid !== null) return; pid = e.pointerId; el.setPointerCapture(pid);
      const b = el.getBoundingClientRect(); cx = b.left + b.width / 2; cy = b.top + b.height / 2; r = b.width / 2; t0 = Date.now(); mv = 0; upd(e); e.preventDefault();
    });
    el.addEventListener('pointermove', e => { if (e.pointerId === pid) upd(e); });
    const end = e => {
      if (e.pointerId !== pid) return; pid = null; knob.style.transform = 'translate(-50%,-50%)'; setAxis(L.ax[0], 0); setAxis(L.ax[1], 0);
      if (L.click && Date.now() - t0 < 180 && mv < 10) tapBtn(L.click);
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  } else if (L.type === 'btn') {
    el.textContent = L.label; holdBtn(el, () => gpb(L.b, 1), () => gpb(L.b, 0));
  } else if (L.type === 'dpad') {
    [['up', '▲', 'up'], ['down', '▼', 'down_'], ['left', '◀', 'left'], ['right', '▶', 'right']].forEach(([b, ch, cls]) => {
      const c = document.createElement('div'); c.className = 'dp ' + cls; c.textContent = ch; el.appendChild(c); holdBtn(c, () => gpb(b, 1), () => gpb(b, 0));
    });
  } else if (L.type === 'abxy') {
    ['y', 'a', 'x', 'b'].forEach(b => { const c = document.createElement('div'); c.className = 'fb ' + b; c.textContent = b.toUpperCase(); el.appendChild(c); holdBtn(c, () => gpb(b, 1), () => gpb(b, 0)); });
  } else if (L.type === 'pedal') {
    el.innerHTML = `<div class="fill"></div><span>${L.label}</span>`; const fill = el.firstChild; let pid = null;
    const set = e => { const b = el.getBoundingClientRect(), v = Math.max(0, Math.min(1, 1 - (e.clientY - b.top) / b.height)); fill.style.height = v * 100 + '%'; setAxis(L.t, v); };
    el.addEventListener('pointerdown', e => { if (padEdit || pid !== null) return; pid = e.pointerId; el.setPointerCapture(pid); set(e); e.preventDefault(); });
    el.addEventListener('pointermove', e => { if (e.pointerId === pid) set(e); });
    const end = e => { if (e.pointerId !== pid) return; pid = null; fill.style.height = '0'; setAxis(L.t, 0); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  } else if (L.type === 'wheel') {
    el.innerHTML = '<div class="wheelImg"><i class="h"></i><i class="v"></i><b></b></div><div class="deg">0°</div>';
    const img = el.firstChild, degEl = el.lastChild; let pid = null, last = 0, cx = 0, cy = 0, anim = 0;
    const apply = () => {
      const half = settings.wheelMax / 2; wheelDeg = Math.max(-half, Math.min(half, wheelDeg));
      img.style.transform = `rotate(${wheelDeg}deg)`; degEl.textContent = Math.round(wheelDeg) + '°'; setAxis('lx', wheelDeg / half);
    };
    const ang = e => Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    const recenter = () => { wheelDeg *= .85; if (Math.abs(wheelDeg) < .5) wheelDeg = 0; apply(); if (wheelDeg !== 0) anim = requestAnimationFrame(recenter); };
    el.addEventListener('pointerdown', e => {
      if (padEdit || pid !== null) return; cancelAnimationFrame(anim); pid = e.pointerId; el.setPointerCapture(pid);
      const b = el.getBoundingClientRect(); cx = b.left + b.width / 2; cy = b.top + b.height / 2; last = ang(e); e.preventDefault();
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerId !== pid) return; const a = ang(e); let d = a - last; if (d > 180) d -= 360; if (d < -180) d += 360; last = a; wheelDeg += d; apply();
    });
    const end = e => { if (e.pointerId !== pid) return; pid = null; if (settings.autoCenter) recenter(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    apply();
  }
}
function renderPad() {
  const host = $('#padControls'); host.innerHTML = ''; releaseAll(); wheelDeg = 0;
  PAD_DEFS[settings.mode].forEach(def => {
    const L = getL(def); if (L.h && !padEdit) return;
    const el = document.createElement('div'); el.className = 'ctl ' + def.type + (L.h ? ' hidden-ctl' : ''); el.dataset.id = def.id;
    el.style.left = L.x + '%'; el.style.top = L.y + '%'; el.style.setProperty('--s', L.s);
    buildControl(el, L); host.appendChild(el);
    el.addEventListener('pointerdown', e => { if (padEdit) editDown(e, el, def); });
  });
  $('#padModeBtn').textContent = settings.mode === 'pad' ? '🎡' : '🎮';
}
let selDef = null;
function selectCtl(el, def) {
  selDef = def; $$('#padControls .ctl').forEach(c => c.classList.toggle('sel', c === el));
  const L = getL(def); $('#peName').textContent = def.id; $('#peSize').value = L.s * 100; $('#peHide').textContent = L.h ? 'Mostrar' : 'Ocultar';
}
function editDown(e, el, def) {
  e.preventDefault(); selectCtl(el, def); el.setPointerCapture(e.pointerId);
  const hb = $('#padControls').getBoundingClientRect();
  const mv = ev => {
    const x = Math.max(0, Math.min(100, (ev.clientX - hb.left) / hb.width * 100)), y = Math.max(0, Math.min(100, (ev.clientY - hb.top) / hb.height * 100));
    el.style.left = x + '%'; el.style.top = y + '%'; setL(def.id, { x: +x.toFixed(1), y: +y.toFixed(1) });
  };
  const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); saveLayout(); };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function setEdit(on) {
  padEdit = on; $('#pad').classList.toggle('editing', on); $('#padEditBar').classList.toggle('hidden', !on); selDef = null; $('#peName').textContent = 'Toque num controle'; renderPad();
}
$('#padEditBtn').onclick = () => setEdit(!padEdit);
$('#peDone').onclick = () => setEdit(false);
$('#peSize').oninput = e => { if (!selDef) return; const s = e.target.value / 100; setL(selDef.id, { s }); $(`#padControls [data-id="${selDef.id}"]`).style.setProperty('--s', s); saveLayout(); };
$('#peHide').onclick = () => { if (!selDef) return; const h = !getL(selDef).h; setL(selDef.id, { h }); saveLayout(); const d = selDef; renderPad(); selectCtl($(`#padControls [data-id="${d.id}"]`), d); };
$('#peReset').onclick = async () => { if (await askConfirm('Resetar o layout deste modo?')) { layouts[settings.mode] = {}; saveLayout(); renderPad(); } };
$('#padModeBtn').onclick = () => { settings.mode = settings.mode === 'pad' ? 'wheel' : 'pad'; saveSettings(); setEdit(false); };
$('#padBgBtn').onclick = () => { settings.bg = !settings.bg; saveSettings(); applyPadBg(); };
$('#padExit').onclick = () => closePad();
function applyPadBg() { const h = $('#padScreenHost'); h.style.display = settings.bg ? 'block' : 'none'; h.style.opacity = settings.bgOpacity; updateScreen(); }
function openPad() {
  padOpen = true; $('#pad').classList.remove('hidden');
  if (A) { A.setOrientation('landscape'); A.setFullscreen(true); A.setInterceptVolume(true); A.setKeepScreenOn(true); }
  attachScreen($('#padScreenHost')); applyPadBg(); renderPad();
}
function closePad() {
  setEdit(false); padOpen = false; releaseAll(); $('#pad').classList.add('hidden');
  if (A) { A.setOrientation('auto'); A.setFullscreen(false); A.setInterceptVolume(false); A.setKeepScreenOn(false); }
  attachScreen($('#screenHost')); updateScreen();
}
window.onHardwareKey = (k, down) => {
  if (!padOpen || padEdit) return;
  const m = k === 'volup' ? settings.volUp : settings.volDown;
  if (m && m !== 'none') gpb(m, down);
};

// configurações do gamepad
$('#padCfgBtn').onclick = () => {
  const keys = ['none', 'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'start', 'back', 'l3', 'r3', 'up', 'down', 'left', 'right'];
  const opt = cur => keys.map(k => `<option${k === cur ? ' selected' : ''}>${k}</option>`).join('');
  openModal(`<h3>Configurações</h3><div class="col">
    <label class="fld"><span>Graus do volante (total): <b id="cWv">${settings.wheelMax}°</b></span><input id="cW" type="range" min="90" max="1800" step="10" value="${settings.wheelMax}"></label>
    <label class="fld"><span><input id="cAC" type="checkbox" ${settings.autoCenter ? 'checked' : ''} style="width:auto"> Volante volta ao centro ao soltar</span></label>
    <label class="fld"><span><input id="cBg" type="checkbox" ${settings.bg ? 'checked' : ''} style="width:auto"> Mostrar a tela do PC ao fundo</span></label>
    <label class="fld"><span>Opacidade da tela</span><input id="cOp" type="range" min="10" max="100" value="${settings.bgOpacity * 100}"></label>
    <label class="fld"><span>Tamanho da imagem: <b id="cSv">${Math.round(settings.padScale * 100)}%</b></span><input id="cSc" type="range" min="25" max="100" value="${settings.padScale * 100}"></label>
    <label class="fld"><span>FPS da imagem: <b id="cFv">${settings.padFps}</b></span><input id="cFp" type="range" min="10" max="60" value="${settings.padFps}"></label>
    <label class="fld"><span>Botão Volume +</span><select id="cVu">${opt(settings.volUp)}</select></label>
    <label class="fld"><span>Botão Volume −</span><select id="cVd">${opt(settings.volDown)}</select></label>
    <label class="fld"><span><input id="cVb" type="checkbox" ${settings.vib ? 'checked' : ''} style="width:auto"> Vibrar ao tocar</span></label>
    <button id="cOk" class="primary">Fechar</button></div>`, b => {
    $('#cW', b).oninput = e => { settings.wheelMax = +e.target.value; $('#cWv', b).textContent = settings.wheelMax + '°'; };
    $('#cAC', b).onchange = e => settings.autoCenter = e.target.checked;
    $('#cBg', b).onchange = e => { settings.bg = e.target.checked; applyPadBg(); };
    $('#cOp', b).oninput = e => { settings.bgOpacity = e.target.value / 100; applyPadBg(); };
    $('#cSc', b).oninput = e => { settings.padScale = e.target.value / 100; $('#cSv', b).textContent = e.target.value + '%'; sendScreenCfg(); };
    $('#cFp', b).oninput = e => { settings.padFps = +e.target.value; $('#cFv', b).textContent = e.target.value; sendScreenCfg(); };
    $('#cVu', b).onchange = e => settings.volUp = e.target.value;
    $('#cVd', b).onchange = e => settings.volDown = e.target.value;
    $('#cVb', b).onchange = e => settings.vib = e.target.checked;
    $('#cOk', b).onclick = () => { saveSettings(); closeModal(); };
  });
};

// ---------- início ----------
if (PIN) tryPin(PIN); else showGate('');
