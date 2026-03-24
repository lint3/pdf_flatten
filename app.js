'use strict';

// ── PDF.js setup ─────────────────────────────────────────────────────────────
const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Operator constants — use pdfjsLib.OPS if available, else fall back to
// known values for PDF.js 3.x (from source: pdf.js/src/core/operator_list.js)
const OPS = pdfjsLib.OPS || {};
const OP_PAINT_IMAGE    = OPS.paintImageXObject    || 85;
const OP_PAINT_JPEG     = OPS.paintJpegXObject     || 82;
const OP_PAINT_MASK     = OPS.paintImageMaskXObject || 83;
const OP_SAVE           = OPS.save                 || 4;
const OP_RESTORE        = OPS.restore              || 5;
const OP_TRANSFORM      = OPS.transform            || 12;
const OP_SET_FONT       = OPS.setFont              || 27;
const OP_SET_TEXT_MTX   = OPS.setTextMatrix        || 72;

const IMAGE_OPS      = new Set([OP_PAINT_IMAGE, OP_PAINT_JPEG, OP_PAINT_MASK]);
const STRUCTURAL_OPS = new Set([OP_SAVE, OP_RESTORE, OP_TRANSFORM, OP_SET_FONT, OP_SET_TEXT_MTX]);

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  file: null,
  pdfDoc: null,          // PDF.js document
  pdfLibDoc: null,       // pdf-lib document (for copyPages)
  numPages: 0,
  flatImages: [],        // Uint8Array[] — JPEG bytes per page (output quality)
  thumbUrls: [],         // string[] — data URLs for thumbnails
  pageDims: [],          // {width, height}[] in PDF points (at scale=1)
  polarityPages: new Set(),  // 0-based indices to keep as original (auto-seeded, user-editable)
  isRendering: false,
  renderToken: 0,        // increment to abort in-progress render
  settings: { outputScale: 1.5, jpegQuality: 90, thumbSize: 100, printRendering: false, renderAnnotations: true },
};

// Shared offscreen canvases — reused across pages to reduce GC pressure
const offCanvas = document.createElement('canvas');
const offCtx    = offCanvas.getContext('2d');
const thumbCanvas = document.createElement('canvas');
const thumbCtx    = thumbCanvas.getContext('2d');

// ── DOM refs ─────────────────────────────────────────────────────────────────
const dropZone    = document.getElementById('drop-zone');
const fileInput   = document.getElementById('file-input');
const browseBtn   = document.getElementById('browse-btn');
const turboCheck  = document.getElementById('turbo-mode');
const dropError   = document.getElementById('drop-error');
const dragOverlay = document.getElementById('drag-overlay');
const workingView = document.getElementById('working-view');
const statusText  = document.getElementById('status-text');
const timerEl     = document.getElementById('timer');
const doneBtn     = document.getElementById('done-btn');
const clearBtn    = document.getElementById('clear-btn');
const flashArea   = document.getElementById('flash-area');
const flashImg    = document.getElementById('flash-img');
const noticeArea  = document.getElementById('notice-area');
const thumbGrid   = document.getElementById('thumb-grid');
const renderBtn   = document.getElementById('render-btn');
const sScale      = document.getElementById('s-scale');
const sScaleVal   = document.getElementById('s-scale-val');
const sQuality    = document.getElementById('s-quality');
const sQualityVal = document.getElementById('s-quality-val');
const sThumb             = document.getElementById('s-thumb');
const sThumbVal          = document.getElementById('s-thumb-val');
const sPrintRendering    = document.getElementById('s-print-rendering');
const sRenderAnnotations = document.getElementById('s-render-annotations');

// ── Timer ────────────────────────────────────────────────────────────────────
let timerInterval;

function startTimer() {
  const start = Date.now();
  timerEl.textContent = '0s';
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timerEl.textContent = Math.floor((Date.now() - start) / 1000) + 's';
  }, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// ── Drag / drop — always active on document ───────────────────────────────
