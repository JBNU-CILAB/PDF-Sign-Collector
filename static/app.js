/* PDF 서명 – 클라이언트 (pdf.js 렌더링 + pdf-lib 합성) */
'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
const { PDFDocument, degrees } = PDFLib;

// PDF 는 항상 이 함수로 연다. isEvalSupported:false 는 CVE-2024-4367 (조작된 PDF 의 글꼴 정보로
// 임의 JS 실행, pdf.js < 4.2.67) 차단 – 다른 사람이 저장한 PDF 를 그대로 열기 때문에 필수.
function openPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

const $ = (id) => document.getElementById(id);
const state = {
  docId: null,          // Server Document ID (it will be local mode if null)
  name: 'document.pdf',
  version: 0,
  bytes: null,          // Present PDF (Uint8Array)
  pdf: null,            // Present pdf.js Document
  pages: [],            // [{el, aspect, page}]
  zoom: 1,              // 1 = Fit into screen width (최대 900px)
  placements: [],       // [{id, page, x, y, w, h, ratio, sig}]  x,y,w,h = Ratio relative to page
  sigs: [],             // [{id, url, w, h}]
  placingSig: null,
  selected: null,
};
let uid = 0;
let config = { publicUrl: '', canUpload: true, canManage: false };   // /api/config

// 공유 링크의 기준 주소: localhost 로 열었으면 서버가 알려준 외부 주소 사용
function shareOrigin() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return (local && config.publicUrl) || location.origin;
}

/* ---------- 공통 ---------- */
function banner(msg, kind = '', ms = 0) {
  const b = $('banner');
  b.textContent = msg; b.className = kind; b.hidden = !msg;
  clearTimeout(banner.t);
  if (ms) banner.t = setTimeout(() => (b.hidden = true), ms);
}
function fmtTime(t) { return new Date(t * 1000).toLocaleString(); }
function updateButtons() {
  $('saveBtn').disabled = !state.bytes || state.placements.length === 0;
  $('downloadBtn').disabled = !state.bytes;
}
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let err; try { err = (await r.json()).error; } catch { err = r.statusText; }
    const e = new Error(err || ('HTTP ' + r.status)); e.status = r.status; throw e;
  }
  return r;
}

/* ---------- 문서 열기 ---------- */
async function openLocalFile(file) {
  if (!file) return;
  if (state.placements.length && !confirm('저장하지 않은 서명이 있습니다. 새 문서를 열까요?')) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.name = file.name;
  try {
    const r = await api('/api/docs', {
      method: 'POST', body: bytes,
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) },
    });
    const meta = await r.json();
    history.pushState(null, '', '/d/' + meta.id);
    await loadShared(meta.id);
  } catch (e) {
    // 서버가 없거나 실패 → 로컬 전용 모드
    state.docId = null; state.version = 0;
    $('shareBar').hidden = true; $('replaceBtn').hidden = true;
    renderHistory(null);
    await showPdf(bytes);
    banner(e.status === 403
      ? '새 문서 공유는 서버 컴퓨터에서만 할 수 있어 로컬 모드로 열었습니다. (서명 후 다운로드만 가능)'
      : '공유 서버에 연결할 수 없어 로컬 모드로 열었습니다 (' + e.message + '). 저장 후 다운로드하세요.', 'err');
  }
}

async function loadShared(id) {
  const meta = await (await api('/api/docs/' + id)).json();
  const r = await api('/api/docs/' + id + '/pdf');
  const bytes = new Uint8Array(await r.arrayBuffer());
  state.docId = id; state.name = meta.name; state.version = meta.version;
  $('shareBar').hidden = false;
  $('replaceBtn').hidden = !config.canUpload;
  $('shareLink').value = shareOrigin() + '/d/' + id;
  $('docInfo').textContent = `${meta.name} · 버전 ${meta.version}`;
  renderHistory(meta);
  await showPdf(bytes);
}