// Use enter/leave depth counter to reliably detect leaving the window
let dragDepth = 0;

document.addEventListener('dragenter', () => {
  dragDepth++;
  if (workingView.hidden) dropZone.classList.add('drag-over');
  else dragOverlay.hidden = false;
});

document.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropZone.classList.remove('drag-over');
    dragOverlay.hidden = true;
  }
});

document.addEventListener('dragover', e => { e.preventDefault(); });

document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('drag-over');
  dragOverlay.hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ── File input (Browse button) ────────────────────────────────────────────
browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  fileInput.value = '';
});

// ── Settings live labels ──────────────────────────────────────────────────
sScale.addEventListener('input', () => { sScaleVal.textContent = sScale.value + '×'; });
sQuality.addEventListener('input', () => { sQualityVal.textContent = sQuality.value; });
sThumb.addEventListener('input', () => {
  sThumbVal.textContent = sThumb.value + 'px';
  if (state.thumbUrls.length) updateThumbGridColumns();
});

renderBtn.addEventListener('click', () => {
  if (!state.file) return;
  state.settings.outputScale      = parseFloat(sScale.value);
  state.settings.jpegQuality      = parseInt(sQuality.value);
  state.settings.thumbSize        = parseInt(sThumb.value);
  state.settings.printRendering   = sPrintRendering.checked;
  state.settings.renderAnnotations = sRenderAnnotations.checked;
  document.getElementById('settings-panel').open = false;
  startRender();
});

doneBtn.addEventListener('click', buildOutput);
clearBtn.addEventListener('click', clearAll);

const flattenAnywayBtn = document.getElementById('flatten-anyway-btn');
const settingsPanel = document.getElementById('settings-panel');
document.addEventListener('click', e => {
  if (settingsPanel.open && !settingsPanel.contains(e.target)) {
    settingsPanel.open = false;
  }
});

// ── File handling ─────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    dropError.textContent = 'Not a PDF file: ' + file.name;
    dropError.hidden = false;
    return;
  }
  dropError.hidden = true;

  state.file = file;
  state.polarityPages = new Set();

  dropZone.hidden  = true;
  workingView.hidden = false;

  await startRender();
}

function clearAll() {
  state.renderToken++;
  stopTimer();

  state.file       = null;
  state.pdfDoc     = null;
  state.pdfLibDoc  = null;
  state.numPages   = 0;
  state.flatImages = [];
  state.thumbUrls  = [];
  state.pageDims   = [];
  state.polarityPages = new Set();
  state.isRendering = false;

  hideTooltip();
  thumbGrid.innerHTML  = '';
  noticeArea.innerHTML = '';
  flattenAnywayBtn.hidden = true;
  flashArea.hidden  = true;
  doneBtn.disabled  = true;
  statusText.textContent = '';
  timerEl.textContent    = '';

  workingView.hidden = true;
  dropZone.hidden    = false;
}

// ── Render pipeline ───────────────────────────────────────────────────────
async function startRender() {
  const token = ++state.renderToken;
  state.isRendering = true;

  state.flatImages    = [];
  state.thumbUrls     = [];
  state.pageDims      = [];
  state.polarityPages = new Set();

  thumbGrid.innerHTML  = '';
  noticeArea.innerHTML = '';
  doneBtn.disabled = true;
  timerEl.textContent  = '';
  statusText.textContent = 'Checking...';

  try {
    const arrayBuffer = await state.file.arrayBuffer();
    if (token !== state.renderToken) return;

    // PDF.js detaches the ArrayBuffer it receives, so slice a copy for it
    state.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice()) }).promise;
    if (token !== state.renderToken) return;

    state.pdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer);
    if (token !== state.renderToken) return;

    state.numPages = state.pdfDoc.numPages;

    // Check before rendering so the user doesn't wait through a long render needlessly
    const alreadyFlat = await checkAlreadyFlattened();
    if (token !== state.renderToken) return;

    if (alreadyFlat) {
      showNotice('This PDF may already be flattened.', 'warn');
      flattenAnywayBtn.hidden = false;
      statusText.textContent = 'Paused.';
      await new Promise(resolve => flattenAnywayBtn.addEventListener('click', resolve, { once: true }));
      if (token !== state.renderToken) return;
      flattenAnywayBtn.hidden = true;
      noticeArea.innerHTML = '';
    }

    startTimer();
    flashArea.hidden = false;

    console.log(`[PDF Flattener] Rendering begin — ${state.numPages} pages`);
    for (let i = 0; i < state.numPages; i++) {
      if (token !== state.renderToken) return;
      statusText.textContent = `Rendering ${i + 1} / ${state.numPages}`;
      await renderPage(i);
      await new Promise(r => setTimeout(r, 0)); // yield to browser
    }
    console.log('[PDF Flattener] Rendering complete');

    if (token !== state.renderToken) return;
    flashArea.hidden = true;
    statusText.textContent = 'Analyzing...';

    state.polarityPages = await detectPolarityPages();
    if (token !== state.renderToken) return;

    stopTimer();
    state.isRendering = false;
    statusText.textContent = 'Done.';

    if (state.polarityPages.size === 0) {
      showNotice('No polarity pages auto-detected.', 'info');
    } else {
      const nums = [...state.polarityPages].map(i => i + 1).sort((a, b) => a - b).join(', ');
      const s = state.polarityPages.size !== 1 ? 's' : '';
      showNotice(`Auto-detected polarity page${s}: ${nums}`, 'info');
    }

    renderThumbGrid();
    doneBtn.disabled = false;

    if (turboCheck.checked) buildOutput();

  } catch (err) {
    if (token !== state.renderToken) return;
    stopTimer();
    state.isRendering = false;
    statusText.textContent = 'Error.';
    showNotice('Error loading PDF: ' + err.message, 'error');
  }
}