function renderHistory(meta) {
  const ol = $('history'); ol.innerHTML = '';
  if (!meta) { ol.innerHTML = '<li class="muted">로컬 모드</li>'; return; }
  for (const h of meta.history.slice().reverse()) {
    const li = document.createElement('li');
    li.value = h.version;
    li.textContent = `${h.action}${h.by ? ' – ' + h.by : ''} (${fmtTime(h.at)})`;
    const a = document.createElement('a');
    a.href = `/api/docs/${meta.id}/pdf?v=${h.version}`;
    a.download = meta.name.replace(/\.pdf$/i, '') + `_v${h.version}.pdf`;
    a.textContent = '받기'; a.title = `버전 ${h.version} 다운로드`;
    li.append(' ', a);
    ol.appendChild(li);
  }
}

/* ---------- 렌더링 / 확대·축소 ---------- */
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const MAX_CANVAS_PIXELS = 8e6;   // 모바일(iOS) 캔버스 메모리 한계 고려

function fitWidth() {             // 확대 100% 일 때 페이지 폭(px)
  const v = $('viewer');
  return Math.max(200, Math.min(v.clientWidth - 36, 900));
}
function pageWidth() { return fitWidth() * state.zoom; }

// 페이지 하나를 현재 크기에 맞는 해상도로 새 캔버스에 그림
async function renderCanvas(page, cssWidth) {
  const vp1 = page.getViewport({ scale: 1 });
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2);
  let scale = (cssWidth * dpr) / vp1.width;
  scale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (vp1.width * vp1.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return canvas;
}

async function showPdf(bytes) {
  state.bytes = bytes;
  const pagesEl = $('pages');
  const viewer = $('viewer'), scroll = viewer.scrollTop;
  $('empty').hidden = true;
  const gen = ++showPdf.gen; renderPages.gen++;          // 진행 중인 다시 그리기 취소
  const pdf = await openPdf(bytes);
  const frag = document.createDocumentFragment(); // 다 그린 뒤 교체 → 깜빡임/스크롤 튐 방지
  const pages = [];
  applyZoomWidth();
  const w = pageWidth();
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.index = i - 1;
    div.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
    const no = document.createElement('span'); no.className = 'pno'; no.textContent = `${i} / ${pdf.numPages}`;
    div.append(await renderCanvas(page, w), no);
    frag.appendChild(div);
    div.addEventListener('pointerdown', onPagePointerDown);
    pages.push({ el: div, aspect: vp1.width / vp1.height, page });
  }
  if (gen !== showPdf.gen) { pdf.destroy(); return; }   // 그 사이 다른 문서를 열었음
  pagesEl.replaceChildren(frag);
  state.pdf?.destroy();
  state.pdf = pdf;
  state.pages = pages;
  state.placements = []; select(null);
  viewer.scrollTop = scroll;
  updateButtons();
}
showPdf.gen = 0;

// 확대/축소 후 선명하게 다시 그리기 (서명 배치는 그대로 유지)
async function renderPages() {
  const gen = ++renderPages.gen;
  const w = pageWidth();
  for (const p of state.pages) {
    let c;
    try { c = await renderCanvas(p.page, w); } catch { return; }  // 그 사이 문서가 바뀌어 닫힌 경우
    if (gen !== renderPages.gen) return;               // 더 새 요청이 있으면 중단
    p.el.querySelector('canvas').replaceWith(c);
  }
}
renderPages.gen = 0;

function applyZoomWidth() {
  $('pages').style.setProperty('--pw', pageWidth() + 'px');
  $('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
}

function setZoom(z) {
  z = Math.min(Math.max(z, ZOOMS[0]), ZOOMS[ZOOMS.length - 1]);
  if (Math.abs(z - state.zoom) < 1e-3) return;
  const v = $('viewer');
  // 화면 가운데 지점을 기준으로 확대/축소
  const cx = (v.scrollLeft + v.clientWidth / 2) / v.scrollWidth;
  const cy = (v.scrollTop + v.clientHeight / 2) / v.scrollHeight;
  state.zoom = z;
  applyZoomWidth();
  v.scrollLeft = cx * v.scrollWidth - v.clientWidth / 2;
  v.scrollTop = cy * v.scrollHeight - v.clientHeight / 2;
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(renderPages, 250);
}
function zoomStep(dir) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOMS.find((q) => q > z + 1e-3) : [...ZOOMS].reverse().find((q) => q < z - 1e-3);
  if (next) setZoom(next);
}