async function renderPage(i) {
  const page     = await state.pdfDoc.getPage(i + 1);
  const scale    = state.settings.outputScale;
  const viewport = page.getViewport({ scale });

  // PDF point dimensions (scale=1 maps 1pt → 1px in PDF.js)
  const nativeVp = page.getViewport({ scale: 1 });
  state.pageDims[i] = { width: nativeVp.width, height: nativeVp.height };

  // Render to shared offscreen canvas
  offCanvas.width  = Math.round(viewport.width);
  offCanvas.height = Math.round(viewport.height);
  offCtx.imageSmoothingEnabled = true;
  offCtx.imageSmoothingQuality = 'high';
  const annotationMode = (pdfjsLib.AnnotationMode || { DISABLE: 0, ENABLE: 1 })[
    state.settings.renderAnnotations ? 'ENABLE' : 'DISABLE'
  ];
  await page.render({
    canvasContext: offCtx,
    viewport,
    intent:         state.settings.printRendering ? 'print' : 'display',
    annotationMode,
  }).promise;

  // JPEG bytes for output assembly
  const quality = state.settings.jpegQuality / 100;
  state.flatImages[i] = dataUrlToBytes(offCanvas.toDataURL('image/jpeg', quality));

  // Downscale to thumbnail
  const size   = state.settings.thumbSize;
  const aspect = offCanvas.width / offCanvas.height;
  let tw, th;
  if (aspect >= 1) { th = size; tw = Math.round(size * aspect); }
  else              { tw = size; th = Math.round(size / aspect); }

  thumbCanvas.width  = tw;
  thumbCanvas.height = th;
  thumbCtx.drawImage(offCanvas, 0, 0, tw, th);
  state.thumbUrls[i] = thumbCanvas.toDataURL('image/jpeg', 0.8);

  flashImg.src = state.thumbUrls[i];
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── ToC / polarity detection ──────────────────────────────────────────────
async function detectPolarityPages() {
  const n          = state.numPages;
  const tocCutoff  = Math.ceil(n * 0.15);
  const found      = new Set();

  for (let i = 0; i < n; i++) {
    const page    = await state.pdfDoc.getPage(i + 1);
    const content = await page.getTextContent();
    const text    = content.items.map(it => it.str).join(' ');

    const isCandidate =
      i < tocCutoff ||
      text.includes('Table of Contents') ||
      (text.includes('Name') && text.includes('Page Number'));

    if (!isCandidate) continue;
    console.log(`[PDF Flattener] ToC candidate: page ${i + 1}`, '\nFull text:', text);

    if (!text.toLowerCase().includes('polarity')) continue;

    // Items are stored sequentially: [label, space, pagenum, empty, next_label, ...]
    // so the page number is simply the next purely-numeric item after the polarity label.
    const items = content.items;
    for (let j = 0; j < items.length; j++) {
      if (!items[j].str || !items[j].str.toLowerCase().includes('polarity')) continue;
      for (let k = j + 1; k < Math.min(j + 4, items.length); k++) {
        if (!items[k].str || !/^\s*\d+\s*$/.test(items[k].str)) continue;
        const pageNum = parseInt(items[k].str.trim());
        console.log(`[PDF Flattener] Polarity item on page ${i + 1}: "${items[j].str}" → page ref ${pageNum}`);
        found.add(pageNum - 1);
        break;
      }
    }
  }

  const result = new Set([...found].filter(i => i >= 0 && i < n));
  console.log('[PDF Flattener] Detected polarity pages (0-based):', [...result], '→ page numbers:', [...result].map(i => i + 1));
  return result;
}

// ── Already-flattened detection ───────────────────────────────────────────
async function checkAlreadyFlattened() {
  const sample = Math.min(state.numPages, 10);
  let flatCount = 0;

  for (let i = 0; i < sample; i++) {
    const page = await state.pdfDoc.getPage(i + 1);
    const ops  = await page.getOperatorList();
    const imgOps  = ops.fnArray.filter(fn => IMAGE_OPS.has(fn)).length;
    const drawOps = ops.fnArray.filter(fn => !STRUCTURAL_OPS.has(fn)).length;
    // A pure-raster page has exactly 1 image op and very few other drawing ops
    if (imgOps === 1 && drawOps <= 3) flatCount++;
  }

  return (flatCount / sample) > 0.8;
}

// ── Mega tooltip ─────────────────────────────────────────────────────────
const megaTooltip = document.getElementById('mega-tooltip');
const tooltipImg  = document.getElementById('tooltip-img');
let tooltipW = 0, tooltipH = 0;
let tooltipBlobUrl = null;

function showTooltip(i, e) {
  if (!state.flatImages[i] || !state.pageDims[i]) return;

  const { width, height } = state.pageDims[i];
  const aspect = width / height;
  const maxW   = window.innerWidth  * 0.5;
  const maxH   = window.innerHeight * 0.5;

  tooltipW = maxW;
  tooltipH = tooltipW / aspect;
  if (tooltipH > maxH) { tooltipH = maxH; tooltipW = tooltipH * aspect; }
  tooltipW = Math.round(tooltipW);
  tooltipH = Math.round(tooltipH);

  if (tooltipBlobUrl) URL.revokeObjectURL(tooltipBlobUrl);
  tooltipBlobUrl = URL.createObjectURL(new Blob([state.flatImages[i]], { type: 'image/jpeg' }));
  tooltipImg.src = tooltipBlobUrl;
  tooltipImg.style.width  = tooltipW + 'px';
  tooltipImg.style.height = tooltipH + 'px';

  megaTooltip.hidden = false;
  positionTooltip(e);
}

function positionTooltip(e) {
  const gap = 14;
  let x = e.clientX + gap;
  let y = e.clientY + gap;

  if (x + tooltipW > window.innerWidth)  x = e.clientX - gap - tooltipW;
  if (y + tooltipH > window.innerHeight) y = e.clientY - gap - tooltipH;

  // Hard clamp — ensures it never escapes the viewport
  x = Math.max(0, Math.min(x, window.innerWidth  - tooltipW));
  y = Math.max(0, Math.min(y, window.innerHeight - tooltipH));

  megaTooltip.style.left = x + 'px';
  megaTooltip.style.top  = y + 'px';
}

function hideTooltip() {
  megaTooltip.hidden = true;
  tooltipImg.src = '';
  if (tooltipBlobUrl) { URL.revokeObjectURL(tooltipBlobUrl); tooltipBlobUrl = null; }
}

// ── Thumbnail grid ────────────────────────────────────────────────────────
function renderThumbGrid() {
  thumbGrid.innerHTML = '';
  updateThumbGridColumns();

  for (let i = 0; i < state.numPages; i++) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.pageIndex = i;

    const img = document.createElement('img');
    img.src = state.thumbUrls[i];
    img.alt = '';

    const label = document.createElement('div');
    label.className = 'page-num label-caps';
    label.textContent = i + 1;

    card.append(img, label);
    card.addEventListener('click',      () => togglePolarity(i));
    card.addEventListener('mouseenter', e  => showTooltip(i, e));
    card.addEventListener('mousemove',  e  => { if (!megaTooltip.hidden) positionTooltip(e); });
    card.addEventListener('mouseleave',    hideTooltip);
    thumbGrid.appendChild(card);
  }

  for (let i = 0; i < state.numPages; i++) {
    refreshCardStyle(i);
  }
}