/* ---------- 서명 이미지 ---------- */
function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

// 이미지를 PNG 로 정규화 (+ 선택 시 흰 배경 제거, 여백 자르기)
async function processSignature(file, removeBg) {
  const url = URL.createObjectURL(file);
  let img;
  try { img = await loadImage(url); } finally { URL.revokeObjectURL(url); }
  const MAX = 1600;
  const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  if (!removeBg) return { url: c.toDataURL('image/png'), w, h };

  const d = ctx.getImageData(0, 0, w, h); const p = d.data;
  const HI = 235, LO = 170; // 밝기 HI 이상은 투명, LO~HI 는 부드럽게
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    const lum = 0.299 * p[k] + 0.587 * p[k + 1] + 0.114 * p[k + 2];
    let a = p[k + 3];
    if (lum >= HI) a = 0;
    else if (lum > LO) a = Math.round(a * (HI - lum) / (HI - LO));
    p[k + 3] = a;
    if (a > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  ctx.putImageData(d, 0, 0);
  if (maxX < 0) return { url: c.toDataURL('image/png'), w, h }; // 전부 투명 → 그대로
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const c2 = document.createElement('canvas'); c2.width = cw; c2.height = ch;
  c2.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
  return { url: c2.toDataURL('image/png'), w: cw, h: ch };
}

async function addSignatureFiles(files) {
  for (const f of files) {
    try {
      const sig = await processSignature(f, $('removeBg').checked);
      state.sigs.push({ id: ++uid, ...sig });
    } catch { banner(`이미지를 읽을 수 없습니다: ${f.name}`, 'err', 4000); }
  }
  saveSigLibrary(); renderSigList();
  if (state.sigs.length) startPlacing(state.sigs[state.sigs.length - 1]);
}

/* ---------- 서명 직접 그리기 ---------- */
// 획은 캔버스 폭 기준 0~1 좌표로 저장 → 창 크기가 바뀌거나 고해상도로 내보낼 때 그대로 다시 그림
const pad = { strokes: [], cur: null, color: '#111111', raf: 0 };

function drawStroke(ctx, s, W) {
  const pts = s.pts;
  const lw = (p) => Math.max(0.8, (s.size * W / 600) * p);
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (pts.length === 1) {                        // 점 하나 (콕 찍기)
    ctx.beginPath(); ctx.arc(pts[0].x * W, pts[0].y * W, lw(pts[0].p) / 2, 0, Math.PI * 2); ctx.fill(); return;
  }
  // 점 사이 중점을 잇는 2차 곡선으로 부드럽게, 구간마다 압력에 따른 굵기
  let prev = pts[0], from = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const c = pts[i], mid = { x: (prev.x + c.x) / 2, y: (prev.y + c.y) / 2 };
    ctx.beginPath(); ctx.moveTo(from.x * W, from.y * W);
    ctx.quadraticCurveTo(prev.x * W, prev.y * W, mid.x * W, mid.y * W);
    ctx.lineWidth = lw((prev.p + c.p) / 2); ctx.stroke();
    from = mid; prev = c;
  }
  ctx.beginPath(); ctx.moveTo(from.x * W, from.y * W); ctx.lineTo(prev.x * W, prev.y * W); ctx.stroke();
}

function redrawPad() {
  pad.raf = 0;
  const c = $('pad'), ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
  for (const s of pad.strokes) drawStroke(ctx, s, c.width);
  if (pad.cur) drawStroke(ctx, pad.cur, c.width);
  $('padOk').disabled = !pad.strokes.length;
}
function requestPadDraw() { if (!pad.raf) pad.raf = requestAnimationFrame(redrawPad); }

function sizePad() {
  const c = $('pad'), r = c.getBoundingClientRect(), dpr = Math.max(window.devicePixelRatio || 1, 1);
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  redrawPad();
}