function updateThumbGridColumns() {
  const minW = state.settings.thumbSize + 12;
  thumbGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${minW}px, 1fr))`;
}

function togglePolarity(i) {
  if (state.polarityPages.has(i)) state.polarityPages.delete(i);
  else state.polarityPages.add(i);
  refreshCardStyle(i);
}

function isPolarity(i) {
  return state.polarityPages.has(i);
}

function refreshCardStyle(i) {
  const card = thumbGrid.querySelector(`[data-page-index="${i}"]`);
  if (card) card.classList.toggle('polarity', isPolarity(i));
}

// ── Output assembly ───────────────────────────────────────────────────────
async function buildOutput() {
  doneBtn.disabled = true;
  statusText.textContent = 'Assembling...';

  try {
    const { PDFDocument } = PDFLib;
    const outputDoc = await PDFDocument.create();

    for (let i = 0; i < state.numPages; i++) {
      if (isPolarity(i)) {
        // Keep original vector page
        const [copied] = await outputDoc.copyPages(state.pdfLibDoc, [i]);
        outputDoc.addPage(copied);
      } else {
        // Embed flattened JPEG; page sized to exact original dimensions (no added margin)
        const jpgImage = await outputDoc.embedJpg(state.flatImages[i]);
        const { width, height } = state.pageDims[i];
        const page = outputDoc.addPage([width, height]);
        // pdf-lib origin is bottom-left; x=0, y=0 fills page exactly
        page.drawImage(jpgImage, { x: 0, y: 0, width, height });
      }
    }

    const pdfBytes = await outputDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = state.file.name.replace(/\.pdf$/i, '') + '_FLAT.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    statusText.textContent = 'Saved.';
    doneBtn.disabled = false;

  } catch (err) {
    statusText.textContent = 'Assembly error.';
    showNotice('Assembly failed: ' + err.message, 'error');
    doneBtn.disabled = false;
  }
}

// ── Notices ───────────────────────────────────────────────────────────────
function showNotice(msg, type) {
  const el = document.createElement('div');
  if (type === 'error') {
    el.className = 'error-detail';
  } else {
    el.className = 'notice label-caps';
    if (type === 'warn') el.classList.add('notice-warn');
  }
  el.textContent = msg;
  noticeArea.appendChild(el);
}