function openPad() {
  pad.strokes = []; pad.cur = null;
  $('padModal').hidden = false;
  sizePad();
}
function closePad() { $('padModal').hidden = true; pad.cur = null; }

function padPoint(e, last) {
  const r = $('pad').getBoundingClientRect();
  // 펜이면 압력 반영 (마우스/손가락은 일정한 굵기), 압력 변화는 살짝 부드럽게
  let p = e.pointerType === 'pen' && e.pressure > 0 ? 0.3 + e.pressure * 1.4 : 1;
  if (last) p = last.p * 0.6 + p * 0.4;
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.width, p };
}

$('pad').addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault();
  try { $('pad').setPointerCapture(e.pointerId); } catch {}   // 캡처 실패해도 그리기는 계속
  pad.cur = { color: pad.color, size: +$('padSize').value, pts: [padPoint(e)], id: e.pointerId };
  requestPadDraw();
});
$('pad').addEventListener('pointermove', (e) => {
  if (!pad.cur || e.pointerId !== pad.cur.id) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];   // 빠르게 그어도 점이 빠지지 않게
  for (const ev of evs.length ? evs : [e]) pad.cur.pts.push(padPoint(ev, pad.cur.pts[pad.cur.pts.length - 1]));
  requestPadDraw();
});
const endStroke = (e) => {
  if (!pad.cur || e.pointerId !== pad.cur.id) return;
  pad.strokes.push(pad.cur); pad.cur = null; requestPadDraw();
};
$('pad').addEventListener('pointerup', endStroke);
$('pad').addEventListener('pointercancel', endStroke);

// 고해상도로 다시 그린 뒤 잉크 부분만 잘라 투명 PNG 로
function exportPad() {
  const W = 1500, H = W * 2 / 5;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  for (const s of pad.strokes) drawStroke(ctx, s, W);
  const a = ctx.getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a[(y * W + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  const padPx = 10;
  minX = Math.max(0, minX - padPx); minY = Math.max(0, minY - padPx);
  maxX = Math.min(W - 1, maxX + padPx); maxY = Math.min(H - 1, maxY + padPx);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  out.getContext('2d').drawImage(c, minX, minY, w, h, 0, 0, w, h);
  return { url: out.toDataURL('image/png'), w, h };
}

$('drawBtn').onclick = openPad;
$('padCancel').onclick = closePad;
$('padModal').addEventListener('pointerdown', (e) => { if (e.target === $('padModal')) closePad(); });
$('padUndo').onclick = () => { pad.strokes.pop(); requestPadDraw(); };
$('padClear').onclick = () => { pad.strokes = []; requestPadDraw(); };
for (const b of document.querySelectorAll('.ink')) b.onclick = () => {
  pad.color = b.dataset.color;
  document.querySelectorAll('.ink').forEach((q) => q.classList.toggle('sel', q === b));
};
$('padOk').onclick = () => {
  const sig = exportPad();
  closePad();
  if (!sig) return;
  state.sigs.push({ id: ++uid, ...sig });
  saveSigLibrary(); renderSigList();
  if (state.bytes) startPlacing(state.sigs[state.sigs.length - 1]);
  else banner('서명을 "내 서명"에 저장했습니다. 문서를 열면 붙일 수 있습니다.', 'ok', 4000);
};
window.addEventListener('resize', () => { if (!$('padModal').hidden) sizePad(); });

function saveSigLibrary() {
  try { localStorage.setItem('pdfsign.sigs', JSON.stringify(state.sigs.map(({ url, w, h }) => ({ url, w, h })))); }
  catch { /* 용량 초과 시 무시 */ }
}
function loadSigLibrary() {
  try { for (const s of JSON.parse(localStorage.getItem('pdfsign.sigs') || '[]')) state.sigs.push({ id: ++uid, ...s }); } catch {}
}

function renderSigList() {
  const box = $('sigList'); box.innerHTML = '';
  if (!state.sigs.length) { box.innerHTML = '<p class="muted">서명 사진을 불러오거나 "서명 그리기"로 직접 그리세요.</p>'; return; }
  for (const s of state.sigs) {
    const t = document.createElement('div');
    t.className = 'sigThumb' + (state.placingSig === s ? ' active' : '');
    t.title = '클릭 후 문서 위를 클릭해 붙이기';
    const im = document.createElement('img'); im.src = s.url;
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = '목록에서 제거';
    x.onclick = (e) => { e.stopPropagation(); state.sigs = state.sigs.filter((q) => q !== s); if (state.placingSig === s) stopPlacing(); saveSigLibrary(); renderSigList(); };
    t.append(im, x);
    t.onclick = () => (state.placingSig === s ? stopPlacing() : startPlacing(s));
    box.appendChild(t);
  }
}

function startPlacing(sig) {
  if (!state.bytes) { banner('먼저 PDF를 여세요.', '', 3000); return; }
  state.placingSig = sig; document.body.classList.add('placing');
  banner('문서에서 서명을 놓을 위치를 클릭하세요. (Esc: 취소)');
  renderSigList();
}
function stopPlacing() {
  state.placingSig = null; document.body.classList.remove('placing');
  $('banner').hidden = true; renderSigList();
}

/* ---------- 배치 / 이동 / 크기 조절 ---------- */
function onPagePointerDown(e) {
  if (!state.placingSig || e.target.closest('.sig')) return;
  e.stopPropagation();
  const pageEl = e.currentTarget;
  const idx = +pageEl.dataset.index;
  const r = pageEl.getBoundingClientRect();
  const sig = state.placingSig;
  const ratio = sig.w / sig.h;                 // 이미지 가로/세로
  const w = 0.25;
  const h = w * state.pages[idx].aspect / ratio;
  const p = {
    id: ++uid, page: idx, sig, ratio, w, h,
    x: (e.clientX - r.left) / r.width - w / 2,
    y: (e.clientY - r.top) / r.height - h / 2,
  };
  clamp(p);
  state.placements.push(p);
  drawPlacement(p);
  select(p);
  stopPlacing();
  updateButtons();
}

function clamp(p) {
  p.w = Math.min(Math.max(p.w, 0.01), 1); p.h = Math.min(Math.max(p.h, 0.005), 1);
  p.x = Math.min(Math.max(p.x, 0), 1 - p.w); p.y = Math.min(Math.max(p.y, 0), 1 - p.h);
}

function drawPlacement(p) {
  let el = p.el;
  if (!el) {
    el = p.el = document.createElement('div'); el.className = 'sig';
    const im = document.createElement('img'); im.src = p.sig.url; im.draggable = false;
    const h = document.createElement('div'); h.className = 'h'; h.title = '크기 조절';
    const d = document.createElement('div'); d.className = 'd'; d.textContent = '×'; d.title = '삭제';
    el.append(im, h, d);
    state.pages[p.page].el.appendChild(el);
    d.addEventListener('pointerdown', (e) => { e.stopPropagation(); removePlacement(p); });
    el.addEventListener('pointerdown', (e) => startDrag(e, p, e.target === h ? 'resize' : 'move'));
  }
  Object.assign(el.style, { left: p.x * 100 + '%', top: p.y * 100 + '%', width: p.w * 100 + '%', height: p.h * 100 + '%' });
}

function startDrag(e, p, mode) {
  e.preventDefault(); e.stopPropagation();
  select(p);
  const pageEl = state.pages[p.page].el;
  const r = pageEl.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY, o = { x: p.x, y: p.y, w: p.w, h: p.h };
  const target = e.currentTarget; target.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
    if (mode === 'move') { p.x = o.x + dx; p.y = o.y + dy; }
    else {
      p.w = Math.max(0.01, Math.min(o.w + dx, 1 - o.x));
      if ($('keepRatio').checked && !ev.shiftKey) p.h = p.w * state.pages[p.page].aspect / p.ratio;
      else p.h = Math.max(0.005, Math.min(o.h + dy, 1 - o.y));
    }
    clamp(p); drawPlacement(p); syncSelPanel();
  };
  const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

function select(p) {
  if (state.selected && state.selected.el) state.selected.el.classList.remove('sel');
  state.selected = p;
  if (p && p.el) p.el.classList.add('sel');
  $('selPanel').hidden = !p;
  syncSelPanel();
}
function syncSelPanel() {
  const p = state.selected; if (!p) return;
  $('sizeRange').value = (p.w * 100).toFixed(1);
  $('sizeVal').textContent = `페이지 폭의 ${(p.w * 100).toFixed(1)}%`;
}
function removePlacement(p) {
  p.el?.remove();
  state.placements = state.placements.filter((q) => q !== p);
  if (state.selected === p) select(null);
  updateButtons();
}

/* ---------- 합성 & 저장 ---------- */
function dataUrlToBytes(url) {
  const b = atob(url.split(',')[1]); const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}

async function applySignatures(baseBytes, placements) {
  const view = await openPdf(baseBytes);
  const doc = await PDFDocument.load(baseBytes);
  const pages = doc.getPages();
  const cache = new Map();
  for (const p of placements) {
    if (p.page >= pages.length) continue;
    let img = cache.get(p.sig);
    if (!img) { img = await doc.embedPng(dataUrlToBytes(p.sig.url)); cache.set(p.sig, img); }
    const vp = (await view.getPage(p.page + 1)).getViewport({ scale: 1 });
    const W = p.w * vp.width, H = p.h * vp.height;
    // 화면상 서명 왼쪽 아래 모서리 → PDF 좌표 (CropBox 오프셋·페이지 회전 반영)
    const [x, y] = vp.convertToPdfPoint(p.x * vp.width, p.y * vp.height + H);
    pages[p.page].drawImage(img, { x, y, width: W, height: H, rotate: degrees(vp.rotation) });
  }
  view.destroy();
  return await doc.save();
}

async function save() {
  if (!state.placements.length) return;
  const btn = $('saveBtn'); btn.disabled = true;
  const signer = $('signerName').value.trim();
  try {
    if (!state.docId) {
      state.bytes = await applySignatures(state.bytes, state.placements);
      await showPdf(state.bytes);
      banner('서명이 적용되었습니다. "PDF 다운로드"로 저장하세요.', 'ok', 5000);
      return;
    }
    banner('저장 중…');
    for (let attempt = 0; attempt < 5; attempt++) {
      // 항상 최신 버전 위에 서명을 얹어서 다른 사람의 서명이 지워지지 않게 함
      const r = await api(`/api/docs/${state.docId}/pdf`);
      const base = +r.headers.get('X-Version');
      const latest = new Uint8Array(await r.arrayBuffer());
      const out = await applySignatures(latest, state.placements);
      try {
        await api(`/api/docs/${state.docId}/pdf`, {
          method: 'PUT', body: out,
          headers: { 'Content-Type': 'application/pdf', 'X-Base-Version': String(base),
                     'X-Signer': encodeURIComponent(signer), 'X-Sign-Count': String(state.placements.length) },
        });
        await loadShared(state.docId);
        banner('서명이 저장되어 공유 문서에 반영되었습니다.', 'ok', 5000);
        return;
      } catch (e) { if (e.status !== 409) throw e; }  // 동시 저장 충돌 → 재시도
    }
    throw new Error('동시 저장 충돌이 계속됩니다. 잠시 후 다시 시도하세요.');
  } catch (e) {
    banner('저장 실패: ' + e.message, 'err');
  } finally { updateButtons(); }
}

/* ---------- 문서 목록 (서버 컴퓨터에서만) ---------- */
async function renderDocList() {
  const box = $('docList');
  let docs;
  try { docs = await (await api('/api/docs')).json(); } catch { return; }
  if (state.bytes) return;                       // 그 사이 문서를 열었음
  box.hidden = false;
  if (!docs.length) { box.innerHTML = '<h2>문서 목록</h2><p class="muted">아직 올린 문서가 없습니다.</p>'; return; }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = docs.map((d) => {
    const names = d.signers.map((n) => n || '(이름 없음)');
    const link = shareOrigin() + '/d/' + d.id;
    return `<tr>
      <td><a href="/d/${d.id}">${esc(d.name)}</a></td>
      <td class="num">${d.signers.length}</td>
      <td class="signers small">${names.length ? esc(names.join(', ')) : '<span class="muted">아직 없음</span>'}</td>
      <td class="small">${fmtTime(d.updated)}</td>
      <td class="act"><button class="btn small" data-copy="${esc(link)}">링크 복사</button><a class="btn small"
        href="/api/docs/${d.id}/pdf" download="${esc(d.name.replace(/\.pdf$/i, '') + '_signed.pdf')}">PDF 받기</a></td>
    </tr>`;
  }).join('');
  box.innerHTML = `<h2>문서 목록 <span class="muted small">(${docs.length}개 · 5초마다 자동 갱신 · 이 컴퓨터에서만 보임)</span></h2>
    <table><thead><tr><th>문서</th><th>서명 수</th><th>서명한 사람</th><th>마지막 변경</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
$('docList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); banner('링크를 복사했습니다: ' + b.dataset.copy, 'ok', 3000); }
  catch { prompt('링크를 복사하세요', b.dataset.copy); }
});

async function replaceDoc(file) {
  if (!file || !state.docId) return;
  const msg = `공유 링크는 그대로 두고 문서를 "${file.name}"(으)로 교체합니다.\n\n`
    + '지금까지 받은 서명은 새 파일에 옮겨지지 않습니다.\n(이전 버전은 왼쪽 "기록"에서 받을 수 있습니다)'
    + (state.placements.length ? '\n저장하지 않은 내 서명도 사라집니다.' : '') + '\n\n교체할까요?';
  if (!confirm(msg)) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    banner('문서 교체 중…');
    await api(`/api/docs/${state.docId}/pdf`, {
      method: 'PUT', body: bytes,
      headers: { 'Content-Type': 'application/pdf', 'X-Replace': '1',
                 'X-Filename': encodeURIComponent(file.name),
                 'X-Signer': encodeURIComponent($('signerName').value.trim()) },
    });
    await loadShared(state.docId);
    banner('문서를 교체했습니다. 같은 공유 링크로 새 문서에 서명할 수 있습니다.', 'ok', 5000);
  } catch (e) {
    banner('문서 교체 실패: ' + e.message, 'err');
  }
}

function download() {
  if (!state.bytes) return;
  const blob = new Blob([state.bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.name.replace(/\.pdf$/i, '') + '_signed.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------- 다른 사람의 변경 감지 ---------- */
setInterval(async () => {
  if (!state.bytes && config.canManage && !document.hidden) renderDocList();
  if (!state.docId || document.hidden) return;
  try {
    const meta = await (await api('/api/docs/' + state.docId)).json();
    if (meta.version === state.version) return;
    // 마지막으로 본 버전 이후에 문서 교체가 있었는지
    const replaced = meta.history.some((h) => h.version > state.version && h.action.startsWith('문서 교체'));
    if (!state.placements.length) {
      await loadShared(state.docId);
      banner(replaced ? '문서가 새 파일로 교체되어 다시 불러왔습니다.'
                      : '다른 사용자의 서명이 반영되어 문서를 새로 불러왔습니다.', 'ok', 4000);
    } else if (state.notified !== meta.version) {
      state.notified = meta.version;
      renderHistory(meta);
      banner(replaced ? '문서가 새 파일로 교체되었습니다. 내 서명은 새 문서에 저장되니, 저장 전에 새로고침해서 위치를 다시 잡는 것이 좋습니다.'
                      : '다른 사용자가 새 서명을 저장했습니다. 내 서명을 저장하면 최신 문서에 함께 반영됩니다.', replaced ? 'err' : '');
    }
  } catch {}
}, 5000);

/* ---------- 이벤트 ---------- */
$('pdfInput').onchange = (e) => { openLocalFile(e.target.files[0]); e.target.value = ''; };
$('sigInput').onchange = (e) => { addSignatureFiles([...e.target.files]); e.target.value = ''; };
$('replaceInput').onchange = (e) => { replaceDoc(e.target.files[0]); e.target.value = ''; };
$('zoomIn').onclick = () => zoomStep(1);
$('zoomOut').onclick = () => zoomStep(-1);
$('zoomFit').onclick = () => setZoom(1);
// Ctrl+휠 (노트북 터치패드 두 손가락 확대 포함) → 문서 확대/축소
$('viewer').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.pages.length) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.0025));
}, { passive: false });
// 창 크기가 바뀌면 '맞춤' 기준 폭도 바뀜
window.addEventListener('resize', () => {
  if (!state.pages.length) return;
  applyZoomWidth();
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(renderPages, 300);
});
$('saveBtn').onclick = save;
$('downloadBtn').onclick = download;
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('shareLink').value); }
  catch { $('shareLink').select(); document.execCommand('copy'); }
  banner('링크를 복사했습니다.', 'ok', 2000);
};
$('sizeRange').oninput = (e) => {
  const p = state.selected; if (!p) return;
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const nw = +e.target.value / 100;
  if ($('keepRatio').checked) p.h = nw * state.pages[p.page].aspect / p.ratio; else p.h *= nw / p.w;
  p.w = nw; p.x = cx - p.w / 2; p.y = cy - p.h / 2;
  clamp(p); drawPlacement(p); syncSelPanel();
};
$('delBtn').onclick = () => state.selected && removePlacement(state.selected);
$('signerName').value = localStorage.getItem('pdfsign.name') || '';
$('signerName').oninput = (e) => localStorage.setItem('pdfsign.name', e.target.value);

document.addEventListener('keydown', (e) => {
  if (!$('padModal').hidden) {               // 그리기 창이 열려 있으면 문서 단축키 대신 창 단축키
    if (e.key === 'Escape') closePad();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('padUndo').click(); }
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { stopPlacing(); select(null); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) { e.preventDefault(); removePlacement(state.selected); }
});
$('viewer').addEventListener('pointerdown', (e) => { if (!e.target.closest('.sig') && !state.placingSig) select(null); });

// 드래그 앤 드롭: PDF → 열기, 이미지 → 서명 추가
const viewer = $('viewer');
viewer.addEventListener('dragover', (e) => { e.preventDefault(); viewer.classList.add('dragover'); });
viewer.addEventListener('dragleave', () => viewer.classList.remove('dragover'));
viewer.addEventListener('drop', (e) => {
  e.preventDefault(); viewer.classList.remove('dragover');
  const files = [...e.dataTransfer.files];
  const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (pdf) openLocalFile(pdf).then(() => imgs.length && addSignatureFiles(imgs));
  else if (imgs.length) addSignatureFiles(imgs);
});
window.addEventListener('beforeunload', (e) => { if (state.placements.length) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- 시작 ---------- */
loadSigLibrary(); renderSigList();
(async () => {
  try { config = { ...config, ...(await (await api('/api/config')).json()) }; } catch {}
  const m = location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)/);
  if (m) await loadShared(m[1]).catch((e) => {
    banner('문서를 불러올 수 없습니다: ' + e.message, 'err');
    window.reportError?.('loadShared: ' + (e.stack || e.message));
  });
  if (config.canManage) $('listBtn').hidden = false;
  if (!m && config.canManage) renderDocList();
  else if (!m && !config.canUpload) {
    // 외부 접속자가 주소만 입력해 들어온 경우: 문서 목록은 공개하지 않으므로 공유 링크 안내
    $('empty').innerHTML = '<p>서명할 문서의 <b>공유 링크</b>(…/d/로 시작하는 주소)로 접속하세요.</p>'
      + '<p class="muted small">문서를 올린 사람에게 링크를 받아 그대로 열면 문서가 보입니다.<br>'
      + '내 PC의 PDF를 열면 이 브라우저 안에서만 서명한 뒤 다운로드할 수 있습니다.</p>';
  }
})();
