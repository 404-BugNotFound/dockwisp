"use strict";

/* ------------------------------------------------------------------ *
 * Dockwisp 截图覆盖层（微信风）
 * 坐标约定：选区与标注一律以“图片原始像素”存储。
 * 显示时按通用视图变换 view = { ox, oy, sx, sy } 换算：
 *   view 坐标 = ox + 图片坐标 * s ；图片坐标 = (view 坐标 - o) / s
 * 普通模式 ox=oy=0，sx=viewW/natW，sy=viewH/natH（铺满视口，可非等比）。
 * 长图模式按 contain 等比缩放居中（sx=sy=s）。
 * ------------------------------------------------------------------ */

const api = window.screenshot || {
  // 开发/自检时的降级桩，真实环境由 preload 注入。
  onState() {},
  onReset() {},
  onShown() {},
  onRevealed() {},
  painted() {},
  close() {},
  ready() {},
  async copyImage() { return false; },
  async copyText() { return false; },
  async saveImage() { return null; },
  async ocr() { return ""; },
  async ocrLayout() { return { text: "", lines: [] }; },
  async translate(t) {
    return { translatedText: t, sourceLanguage: "auto", targetLanguage: "zh", provider: "mock" };
  },
  async translateBatch(texts) {
    return {
      translations: texts.map((t) => "[译] " + t),
      sourceLanguage: "en",
      targetLanguage: "zh",
      provider: "mock",
    };
  },
  async pin() { return true; },
  longStart() {},
  onLongResult() {},
  onLongCancel() {},
};

const root = document.getElementById("root");
const shot = document.getElementById("shot");
const trans = document.getElementById("trans");
const anno = document.getElementById("anno");
const selEl = document.getElementById("selection");
const sizeTag = document.getElementById("sizeTag");
const toolbar = document.getElementById("toolbar");
const subbar = document.getElementById("subbar");
const subArrow = document.getElementById("subArrow");
const subContent = document.getElementById("subContent");
const toast = document.getElementById("toast");
const maskTop = document.getElementById("maskTop");
const maskBottom = document.getElementById("maskBottom");
const maskLeft = document.getElementById("maskLeft");
const maskRight = document.getElementById("maskRight");
const ocrBoxes = document.getElementById("ocrBoxes");
const transLoading = document.getElementById("transLoading");
const transToggle = document.getElementById("transToggle");
const transLabel = document.getElementById("transLabel");
const textEditor = document.getElementById("textEditor");
const brushCursor = document.getElementById("brushCursor");

const panel = document.getElementById("panel");
const panelTitle = document.getElementById("panelTitle");
const panelLoading = document.getElementById("panelLoading");
const panelLoadingText = document.getElementById("panelLoadingText");
const panelSourceWrap = document.getElementById("panelSourceWrap");
const panelSource = document.getElementById("panelSource");
const panelTextLabel = document.getElementById("panelTextLabel");
const panelText = document.getElementById("panelText");
const panelFoot = document.getElementById("panelFoot");

const octx = anno.getContext("2d");
const sctx = shot.getContext("2d", { alpha: false });
const tctx = trans.getContext("2d");

/* ------------------------------ 配置 ------------------------------ */

const MIN_SELECTION_CSS = 8;

// 颜色调色板（红为默认）。
const PALETTE = ["#f5222d", "#fa8c16", "#fadb14", "#52c41a", "#1890ff", "#ffffff", "#000000"];
// 3 档描边粗细（CSS px）。
const STROKE_W = [3, 5, 8];
// 3 档马赛克块大小（CSS px，会换算到图片像素）。
const MOSAIC_BLOCK = [12, 20, 30];
// 3 档马赛克笔刷半径（CSS px）。
const MOSAIC_RADIUS = [10, 18, 28];
// 3 档文字字号（CSS px）。
const FONT_SIZE = [18, 26, 38];
// 3 档表情大小（CSS px）。
const EMOJI_SIZE = [44, 72, 110];

// 常用 emoji（约 40 个）。
const EMOJIS = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "😎", "🤔", "😅", "😭",
  "😡", "😱", "🥳", "😴", "🤯", "😏", "🙄", "😬", "🤗", "😇",
  "👍", "👎", "👌", "👏", "🙏", "💪", "✌️", "👀", "💯", "🔥",
  "❤️", "💔", "⭐", "✅", "❌", "❗", "❓", "⚠️", "🎉", "💡",
];

// 每个工具独立记忆设置。
const toolSettings = {
  rect: { weight: 0, color: "#f5222d" },
  ellipse: { weight: 0, color: "#f5222d" },
  arrow: { weight: 0, color: "#f5222d" },
  pen: { weight: 0, color: "#f5222d" },
  mosaic: { size: 0 },
  text: { font: 0, color: "#f5222d" },
  emoji: { char: "😀", size: 0 },
};

/* ------------------------------ 状态 ------------------------------ */

let imageReady = false;
let stateToken = 0;
let annoDirty = false;
let baseImage = null;
let natW = 0;
let natH = 0;

let selection = null; // { x, y, w, h } —— 原始像素
let selectionVersion = 0;
let annotations = [];
let selectedIndex = -1; // 当前选中的已完成标注下标（-1 无）
let activeTool = null; // rect|ellipse|arrow|pen|mosaic|text|emoji|null

// 长图模式。
let longMode = false;

// 译文层数据。
let transLayer = null; // { paragraphs:[{box,text}], info:{src,dst,provider} }
let transVisible = false; // 当前是否显示译文（切换胶囊）
let translating = false;

// 提取文字高亮数据。
let ocrLayout = null; // { lines:[{text,box}] }

// 识别缓存（提取文字面板用）。
let ocrText = null;

// 撤销历史（标注数组的快照）。
let history = [];

const pointer = {
  mode: "idle", // idle|creating|moving|resizing|drawing|annoMove|annoResize
  handle: null,
  startX: 0,
  startY: 0,
  originSel: null,
  draft: null,
  annoOrigin: null, // 选中标注拖动前的快照
  preSnapshot: null, // 拖动前整组标注快照（用于撤销）
  moved: false,
};

/* --------------------------- 视图变换 --------------------------- */

let viewW = window.innerWidth;
let viewH = window.innerHeight;
const view = { ox: 0, oy: 0, sx: 1, sy: 1 };

function updateView() {
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  if (!natW || !natH) return;
  if (longMode) {
    const s = Math.min(viewW / natW, viewH / natH);
    const dispW = natW * s;
    const dispH = natH * s;
    view.ox = (viewW - dispW) / 2;
    view.oy = (viewH - dispH) / 2;
    view.sx = s;
    view.sy = s;
    for (const c of [shot, trans, anno]) {
      c.style.left = `${view.ox}px`;
      c.style.top = `${view.oy}px`;
      c.style.width = `${dispW}px`;
      c.style.height = `${dispH}px`;
    }
  } else {
    view.ox = 0;
    view.oy = 0;
    view.sx = viewW / natW;
    view.sy = viewH / natH;
    for (const c of [shot, trans, anno]) {
      c.style.left = "";
      c.style.top = "";
      c.style.width = "";
      c.style.height = "";
    }
  }
}

// 图片像素 → 视口 CSS 坐标。
function vx(x) { return view.ox + x * view.sx; }
function vy(y) { return view.oy + y * view.sy; }
// 平均比例（用于线宽/容差换算）。
function avgScale() { return (view.sx + view.sy) / 2; }

// 指针事件 → 图片原始像素坐标。
function toImageCoords(ev) {
  return {
    x: clamp((ev.clientX - view.ox) / view.sx, 0, natW),
    y: clamp((ev.clientY - view.oy) / view.sy, 0, natH),
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* --------------------------- 初始化 / 显示握手 --------------------------- */

api.onState((state) => {
  if (!state || (!state.pixels && typeof state.imageUrl !== "string")) return;
  resetAll();
  updateView();
  const token = ++stateToken;

  if (state.pixels) {
    try {
      const bytes = state.pixels;
      const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      showBase(new ImageData(data, state.width, state.height), state.width, state.height);
    } catch {
      /* 尺寸不符等异常也要通知，避免窗口卡住 */
    }
    notifyReady();
    return;
  }

  const img = new Image();
  img.src = state.imageUrl;
  img
    .decode()
    .catch(() => undefined)
    .then(() => {
      if (token !== stateToken) return;
      if (img.naturalWidth) showBase(img, img.naturalWidth, img.naturalHeight);
      notifyReady();
    });
});

function showBase(source, width, height) {
  natW = width;
  natH = height;
  for (const canvas of [shot, anno, trans]) {
    if (canvas.width !== natW || canvas.height !== natH) {
      canvas.width = natW;
      canvas.height = natH;
    }
  }
  if (source instanceof ImageData) {
    sctx.putImageData(source, 0, 0);
  } else {
    sctx.drawImage(source, 0, 0, natW, natH);
  }
  octx.clearRect(0, 0, natW, natH);
  tctx.clearRect(0, 0, natW, natH);
  annoDirty = false;
  baseImage = shot;
  mosaicCache = null;
  imageReady = true;
  updateView();
  render();
}

api.onShown(() => {
  let sent = false;
  const fire = () => {
    if (sent) return;
    sent = true;
    api.painted();
  };
  requestAnimationFrame(() => requestAnimationFrame(fire));
  setTimeout(fire, 120);
});

api.onRevealed(() => {
  requestAnimationFrame(() => {
    root.dataset.entering = "false";
  });
});

api.onReset(() => {
  stateToken += 1;
  resetAll();
  if (natW > 0 && natH > 0) {
    sctx.clearRect(0, 0, natW, natH);
    octx.clearRect(0, 0, natW, natH);
    tctx.clearRect(0, 0, natW, natH);
  }
  annoDirty = false;
  render();
});

function resetAll() {
  imageReady = false;
  baseImage = null;
  mosaicCache = null;
  selection = null;
  selectionVersion += 1;
  annotations = [];
  selectedIndex = -1;
  activeTool = null;
  longMode = false;
  transLayer = null;
  transVisible = false;
  translating = false;
  ocrLayout = null;
  ocrText = null;
  history = [];
  currentPanel = null;
  busy = false;
  readyNotified = false;
  pointer.mode = "idle";
  pointer.handle = null;
  pointer.originSel = null;
  pointer.draft = null;
  pointer.annoOrigin = null;
  pointer.preSnapshot = null;
  pointer.moved = false;

  // DOM 复位。
  root.dataset.entering = "true";
  root.dataset.mode = "idle";
  root.dataset.toolActive = "false";
  root.dataset.brush = "false";
  brushCursor.hidden = true;
  root.dataset.hasSelection = "false";
  root.dataset.long = "false";
  selEl.hidden = true;
  toolbar.hidden = true;
  subbar.hidden = true;
  panel.hidden = true;
  toast.hidden = true;
  toast.classList.remove("show");
  transLoading.hidden = true;
  transToggle.hidden = true;
  trans.hidden = true;
  textEditor.hidden = true;
  ocrBoxes.innerHTML = "";
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  restoreBtn("ocr");
  restoreBtn("translate");
  syncToolbar();
}

function restoreBtn(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.classList.remove("busy");
  btn.disabled = false;
}

let readyNotified = false;
function notifyReady() {
  if (readyNotified) return;
  const fire = () => {
    if (readyNotified) return;
    readyNotified = true;
    if (typeof api.ready === "function") api.ready();
  };
  requestAnimationFrame(fire);
  setTimeout(fire, 32);
}

/* --------------------------- 撤销历史 --------------------------- */

function snapshotAnnos() {
  return JSON.stringify(annotations);
}
function pushHistory(snap) {
  history.push(snap != null ? snap : snapshotAnnos());
  if (history.length > 120) history.shift();
  syncToolbar();
}
function undo() {
  if (history.length === 0) return;
  annotations = JSON.parse(history.pop());
  selectedIndex = -1;
  annoDirty = true;
  render();
  syncToolbar();
}

/* --------------------------- 工具栏事件 --------------------------- */

for (const btn of document.querySelectorAll("#tools .tb-btn")) {
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
}

for (const stop of [toolbar, subbar, panel, transToggle]) {
  stop.addEventListener("pointerdown", (e) => e.stopPropagation());
}

document.getElementById("undo").addEventListener("click", undo);
document.getElementById("close").addEventListener("click", () => api.close());
document.getElementById("done").addEventListener("click", async () => {
  const copied = await doCopy();
  if (copied) api.close();
});
document.getElementById("save").addEventListener("click", doSave);
document.getElementById("pin").addEventListener("click", doPin);
document.getElementById("ocr").addEventListener("click", toggleOcr);
document.getElementById("translate").addEventListener("click", toggleTranslate);
document.getElementById("long").addEventListener("click", startLong);

document.getElementById("panelClose").addEventListener("click", hidePanel);
document.getElementById("panelCopy").addEventListener("click", copyPanel);
document.getElementById("panelSelectAll").addEventListener("click", () => {
  panelText.focus();
  panelText.select();
});
panelText.addEventListener("pointerdown", (e) => e.stopPropagation());
panelText.addEventListener("input", () => {
  if (currentPanel === "ocr") ocrText = panelText.value;
});

for (const btn of transToggle.querySelectorAll(".seg button")) {
  btn.addEventListener("click", () => setTransView(btn.dataset.trans === "dst"));
}

function setTool(tool) {
  // 切工具前结束文字编辑。
  commitTextEditor();
  activeTool = activeTool === tool ? null : tool;
  selectedIndex = -1;
  root.dataset.toolActive = activeTool ? "true" : "false";
  if (activeTool !== "mosaic") updateBrushCursor(null);
  annoDirty = true;
  buildSubbar();
  syncToolbar();
  render();
}

function syncToolbar() {
  for (const btn of document.querySelectorAll("#tools .tb-btn")) {
    btn.setAttribute("aria-pressed", btn.dataset.tool === activeTool ? "true" : "false");
  }
  const undoBtn = document.getElementById("undo");
  undoBtn.disabled = history.length === 0;
  const translateBtn = document.getElementById("translate");
  translateBtn.setAttribute("aria-pressed", transVisible ? "true" : "false");
  const ocrBtn = document.getElementById("ocr");
  ocrBtn.setAttribute("aria-pressed", ocrLayout ? "true" : "false");
  // 长图模式禁用“长截图”按钮。
  document.getElementById("long").disabled = longMode;
}

/* --------------------------- 二级栏 --------------------------- */

const DRAW_TOOLS = ["rect", "ellipse", "arrow", "pen", "mosaic", "text", "emoji"];

function buildSubbar() {
  subContent.innerHTML = "";
  subbar.classList.remove("emoji-panel");
  if (!activeTool || !DRAW_TOOLS.includes(activeTool)) {
    subbar.hidden = true;
    return;
  }
  const s = toolSettings[activeTool];
  if (activeTool === "emoji") {
    buildEmojiPanel();
  } else if (activeTool === "mosaic") {
    appendSizeDots(MOSAIC_RADIUS.map((_, i) => i), s.size, (i) => {
      s.size = i;
      buildSubbar();
    });
  } else if (activeTool === "text") {
    appendFontSizes(s.font, (i) => { s.font = i; buildSubbar(); });
    appendSep();
    appendColors(s.color, (c) => { s.color = c; buildSubbar(); });
  } else {
    appendSizeDots([0, 1, 2], s.weight, (i) => { s.weight = i; buildSubbar(); });
    appendSep();
    appendColors(s.color, (c) => { s.color = c; buildSubbar(); });
  }
  subbar.hidden = false;
  positionSubbar();
}

function appendSep() {
  const sep = document.createElement("span");
  sep.className = "sub-sep";
  subContent.appendChild(sep);
}

function appendSizeDots(levels, current, onPick) {
  const sizes = [7, 11, 16];
  levels.forEach((lvl, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-size";
    btn.setAttribute("aria-pressed", i === current ? "true" : "false");
    const dot = document.createElement("i");
    const d = sizes[i] || 10;
    dot.style.width = `${d}px`;
    dot.style.height = `${d}px`;
    btn.appendChild(dot);
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", () => onPick(i));
    subContent.appendChild(btn);
  });
}

function appendFontSizes(current, onPick) {
  const labels = ["A", "A", "A"];
  const fs = [13, 17, 22];
  labels.forEach((t, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-font";
    btn.textContent = t;
    btn.style.fontSize = `${fs[i]}px`;
    btn.setAttribute("aria-pressed", i === current ? "true" : "false");
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", () => onPick(i));
    subContent.appendChild(btn);
  });
}

function appendColors(current, onPick) {
  for (const c of PALETTE) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-color";
    btn.style.background = c;
    btn.setAttribute("aria-pressed", c === current ? "true" : "false");
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", () => onPick(c));
    subContent.appendChild(btn);
  }
}

function buildEmojiPanel() {
  subbar.classList.add("emoji-panel");
  const s = toolSettings.emoji;
  const grid = document.createElement("div");
  grid.className = "emoji-grid";
  for (const ch of EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-cell";
    b.textContent = ch;
    b.setAttribute("aria-pressed", ch === s.char ? "true" : "false");
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => { s.char = ch; buildSubbar(); });
    grid.appendChild(b);
  }
  subContent.appendChild(grid);

  const hint = document.createElement("div");
  hint.className = "emoji-hint";
  hint.textContent = "选好表情后，在选区内点击放置";
  subContent.appendChild(hint);

  const sizes = document.createElement("div");
  sizes.className = "emoji-sizes";
  ["小", "中", "大"].forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sub-font";
    b.textContent = t;
    b.style.fontSize = "13px";
    b.setAttribute("aria-pressed", i === s.size ? "true" : "false");
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => { s.size = i; buildSubbar(); });
    sizes.appendChild(b);
  });
  subContent.appendChild(sizes);
}

/* --------------------------- 指针交互 --------------------------- */

root.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

root.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (longMode) {
    api.close();
    return;
  }
  if (selection) {
    selection = null;
    selectionVersion += 1;
    annotations = [];
    history = [];
    selectedIndex = -1;
    annoDirty = true;
    ocrText = null;
    ocrLayout = null;
    clearTranslation();
    activeTool = null;
    root.dataset.toolActive = "false";
    hidePanel();
    buildSubbar();
    render();
  } else {
    api.close();
  }
});

function hitHandle(ev) {
  const el = ev.target;
  if (el && el.classList && el.classList.contains("handle")) {
    return el.dataset.handle;
  }
  return null;
}

function insideSelection(p) {
  return (
    selection &&
    p.x >= selection.x &&
    p.x <= selection.x + selection.w &&
    p.y >= selection.y &&
    p.y <= selection.y + selection.h
  );
}

function invalidateSelectionState(clearAnnotations) {
  selectionVersion += 1;
  ocrText = null;
  ocrLayout = null;
  clearTranslation();
  if (clearAnnotations && annotations.length > 0) {
    annotations = [];
    history = [];
    selectedIndex = -1;
    annoDirty = true;
  }
  hidePanel();
}

function onPointerDown(ev) {
  if (!imageReady || ev.button !== 0) return;
  const p = toImageCoords(ev);

  // 文字编辑中：点击别处先提交。
  if (!textEditor.hidden) {
    commitTextEditor();
  }

  // 长图模式：不动选区，但支持选中标注与绘制。
  if (longMode) {
    if (handleAnnoPointerDown(ev, p)) return;
    if (activeTool && insideSelection(p)) {
      if (startAnnotationDraw(p)) return;
    }
    return;
  }

  // 1) 命中已完成标注的控制点 / 本体（无工具或同类工具）→ 选中 / 移动 / 缩放。
  if (selection && handleAnnoPointerDown(ev, p)) return;

  // 2) 已有选区 + 选了标注工具 + 在选区内 → 绘制 / 放置新标注。
  if (selection && activeTool && insideSelection(p)) {
    if (startAnnotationDraw(p)) return;
  }

  // 3) 命中选区手柄 → 调整大小。
  const handle = hitHandle(ev);
  if (selection && handle && !activeTool) {
    invalidateSelectionState(false);
    pointer.mode = "resizing";
    pointer.handle = handle;
    pointer.originSel = { ...selection };
    pointer.startX = p.x;
    pointer.startY = p.y;
    root.dataset.mode = "dragging";
    return;
  }

  // 4) 选区内部（无工具）→ 移动选区。
  if (selection && !activeTool && insideSelection(p)) {
    invalidateSelectionState(false);
    pointer.mode = "moving";
    pointer.originSel = { ...selection };
    pointer.startX = p.x;
    pointer.startY = p.y;
    root.dataset.mode = "dragging";
    return;
  }

  // 5) 其它 → 重新拉选区。
  selectedIndex = -1;
  invalidateSelectionState(true);
  pointer.mode = "creating";
  pointer.startX = p.x;
  pointer.startY = p.y;
  selection = { x: p.x, y: p.y, w: 0, h: 0 };
  root.dataset.mode = "dragging";
  render();
}

/** 马赛克工具下，在选区内用圆圈显示笔刷大小（随鼠标移动）。 */
function updateBrushCursor(ev) {
  const overUi = !!ev && ev.target instanceof Element &&
    !!ev.target.closest("#toolbar, #subbar, #panel, #transToggle");
  const on =
    !!ev && !overUi && activeTool === "mosaic" && imageReady && !!selection &&
    insideSelection(toImageCoords(ev)) && textEditor.hidden;
  root.dataset.brush = on ? "true" : "false";
  if (!on) {
    brushCursor.hidden = true;
    return;
  }
  const d = (MOSAIC_RADIUS[toolSettings.mosaic.size || 0] || 10) * 2;
  brushCursor.style.width = `${d}px`;
  brushCursor.style.height = `${d}px`;
  brushCursor.style.transform = `translate(${ev.clientX - d / 2}px, ${ev.clientY - d / 2}px)`;
  brushCursor.hidden = false;
}

window.addEventListener("pointerleave", () => updateBrushCursor(null));

function onPointerMove(ev) {
  updateBrushCursor(ev);
  if (pointer.mode === "idle") return;
  const p = toImageCoords(ev);

  if (pointer.mode === "creating") {
    selection = normalizeRect(pointer.startX, pointer.startY, p.x, p.y);
    render();
  } else if (pointer.mode === "moving") {
    const dx = p.x - pointer.startX;
    const dy = p.y - pointer.startY;
    const o = pointer.originSel;
    selection = {
      x: clamp(o.x + dx, 0, natW - o.w),
      y: clamp(o.y + dy, 0, natH - o.h),
      w: o.w,
      h: o.h,
    };
    render();
  } else if (pointer.mode === "resizing") {
    selection = resizeSelection(pointer.originSel, pointer.handle, p);
    render();
  } else if (pointer.mode === "drawing") {
    updateDraft(pointer.draft, p);
    annoDirty = true;
    render();
  } else if (pointer.mode === "annoMove" || pointer.mode === "annoResize") {
    handleAnnoPointerMove(p);
  }
}

function onPointerUp() {
  if (pointer.mode === "idle") return;

  if (pointer.mode === "creating") {
    if (
      !selection ||
      selection.w * view.sx < MIN_SELECTION_CSS ||
      selection.h * view.sy < MIN_SELECTION_CSS
    ) {
      selection = null;
      pointer.mode = "idle";
      pointer.handle = null;
      pointer.originSel = null;
      root.dataset.mode = "idle";
      api.close();
      return;
    }
  } else if (pointer.mode === "drawing" && pointer.draft) {
    if (draftIsValid(pointer.draft)) {
      pushHistory();
      annotations.push(pointer.draft);
      selectedIndex = -1;
    }
    pointer.draft = null;
    annoDirty = true;
  } else if (pointer.mode === "annoMove" || pointer.mode === "annoResize") {
    finishAnnoDrag();
  }

  pointer.mode = "idle";
  pointer.handle = null;
  pointer.originSel = null;
  root.dataset.mode = longMode ? "idle" : "idle";
  render();
}

function normalizeRect(x0, y0, x1, y1) {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return {
    x: clamp(x, 0, natW),
    y: clamp(y, 0, natH),
    w: clamp(Math.abs(x1 - x0), 0, natW - x),
    h: clamp(Math.abs(y1 - y0), 0, natH - y),
  };
}

function resizeSelection(o, handle, p) {
  let left = o.x;
  let top = o.y;
  let right = o.x + o.w;
  let bottom = o.y + o.h;
  if (handle.includes("w")) left = clamp(p.x, 0, natW);
  if (handle.includes("e")) right = clamp(p.x, 0, natW);
  if (handle.includes("n")) top = clamp(p.y, 0, natH);
  if (handle.includes("s")) bottom = clamp(p.y, 0, natH);
  return normalizeRect(left, top, right, bottom);
}

/* --------------------------- 标注草稿 --------------------------- */

function startAnnotationDraw(p) {
  // 文字 / 表情是点击放置，不走拖拽草稿。
  if (activeTool === "text") {
    openTextEditorAt(p);
    return true;
  }
  if (activeTool === "emoji") {
    placeEmojiAt(p);
    return true;
  }
  pointer.mode = "drawing";
  pointer.draft = startDraft(activeTool, p);
  root.dataset.mode = "drawing";
  render();
  return true;
}

function startDraft(tool, p) {
  const s = toolSettings[tool];
  if (tool === "pen") {
    return { tool, color: s.color, weight: s.weight, points: [{ x: p.x, y: p.y }] };
  }
  if (tool === "mosaic") {
    return { tool, size: s.size, points: [{ x: p.x, y: p.y }] };
  }
  return { tool, color: s.color, weight: s.weight, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
}

function updateDraft(draft, p) {
  if (!draft) return;
  if (draft.tool === "pen" || draft.tool === "mosaic") {
    draft.points.push({ x: p.x, y: p.y });
  } else {
    draft.x1 = p.x;
    draft.y1 = p.y;
  }
}

function draftIsValid(draft) {
  if (draft.tool === "mosaic") return draft.points.length >= 1; // 单击也打一块
  if (draft.tool === "pen") return draft.points.length > 1;
  const w = Math.abs(draft.x1 - draft.x0);
  const h = Math.abs(draft.y1 - draft.y0);
  return w * view.sx > 2 || h * view.sy > 2;
}

/* --------------------------- 渲染 --------------------------- */

function render() {
  if (!imageReady) return;

  const hasSel = !!(selection && selection.w > 0 && selection.h > 0);
  root.dataset.hasSelection = hasSel ? "true" : "false";
  const dragging =
    pointer.mode === "creating" || pointer.mode === "moving" || pointer.mode === "resizing";

  if (hasSel) {
    const l = vx(selection.x);
    const t = vy(selection.y);
    const w = selection.w * view.sx;
    const h = selection.h * view.sy;
    selEl.hidden = false;
    selEl.style.transform = `translate(${l}px, ${t}px)`;
    selEl.style.width = `${w}px`;
    selEl.style.height = `${h}px`;
    setBox(maskTop, 0, 0, viewW, t);
    setBox(maskBottom, 0, t + h, viewW, Math.max(0, viewH - t - h));
    setBox(maskLeft, 0, t, l, h);
    setBox(maskRight, l + w, t, Math.max(0, viewW - l - w), h);
    sizeTag.textContent = `${Math.round(selection.w)} × ${Math.round(selection.h)}`;
    selEl.dataset.tag = t < 26 ? "inside" : "outside";
  } else {
    selEl.hidden = true;
  }

  // 译文层可见性。
  trans.hidden = !(transVisible && transLayer);

  if (annoDirty || pointer.mode === "drawing" || pointer.mode === "annoMove" || pointer.mode === "annoResize") {
    annoDirty = false;
    drawAnnotations();
  }

  positionToolbar(hasSel && !dragging);
  positionTransUi();
  if (ocrLayout && ocrBoxes.childElementCount) repositionOcrBoxes();
  if (!dragging && pointer.mode !== "drawing") syncToolbar();
}

function repositionOcrBoxes() {
  if (!ocrLayout || !selection) return;
  const sx = selection.x;
  const sy = selection.y;
  const els = ocrBoxes.children;
  const lines = ocrLayout.lines;
  for (let i = 0; i < els.length && i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.box) continue;
    const ix = ln.box.x + sx;
    const iy = ln.box.y + sy;
    els[i].style.left = `${vx(ix)}px`;
    els[i].style.top = `${vy(iy)}px`;
    els[i].style.width = `${ln.box.width * view.sx}px`;
    els[i].style.height = `${ln.box.height * view.sy}px`;
  }
}

function setBox(el, x, y, w, h) {
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
}

function drawAnnotations() {
  octx.clearRect(0, 0, natW, natH);
  const list = pointer.draft ? annotations.concat(pointer.draft) : annotations;
  for (const a of list) drawOne(octx, a, baseImage, false);
  // 选中标注的虚线框 + 控制点。
  if (selectedIndex >= 0 && selectedIndex < annotations.length && pointer.mode !== "drawing") {
    drawSelectionChrome(octx, annotations[selectedIndex]);
  }
}

function strokeWidthFor(a) {
  const base = STROKE_W[a.weight || 0] || STROKE_W[0];
  return Math.max(1, base / avgScale());
}

function drawOne(ctx, a, base, forExport) {
  ctx.save();
  if (a.tool === "rect" || a.tool === "ellipse" || a.tool === "arrow" || a.tool === "pen") {
    const lw = strokeWidthFor(a);
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (a.tool === "rect") {
      const r = normalizeRect(a.x0, a.y0, a.x1, a.y1);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    } else if (a.tool === "ellipse") {
      const r = normalizeRect(a.x0, a.y0, a.x1, a.y1);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.tool === "arrow") {
      drawArrow(ctx, a.x0, a.y0, a.x1, a.y1, lw);
    } else if (a.tool === "pen") {
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
      ctx.stroke();
    }
  } else if (a.tool === "mosaic") {
    drawMosaic(ctx, a, base || baseImage);
  } else if (a.tool === "text") {
    drawText(ctx, a);
  } else if (a.tool === "emoji") {
    drawEmoji(ctx, a);
  }
  ctx.restore();
}

function drawArrow(ctx, x0, y0, x1, y1, lw) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.max(12, lw * 4.5);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 7), y1 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 7), y1 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

// 绘制函数分派到各自实现。
function drawMosaic(ctx, a, base) {
  smearMosaic(ctx, a, base);
}
function drawText(ctx, a) {
  renderTextAnno(ctx, a);
}
function drawEmoji(ctx, a) {
  renderEmojiAnno(ctx, a);
}
function drawSelectionChrome(ctx, a) {
  const s = avgScale();
  const dash = 4 / s;
  ctx.save();
  ctx.strokeStyle = "rgba(7,193,96,0.95)";
  ctx.lineWidth = Math.max(1, 1.2 / s);
  ctx.setLineDash([dash, dash]);
  const b = annoBBox(a);
  const pad = 4 / s;
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  // 控制点。
  const hs = 5 / s;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#07c160";
  ctx.lineWidth = Math.max(1, 1.2 / s);
  for (const h of getAnnoHandles(a)) {
    ctx.beginPath();
    ctx.rect(h.x - hs, h.y - hs, hs * 2, hs * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* 标注包围盒（图片像素坐标）。 */
function annoBBox(a) {
  if (a.tool === "rect" || a.tool === "ellipse" || a.tool === "arrow") {
    return normalizeRect(a.x0, a.y0, a.x1, a.y1);
  }
  if (a.tool === "pen" || a.tool === "mosaic") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of a.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    const pad = a.tool === "mosaic" ? (MOSAIC_RADIUS[a.size || 0] || 10) / avgScale() : strokeWidthFor(a);
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (a.tool === "text") {
    const m = measureTextAnno(a);
    return { x: a.x, y: a.y, w: m.w, h: m.h };
  }
  if (a.tool === "emoji") {
    const sz = a.sizePx;
    return { x: a.cx - sz / 2, y: a.cy - sz / 2, w: sz, h: sz };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

/* 选中标注的控制点（图片坐标）。 */
function getAnnoHandles(a) {
  if (a.tool === "arrow") {
    return [
      { name: "p0", x: a.x0, y: a.y0 },
      { name: "p1", x: a.x1, y: a.y1 },
    ];
  }
  if (a.tool === "pen" || a.tool === "mosaic") return [];
  const b = annoBBox(a);
  if (a.tool === "text" || a.tool === "emoji") {
    return [
      { name: "nw", x: b.x, y: b.y },
      { name: "ne", x: b.x + b.w, y: b.y },
      { name: "se", x: b.x + b.w, y: b.y + b.h },
      { name: "sw", x: b.x, y: b.y + b.h },
    ];
  }
  // rect / ellipse：8 个。
  return [
    { name: "nw", x: b.x, y: b.y },
    { name: "n", x: b.x + b.w / 2, y: b.y },
    { name: "ne", x: b.x + b.w, y: b.y },
    { name: "e", x: b.x + b.w, y: b.y + b.h / 2 },
    { name: "se", x: b.x + b.w, y: b.y + b.h },
    { name: "s", x: b.x + b.w / 2, y: b.y + b.h },
    { name: "sw", x: b.x, y: b.y + b.h },
    { name: "w", x: b.x, y: b.y + b.h / 2 },
  ];
}

/* 命中检测：返回被命中的标注下标；-1 无。顶层优先。 */
function hitTestAnno(p) {
  const tol = 6 / avgScale();
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (annoHit(annotations[i], p, tol)) return i;
  }
  return -1;
}

function annoHit(a, p, tol) {
  if (a.tool === "rect") {
    const r = normalizeRect(a.x0, a.y0, a.x1, a.y1);
    return nearRectStroke(r, p, tol);
  }
  if (a.tool === "ellipse") {
    const r = normalizeRect(a.x0, a.y0, a.x1, a.y1);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rx = r.w / 2, ry = r.h / 2;
    if (rx < 1 || ry < 1) return false;
    const d = Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
    return d * Math.min(rx, ry) < tol + 2 / avgScale();
  }
  if (a.tool === "arrow") {
    return distToSeg(p, { x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 }) < tol + strokeWidthFor(a);
  }
  if (a.tool === "pen") {
    for (let i = 1; i < a.points.length; i++) {
      if (distToSeg(p, a.points[i - 1], a.points[i]) < tol + strokeWidthFor(a)) return true;
    }
    return false;
  }
  if (a.tool === "mosaic") {
    // 只有真正涂到的笔迹才算命中，而不是整个包围盒。
    const r = tol + (MOSAIC_RADIUS[a.size || 0] || 10) / avgScale();
    if (a.points.length === 1) return Math.hypot(p.x - a.points[0].x, p.y - a.points[0].y) < r;
    for (let i = 1; i < a.points.length; i++) {
      if (distToSeg(p, a.points[i - 1], a.points[i]) < r) return true;
    }
    return false;
  }
  // text / emoji：包围盒内。
  const b = annoBBox(a);
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

function nearRectStroke(r, p, tol) {
  const insideOuter =
    p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
  if (!insideOuter) return false;
  const insideInner =
    p.x > r.x + tol && p.x < r.x + r.w - tol && p.y > r.y + tol && p.y < r.y + r.h - tol;
  return !insideInner;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* 指针按下：命中已完成标注的控制点或本体。 */
function handleAnnoPointerDown(ev, p) {
  // 马赛克是涂抹工具：按下就涂，不去选中或拖动已有标注。
  if (activeTool === "mosaic") return false;
  // 绘制工具激活且落在选区内空白处时，交给绘制逻辑（返回 false）。
  // 先检查当前选中标注的控制点（更易抓取）。
  const handleTol = 8 / avgScale();
  if (selectedIndex >= 0 && selectedIndex < annotations.length) {
    const a = annotations[selectedIndex];
    for (const h of getAnnoHandles(a)) {
      if (Math.hypot(p.x - h.x, p.y - h.y) < handleTol) {
        pointer.mode = "annoResize";
        pointer.handle = h.name;
        pointer.annoOrigin = JSON.parse(JSON.stringify(a));
        pointer.preSnapshot = snapshotAnnos();
        pointer.moved = false;
        root.dataset.mode = "dragging";
        return true;
      }
    }
  }

  // 命中标注本体 → 选中并准备移动。
  const idx = hitTestAnno(p);
  if (idx >= 0) {
    selectedIndex = idx;
    const a = annotations[idx];
    pointer.mode = "annoMove";
    pointer.annoOrigin = JSON.parse(JSON.stringify(a));
    pointer.preSnapshot = snapshotAnnos();
    pointer.startX = p.x;
    pointer.startY = p.y;
    pointer.moved = false;
    root.dataset.mode = "dragging";
    annoDirty = true;
    render();
    return true;
  }

  // 没命中任何标注：若之前有选中则取消选中（但不拦截后续逻辑）。
  if (selectedIndex >= 0 && !activeTool) {
    selectedIndex = -1;
    annoDirty = true;
    render();
  }
  return false;
}

function handleAnnoPointerMove(p) {
  if (selectedIndex < 0) return;
  const a = annotations[selectedIndex];
  const o = pointer.annoOrigin;
  pointer.moved = true;
  if (pointer.mode === "annoMove") {
    const dx = p.x - pointer.startX;
    const dy = p.y - pointer.startY;
    translateAnno(a, o, dx, dy);
  } else if (pointer.mode === "annoResize") {
    resizeAnno(a, o, pointer.handle, p);
  }
  annoDirty = true;
  render();
}

function finishAnnoDrag() {
  if (pointer.moved && pointer.preSnapshot != null) {
    // 把拖动前快照压入历史（替换当前，因为拖动过程只记一次）。
    history.push(pointer.preSnapshot);
    if (history.length > 120) history.shift();
  }
  pointer.annoOrigin = null;
  pointer.preSnapshot = null;
  pointer.moved = false;
  syncToolbar();
}

function translateAnno(a, o, dx, dy) {
  if (a.tool === "rect" || a.tool === "ellipse" || a.tool === "arrow") {
    a.x0 = o.x0 + dx; a.y0 = o.y0 + dy;
    a.x1 = o.x1 + dx; a.y1 = o.y1 + dy;
  } else if (a.tool === "pen" || a.tool === "mosaic") {
    a.points = o.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
  } else if (a.tool === "text") {
    a.x = o.x + dx; a.y = o.y + dy;
  } else if (a.tool === "emoji") {
    a.cx = o.cx + dx; a.cy = o.cy + dy;
  }
}

function resizeAnno(a, o, handle, p) {
  if (a.tool === "arrow") {
    if (handle === "p0") { a.x0 = clamp(p.x, 0, natW); a.y0 = clamp(p.y, 0, natH); }
    else { a.x1 = clamp(p.x, 0, natW); a.y1 = clamp(p.y, 0, natH); }
    return;
  }
  if (a.tool === "rect" || a.tool === "ellipse") {
    const r0 = normalizeRect(o.x0, o.y0, o.x1, o.y1);
    const r = resizeSelection(r0, handle, p);
    a.x0 = r.x; a.y0 = r.y; a.x1 = r.x + r.w; a.y1 = r.y + r.h;
    return;
  }
  if (a.tool === "text" || a.tool === "emoji") {
    // 以对角为锚点等比缩放。
    const b0 = annoBBox(o.tool === "text" ? o : o);
    const box = (o.tool === "text")
      ? { x: o.x, y: o.y, w: measureTextAnno(o).w, h: measureTextAnno(o).h }
      : { x: o.cx - o.sizePx / 2, y: o.cy - o.sizePx / 2, w: o.sizePx, h: o.sizePx };
    // 锚点 = 与拖动角相对的角。
    const anchor = {
      x: handle.includes("w") ? box.x + box.w : box.x,
      y: handle.includes("n") ? box.y + box.h : box.y,
    };
    const newW = Math.abs(p.x - anchor.x);
    const newH = Math.abs(p.y - anchor.y);
    const scale = Math.max(newW / box.w, newH / box.h);
    if (a.tool === "text") {
      const minFont = 8, maxFont = 400;
      a.fontPx = clamp((o.fontPx || 24) * scale, minFont, maxFont);
      const m = measureTextAnno(a);
      // 保持锚角固定。
      a.x = handle.includes("w") ? anchor.x - m.w : anchor.x;
      a.y = handle.includes("n") ? anchor.y - m.h : anchor.y;
    } else {
      const minSz = 16, maxSz = 800;
      a.sizePx = clamp((o.sizePx || 48) * scale, minSz, maxSz);
      const nx = handle.includes("w") ? anchor.x - a.sizePx : anchor.x;
      const ny = handle.includes("n") ? anchor.y - a.sizePx : anchor.y;
      a.cx = nx + a.sizePx / 2;
      a.cy = ny + a.sizePx / 2;
    }
    void b0;
  }
}

/* --------------------------- 工具栏定位（右对齐选区） --------------------------- */

function positionToolbar(hasSel) {
  if (!hasSel && !longMode) {
    toolbar.hidden = true;
    subbar.hidden = true;
    return;
  }
  toolbar.hidden = false;

  const tbW = toolbar.offsetWidth;
  const tbH = toolbar.offsetHeight;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let selLeft, selRight, selTop, selBottom;
  if (longMode) {
    // 长图模式：工具栏贴视口底部居中。
    selLeft = view.ox;
    selRight = view.ox + natW * view.sx;
    selTop = view.oy;
    selBottom = Math.min(vh, view.oy + natH * view.sy);
  } else {
    selLeft = vx(selection.x);
    selRight = vx(selection.x + selection.w);
    selTop = vy(selection.y);
    selBottom = vy(selection.y + selection.h);
  }

  // 水平：右边缘与选区右边缘对齐，放不下再贴边。
  let left = selRight - tbW;
  left = clamp(left, 8, vw - tbW - 8);

  // 垂直：优先选区下方，不足放上方，再不足贴选区内底部。
  let top;
  if (selBottom + gap + tbH <= vh - 4) {
    top = selBottom + gap;
  } else if (selTop - gap - tbH >= 4) {
    top = selTop - gap - tbH;
  } else {
    top = clamp(selBottom - tbH - gap, 4, vh - tbH - 4);
  }
  if (longMode) {
    // 长图模式强制贴底部居中。
    left = clamp((vw - tbW) / 2, 8, vw - tbW - 8);
    top = vh - tbH - 14;
  }

  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  toolbar.dataset.left = String(left);
  toolbar.dataset.top = String(top);
  toolbar.dataset.h = String(tbH);
  positionSubbar();
}

function positionSubbar() {
  if (subbar.hidden) return;
  const left = parseFloat(toolbar.dataset.left || "0");
  const top = parseFloat(toolbar.dataset.top || "0");
  const tbH = parseFloat(toolbar.dataset.h || "40");
  const sbW = subbar.offsetWidth;
  const sbH = subbar.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 紧贴主工具栏下方，左对齐主工具栏（放不下回收）。
  let sl = left;
  sl = clamp(sl, 8, vw - sbW - 8);
  let st = top + tbH + 8;
  if (st + sbH > vh - 4) {
    // 放到主工具栏上方。
    st = top - 8 - sbH;
  }
  subbar.style.left = `${sl}px`;
  subbar.style.top = `${st}px`;

  // 小三角指向当前工具按钮。
  const toolBtn = document.querySelector(`#tools .tb-btn[data-tool="${activeTool}"]`);
  if (toolBtn && st > top) {
    const r = toolBtn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    subArrow.style.left = `${clamp(cx - sl - 6, 8, sbW - 20)}px`;
    subArrow.style.display = "block";
  } else {
    subArrow.style.display = "none";
  }
}

/* --------------------------- 导出 --------------------------- */

async function exportSelectionPng(opts) {
  const o = opts || {};
  const withAnno = o.annotations !== false;
  const withTrans = o.translation !== false;
  if (!selection || selection.w < 1 || selection.h < 1) return null;
  const w = Math.max(1, Math.round(selection.w));
  const h = Math.max(1, Math.round(selection.h));
  const sx = Math.round(selection.x);
  const sy = Math.round(selection.y);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");

  // 1) 原图。
  ctx.drawImage(baseImage, sx, sy, w, h, 0, 0, w, h);
  // 2) 译文层。
  if (withTrans && transVisible && transLayer) {
    ctx.save();
    ctx.translate(-sx, -sy);
    ctx.drawImage(trans, 0, 0);
    ctx.restore();
  }
  // 3) 标注层。
  if (withAnno) {
    ctx.save();
    ctx.translate(-sx, -sy);
    for (const a of annotations) drawOne(ctx, a, baseImage, true);
    ctx.restore();
  }
  return out.toDataURL("image/png");
}

/* --------------------------- 复制 / 保存 / 钉图 --------------------------- */

async function doCopy() {
  const url = await exportSelectionPng();
  if (!url) return false;
  try {
    const ok = await api.copyImage(url);
    if (ok !== false) showToast("已复制到剪贴板");
    return ok !== false;
  } catch (err) {
    showToast("复制失败：" + messageOf(err));
    return false;
  }
}

async function doSave() {
  const url = await exportSelectionPng();
  if (!url) return;
  try {
    const result = await api.saveImage(url);
    if (result) showToast("已保存");
  } catch (err) {
    showToast("保存失败：" + messageOf(err));
  }
}

async function doPin() {
  const url = await exportSelectionPng();
  if (!url || !selection) return;
  if (typeof api.pin !== "function") {
    showToast("当前版本不支持钉图");
    return;
  }
  try {
    const payload = longMode
      ? { dataUrl: url, x: 0, y: 0, width: Math.round(selection.w), height: Math.round(selection.h) }
      : {
          dataUrl: url,
          x: Math.round(selection.x),
          y: Math.round(selection.y),
          width: Math.round(selection.w),
          height: Math.round(selection.h),
        };
    await api.pin(payload);
    // 主进程负责关闭覆盖层。
  } catch (err) {
    showToast("钉图失败：" + messageOf(err));
  }
}

/* --------------------------- 文字标注编辑 --------------------------- */

function openTextEditorAt(p) {
  // 开始一个新文字标注的编辑。
  startTextEditing(null, p);
}

// 双击已完成文字标注 → 重新编辑。
root.addEventListener("dblclick", (ev) => {
  if (!imageReady) return;
  const p = toImageCoords(ev);
  const idx = hitTestAnno(p);
  if (idx >= 0 && annotations[idx].tool === "text") {
    selectedIndex = idx;
    startTextEditing(idx, null);
  }
});

let editingTextIndex = -1; // >=0 表示在编辑已有标注
function startTextEditing(index, p) {
  commitTextEditor();
  const s = toolSettings.text;
  let a;
  if (index != null && index >= 0) {
    a = annotations[index];
    editingTextIndex = index;
    // 编辑时临时从标注数组移除以免重复绘制，提交时放回。
    textEditor.dataset.color = a.color;
    textEditor.dataset.fontPx = String(a.fontPx);
    textEditor.value = a.text;
    textEditor.dataset.ix = String(a.x);
    textEditor.dataset.iy = String(a.y);
    annotations.splice(index, 1);
    selectedIndex = -1;
    annoDirty = true;
    render();
  } else {
    editingTextIndex = -1;
    const fontPx = FONT_SIZE[s.font] / avgScale();
    textEditor.dataset.color = s.color;
    textEditor.dataset.fontPx = String(fontPx);
    textEditor.value = "";
    textEditor.dataset.ix = String(p.x);
    textEditor.dataset.iy = String(p.y);
  }
  // 定位编辑框（CSS 像素）。
  layoutTextEditor();
  textEditor.hidden = false;
  textEditor.dataset.editing = "true";
  requestAnimationFrame(() => {
    textEditor.focus();
    const len = textEditor.value.length;
    textEditor.setSelectionRange(len, len);
    autoGrowEditor();
  });
}

function layoutTextEditor() {
  const ix = parseFloat(textEditor.dataset.ix || "0");
  const iy = parseFloat(textEditor.dataset.iy || "0");
  const fontPx = parseFloat(textEditor.dataset.fontPx || "24");
  const cssFont = fontPx * avgScale();
  textEditor.style.left = `${vx(ix)}px`;
  textEditor.style.top = `${vy(iy)}px`;
  textEditor.style.fontSize = `${cssFont}px`;
  textEditor.style.color = textEditor.dataset.color || "#f5222d";
  textEditor.style.maxWidth = `${Math.max(60, viewW - vx(ix) - 20)}px`;
}

function autoGrowEditor() {
  textEditor.style.width = "auto";
  textEditor.style.height = "auto";
  textEditor.style.width = `${Math.min(textEditor.scrollWidth + 4, viewW - vx(parseFloat(textEditor.dataset.ix || "0")) - 16)}px`;
  textEditor.style.height = `${textEditor.scrollHeight}px`;
}

textEditor.addEventListener("input", autoGrowEditor);
textEditor.addEventListener("pointerdown", (e) => e.stopPropagation());
textEditor.addEventListener("blur", () => {
  if (textEditor.dataset.editing === "true") commitTextEditor();
});

function commitTextEditor() {
  if (textEditor.hidden || textEditor.dataset.editing !== "true") return;
  textEditor.dataset.editing = "";
  const text = textEditor.value.replace(/\s+$/g, "");
  const ix = parseFloat(textEditor.dataset.ix || "0");
  const iy = parseFloat(textEditor.dataset.iy || "0");
  const fontPx = parseFloat(textEditor.dataset.fontPx || "24");
  const color = textEditor.dataset.color || "#f5222d";
  textEditor.hidden = true;
  textEditor.value = "";

  if (text.trim() === "") {
    // 空文本丢弃；若在编辑已有标注则等于删除它。
    if (editingTextIndex >= 0) {
      pushHistory();
    }
    editingTextIndex = -1;
    annoDirty = true;
    render();
    return;
  }

  pushHistory();
  const annoObj = { tool: "text", text, x: ix, y: iy, fontPx, color };
  annotations.push(annoObj);
  editingTextIndex = -1;
  selectedIndex = annotations.length - 1;
  annoDirty = true;
  render();
}

function measureTextAnno(a) {
  const lines = String(a.text).split("\n");
  octx.save();
  octx.font = `${a.fontPx}px "Segoe UI","Microsoft YaHei",sans-serif`;
  let maxW = 0;
  for (const ln of lines) {
    const w = octx.measureText(ln || " ").width;
    if (w > maxW) maxW = w;
  }
  octx.restore();
  const lineH = a.fontPx * 1.25;
  const padX = 4, padY = 2;
  return { w: maxW + padX * 2, h: lineH * lines.length + padY * 2, lineH, padX, padY };
}

function renderTextAnno(ctx, a) {
  const m = measureTextAnno(a);
  const lines = String(a.text).split("\n");
  ctx.save();
  ctx.font = `${a.fontPx}px "Segoe UI","Microsoft YaHei",sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillStyle = a.color;
  let y = a.y + m.padY;
  for (const ln of lines) {
    ctx.fillText(ln, a.x + m.padX, y);
    y += m.lineH;
  }
  ctx.restore();
}

function placeEmojiAt(p) {
  const s = toolSettings.emoji;
  const sizePx = EMOJI_SIZE[s.size] / avgScale();
  pushHistory();
  const a = { tool: "emoji", char: s.char, cx: p.x, cy: p.y, sizePx };
  annotations.push(a);
  selectedIndex = annotations.length - 1;
  annoDirty = true;
  render();
}

function renderEmojiAnno(ctx, a) {
  ctx.save();
  ctx.font = `${a.sizePx}px "Segoe UI Emoji","Apple Color Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(a.char, a.cx, a.cy);
  ctx.restore();
}
// 马赛克底图缓存：整幅底图按块大小像素化一次，网格固定对齐图片原点，
// 这样涂抹过程中已涂区域不会因包围盒变化而跳动。底图更换时置空。
let mosaicCache = null; // { block, canvas }

function mosaicSource(src, block) {
  if (mosaicCache && mosaicCache.block === block) return mosaicCache.canvas;
  const sw = Math.max(1, Math.ceil(natW / block));
  const sh = Math.max(1, Math.ceil(natH / block));
  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const smc = small.getContext("2d");
  // 缩小时开平滑，每块取的是区域平均色，而不是某一个像素。
  smc.imageSmoothingEnabled = true;
  smc.imageSmoothingQuality = "high";
  smc.drawImage(src, 0, 0, sw * block, sh * block, 0, 0, sw, sh);
  const full = document.createElement("canvas");
  full.width = natW;
  full.height = natH;
  const fc = full.getContext("2d");
  fc.imageSmoothingEnabled = false;
  fc.drawImage(small, 0, 0, sw, sh, 0, 0, sw * block, sh * block);
  mosaicCache = { block, canvas: full };
  return full;
}

function smearMosaic(ctx, a, base) {
  // 涂抹式马赛克：鼠标经过的地方（笔刷宽度内）显示像素化底图。
  if (!a.points || a.points.length === 0) return;
  const src = base || baseImage;
  if (!src) return;
  const block = Math.max(2, Math.round((MOSAIC_BLOCK[a.size || 0] || 12) / avgScale()));
  const radius = Math.max(2, (MOSAIC_RADIUS[a.size || 0] || 10) / avgScale());
  const pixelated = mosaicSource(src, block);

  const b = annoBBox(a);
  const bx = clamp(Math.floor(b.x - radius), 0, natW);
  const by = clamp(Math.floor(b.y - radius), 0, natH);
  const bw = clamp(Math.ceil(b.w + radius * 2) + 1, 1, natW - bx);
  const bh = clamp(Math.ceil(b.h + radius * 2) + 1, 1, natH - by);
  if (bw < 1 || bh < 1) return;

  // 先把笔刷轨迹画成蒙版（圆头粗线），再只保留蒙版内的像素化内容。
  const mask = document.createElement("canvas");
  mask.width = bw;
  mask.height = bh;
  const mc = mask.getContext("2d");
  mc.translate(-bx, -by);
  mc.fillStyle = "#000";
  mc.strokeStyle = "#000";
  mc.lineWidth = radius * 2;
  mc.lineCap = "round";
  mc.lineJoin = "round";
  const pts = a.points;
  if (pts.length === 1) {
    mc.beginPath();
    mc.arc(pts[0].x, pts[0].y, radius, 0, Math.PI * 2);
    mc.fill();
  } else {
    mc.beginPath();
    mc.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) mc.lineTo(pts[i].x, pts[i].y);
    mc.stroke();
  }
  mc.globalCompositeOperation = "source-in";
  mc.imageSmoothingEnabled = false;
  mc.drawImage(pixelated, bx, by, bw, bh, bx, by, bw, bh);

  ctx.drawImage(mask, bx, by);
}

function clearTranslation() {
  transLayer = null;
  transVisible = false;
  transToggle.hidden = true;
  trans.hidden = true;
  if (natW && natH) tctx.clearRect(0, 0, natW, natH);
}
function setTransView(showDst) {
  transVisible = showDst;
  trans.hidden = !(transVisible && transLayer);
  for (const btn of transToggle.querySelectorAll(".seg button")) {
    btn.setAttribute("aria-pressed", (btn.dataset.trans === "dst") === showDst ? "true" : "false");
  }
  syncToolbar();
}
async function toggleTranslate() {
  if (busy || translating) return;
  // 已显示译文 → 关闭译文层。
  if (transVisible && transLayer) {
    transVisible = false;
    trans.hidden = true;
    syncToolbar();
    render();
    return;
  }
  // 已有缓存译文层（之前关过）→ 直接显示。
  if (transLayer) {
    transVisible = true;
    trans.hidden = false;
    transToggle.hidden = false;
    setTransView(true);
    render();
    return;
  }
  if (!selection) return;
  if (typeof api.ocrLayout !== "function" || typeof api.translateBatch !== "function") {
    showToast("当前版本不支持原位翻译");
    return;
  }

  const version = selectionVersion;
  const url = await exportSelectionPng({ annotations: false, translation: false });
  if (!url) return;

  translating = true;
  busy = true;
  setBtnBusy("translate", true);
  showTransLoading(true);
  try {
    const layout = await api.ocrLayout(url);
    if (version !== selectionVersion) return;
    const lines = (layout && layout.lines) || [];
    if (lines.length === 0) {
      showToast("未识别到文字");
      return;
    }
    const paragraphs = mergeLines(lines);
    const res = await api.translateBatch(paragraphs.map((p) => p.text));
    if (version !== selectionVersion) return;
    const translations = (res && res.translations) || [];
    buildTransLayer(paragraphs, translations);
    transLayer.info = {
      src: (res && res.sourceLanguage) || "auto",
      dst: (res && res.targetLanguage) || "zh",
      provider: (res && res.provider) || "",
    };
    transVisible = true;
    trans.hidden = false;
    transToggle.hidden = false;
    setTransView(true);
    render();
  } catch (err) {
    if (version !== selectionVersion) return;
    showToast("翻译失败：" + messageOf(err));
  } finally {
    translating = false;
    busy = false;
    setBtnBusy("translate", false);
    showTransLoading(false);
    syncToolbar();
  }
}

function setBtnBusy(id, on) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.classList.toggle("busy", on);
  btn.disabled = on;
}

function showTransLoading(on) {
  if (!on || !selection) {
    transLoading.hidden = true;
    return;
  }
  transLoading.hidden = false;
  const cx = vx(selection.x + selection.w / 2);
  const cy = vy(selection.y + selection.h / 2);
  transLoading.style.left = `${cx}px`;
  transLoading.style.top = `${cy}px`;
}

/* 相邻行合并成段落。box 为选区图片像素坐标，这里转成原图坐标。 */
function mergeLines(lines) {
  const sx = selection.x;
  const sy = selection.y;
  // 转原图坐标并按纵向排序。
  const items = lines
    .filter((l) => l && l.box && String(l.text || "").trim() !== "")
    .map((l) => ({
      text: String(l.text).trim(),
      x: l.box.x + sx,
      y: l.box.y + sy,
      w: l.box.width,
      h: l.box.height,
    }))
    .sort((a, b) => a.y - b.y);

  const paras = [];
  let cur = null;
  for (const it of items) {
    if (!cur) {
      cur = startPara(it);
      continue;
    }
    const prev = cur.lines[cur.lines.length - 1];
    const lineH = (prev.h + it.h) / 2;
    const gap = it.y - (prev.y + prev.h);
    const leftClose = Math.abs(it.x - cur.x) < Math.max(prev.h, it.h) * 1.2;
    const heightClose = Math.abs(it.h - prev.h) < Math.max(prev.h, it.h) * 0.5;
    if (gap < lineH * 0.8 && leftClose && heightClose) {
      cur.lines.push(it);
      cur.x = Math.min(cur.x, it.x);
      cur.y = Math.min(cur.y, it.y);
      cur.right = Math.max(cur.right, it.x + it.w);
      cur.bottom = Math.max(cur.bottom, it.y + it.h);
    } else {
      paras.push(finishPara(cur));
      cur = startPara(it);
    }
  }
  if (cur) paras.push(finishPara(cur));
  return paras;
}

function startPara(it) {
  return {
    lines: [it],
    x: it.x,
    y: it.y,
    right: it.x + it.w,
    bottom: it.y + it.h,
  };
}

function finishPara(cur) {
  const box = {
    x: cur.x,
    y: cur.y,
    width: cur.right - cur.x,
    height: cur.bottom - cur.y,
  };
  // CJK 直接拼接，拉丁文用空格。
  const texts = cur.lines.map((l) => l.text);
  const isCJK = /[\u3040-\u9fff\uac00-\ud7a3]/.test(texts.join(""));
  const text = isCJK ? texts.join("") : texts.join(" ");
  const lineH = cur.lines.reduce((s, l) => s + l.h, 0) / cur.lines.length;
  return { box, text, lineH };
}

/* 把译文绘制到 trans 画布（原图像素坐标）。 */
function buildTransLayer(paragraphs, translations) {
  transLayer = { paragraphs: [] };
  tctx.clearRect(0, 0, natW, natH);
  // 需要从底图采样，先确保底图可读。
  const sctxData = sctx;
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const text = translations[i] != null ? String(translations[i]) : "";
    if (text.trim() === "") continue;
    const box = {
      x: Math.round(para.box.x),
      y: Math.round(para.box.y),
      width: Math.max(1, Math.round(para.box.width)),
      height: Math.max(1, Math.round(para.box.height)),
    };
    const colors = sampleBoxColors(sctxData, box);
    paintParagraph(box, text, para.lineH, colors);
    transLayer.paragraphs.push({ box, text });
  }
}

/* 采样框外缘一圈 + 框内，得到背景色与文字色。 */
function sampleBoxColors(ctx, box) {
  const pad = 2;
  const x0 = clamp(box.x - pad, 0, natW - 1);
  const y0 = clamp(box.y - pad, 0, natH - 1);
  const x1 = clamp(box.x + box.width + pad, 1, natW);
  const y1 = clamp(box.y + box.height + pad, 1, natH);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  let data;
  try {
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch {
    return { bg: [255, 255, 255], fg: [0, 0, 0] };
  }
  // 外缘一圈像素做背景中位数。
  const edge = [];
  const push = (px, py) => {
    const idx = (py * w + px) * 4;
    edge.push([data[idx], data[idx + 1], data[idx + 2]]);
  };
  for (let px = 0; px < w; px++) {
    push(px, 0);
    push(px, h - 1);
  }
  for (let py = 0; py < h; py++) {
    push(0, py);
    push(w - 1, py);
  }
  const bg = medianColor(edge);
  // 框内与背景差异最大的像素作为文字色。
  let best = null, bestDist = -1;
  const step = Math.max(1, Math.floor((w * h) / 4000));
  for (let p = 0; p < w * h; p += step) {
    const idx = p * 4;
    const c = [data[idx], data[idx + 1], data[idx + 2]];
    const d = colorDist(c, bg);
    if (d > bestDist) { bestDist = d; best = c; }
  }
  // 若差异过小则按背景亮度选黑/白。
  let fg;
  if (!best || bestDist < 40) {
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    fg = lum > 140 ? [20, 20, 20] : [245, 245, 245];
  } else {
    fg = best;
  }
  return { bg, fg };
}

function medianColor(list) {
  if (list.length === 0) return [255, 255, 255];
  const r = list.map((c) => c[0]).sort((a, b) => a - b);
  const g = list.map((c) => c[1]).sort((a, b) => a - b);
  const b = list.map((c) => c[2]).sort((a, b) => a - b);
  const m = Math.floor(list.length / 2);
  return [r[m], g[m], b[m]];
}

function colorDist(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function rgb(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* 在框内绘制背景色 + 自动换行 + 二分最大字号的译文。 */
function paintParagraph(box, text, origLineH, colors) {
  // 背景填充（略扩 2px）。
  tctx.save();
  tctx.fillStyle = rgb(colors.bg);
  tctx.fillRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);

  const maxFont = Math.max(10, Math.min(box.height, (origLineH || box.height) * 0.9));
  const minFont = 10;
  const fit = fitText(text, box.width - 4, box.height - 2, maxFont, minFont);

  tctx.fillStyle = rgb(colors.fg);
  tctx.textBaseline = "top";
  tctx.font = `${fit.font}px "Microsoft YaHei","Segoe UI",sans-serif`;
  let y = box.y + 1;
  for (const ln of fit.lines) {
    if (y + fit.lineH > box.y + box.height + fit.font) break;
    tctx.fillText(ln, box.x + 1, y);
    y += fit.lineH;
  }
  tctx.restore();
}

/* 二分查找能把 text 以自动换行排进 (maxW,maxH) 的最大字号。 */
function fitText(text, maxW, maxH, maxFont, minFont) {
  let lo = minFont, hi = Math.max(minFont, Math.floor(maxFont));
  let bestLines = wrapText(text, maxW, lo);
  let bestFont = lo;
  let bestLineH = lo * 1.2;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = wrapText(text, maxW, mid);
    const lineH = mid * 1.2;
    const totalH = lines.length * lineH;
    if (totalH <= maxH) {
      bestFont = mid;
      bestLines = lines;
      bestLineH = lineH;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { font: bestFont, lines: bestLines, lineH: bestLineH };
}

/* 按字号对 text 自动换行（CJK 逐字，拉丁按词）。 */
function wrapText(text, maxW, font) {
  tctx.save();
  tctx.font = `${font}px "Microsoft YaHei","Segoe UI",sans-serif`;
  const lines = [];
  for (const rawLine of String(text).split("\n")) {
    const tokens = tokenize(rawLine);
    let cur = "";
    for (const tk of tokens) {
      const trial = cur + tk;
      if (cur !== "" && tctx.measureText(trial).width > maxW) {
        lines.push(cur);
        cur = tk.replace(/^\s+/, "");
      } else {
        cur = trial;
      }
    }
    lines.push(cur);
  }
  tctx.restore();
  return lines.length ? lines : [""];
}

function tokenize(line) {
  const tokens = [];
  let buf = "";
  for (const ch of line) {
    if (/[\u3040-\u9fff\uac00-\ud7a3]/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ""; }
      tokens.push(ch);
    } else if (ch === " ") {
      buf += ch;
      tokens.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function positionTransUi() {
  if (transToggle.hidden) return;
  if (!selection) return;
  if (transLayer && transLayer.info) {
    const info = transLayer.info;
    transLabel.textContent = info.provider
      ? `${info.src} → ${info.dst} · ${info.provider}`
      : `${info.src} → ${info.dst}`;
  }
  // 胶囊放在选区上方居中；空间不足放选区内顶部。
  const tW = transToggle.offsetWidth;
  const tH = transToggle.offsetHeight;
  const cx = vx(selection.x + selection.w / 2);
  const selTop = vy(selection.y);
  let left = clamp(cx - tW / 2, 8, viewW - tW - 8);
  let top = selTop - tH - 8;
  if (top < 6) top = vy(selection.y) + 8;
  transToggle.style.left = `${left}px`;
  transToggle.style.top = `${top}px`;
}
async function toggleOcr() {
  if (busy) return;
  // 已显示高亮 → 关闭。
  if (ocrLayout) {
    ocrLayout = null;
    ocrBoxes.innerHTML = "";
    hidePanel();
    syncToolbar();
    return;
  }
  if (!selection) return;
  if (typeof api.ocrLayout !== "function") {
    // 退回旧版纯文本 OCR。
    return runOcrTextOnly();
  }
  const version = selectionVersion;
  const url = await exportSelectionPng({ annotations: false, translation: false });
  if (!url) return;

  busy = true;
  setBtnBusy("ocr", true);
  showPanelLoading("提取文字", "识别中…");
  try {
    const layout = await api.ocrLayout(url);
    if (version !== selectionVersion) return;
    const lines = (layout && layout.lines) || [];
    if (lines.length === 0) {
      showToast("未识别到文字");
      hidePanel();
      return;
    }
    ocrLayout = { lines };
    ocrText = (layout && layout.text) || lines.map((l) => l.text).join("\n");
    renderOcrBoxes();
    showOcrPanel(ocrText);
  } catch (err) {
    if (version !== selectionVersion) return;
    showPanelError("识别失败：" + messageOf(err));
  } finally {
    busy = false;
    setBtnBusy("ocr", false);
    syncToolbar();
  }
}

async function runOcrTextOnly() {
  const version = selectionVersion;
  const url = await exportSelectionPng({ annotations: false, translation: false });
  if (!url) return;
  busy = true;
  setBtnBusy("ocr", true);
  showPanelLoading("提取文字", "识别中…");
  try {
    const text = await api.ocr(url);
    if (version !== selectionVersion) return;
    ocrText = text || "";
    showOcrPanel(ocrText);
  } catch (err) {
    if (version !== selectionVersion) return;
    showPanelError("识别失败：" + messageOf(err));
  } finally {
    busy = false;
    setBtnBusy("ocr", false);
    syncToolbar();
  }
}

/* 把每行用半透明蓝色框画到 overlay（CSS 定位，随视图变换）。 */
function renderOcrBoxes() {
  ocrBoxes.innerHTML = "";
  if (!ocrLayout) return;
  const sx = selection.x;
  const sy = selection.y;
  ocrLayout.lines.forEach((ln) => {
    if (!ln.box) return;
    const ix = ln.box.x + sx;
    const iy = ln.box.y + sy;
    const el = document.createElement("div");
    el.className = "ocr-box";
    el.style.left = `${vx(ix)}px`;
    el.style.top = `${vy(iy)}px`;
    el.style.width = `${ln.box.width * view.sx}px`;
    el.style.height = `${ln.box.height * view.sy}px`;
    el.title = ln.text;
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", async () => {
      try {
        if (typeof api.copyText === "function") await api.copyText(ln.text);
        else if (navigator.clipboard) await navigator.clipboard.writeText(ln.text);
        showToast("已复制");
      } catch (err) {
        showToast("复制失败：" + messageOf(err));
      }
    });
    ocrBoxes.appendChild(el);
  });
}
function startLong() {
  if (longMode || !selection) return;
  if (typeof api.longStart !== "function") {
    showToast("当前版本不支持长截图");
    return;
  }
  // 先清掉工具、面板、译文、选中。
  commitTextEditor();
  activeTool = null;
  selectedIndex = -1;
  root.dataset.toolActive = "false";
  hidePanel();
  ocrLayout = null;
  ocrBoxes.innerHTML = "";
  clearTranslation();
  buildSubbar();
  render();

  const rect = {
    x: Math.round(selection.x),
    y: Math.round(selection.y),
    width: Math.round(selection.w),
    height: Math.round(selection.h),
  };
  api.longStart(rect);
}

if (typeof api.onLongResult === "function") {
  api.onLongResult((result) => {
    if (!result || !result.pixels) return;
    enterLongMode(result);
  });
}
if (typeof api.onLongCancel === "function") {
  api.onLongCancel(() => {
    // 恢复原样：什么都不变（覆盖层已由主进程恢复显示）。
  });
}

/* 进入长图编辑模式：长图作为新底图，contain 居中显示。 */
function enterLongMode(result) {
  const { pixels, width, height } = result;
  // 清空现有标注/译文/选区，用长图替换底图。
  annotations = [];
  history = [];
  selectedIndex = -1;
  activeTool = null;
  clearTranslation();
  ocrLayout = null;
  ocrBoxes.innerHTML = "";
  hidePanel();

  longMode = true;
  root.dataset.long = "true";
  root.dataset.toolActive = "false";

  natW = width;
  natH = height;
  for (const canvas of [shot, anno, trans]) {
    canvas.width = natW;
    canvas.height = natH;
  }
  try {
    const data = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    sctx.putImageData(new ImageData(data, width, height), 0, 0);
  } catch (err) {
    showToast("长图加载失败：" + messageOf(err));
    return;
  }
  octx.clearRect(0, 0, natW, natH);
  tctx.clearRect(0, 0, natW, natH);
  baseImage = shot;
  mosaicCache = null;
  imageReady = true;

  // 选区固定为整张长图。
  selection = { x: 0, y: 0, w: natW, h: natH };
  selectionVersion += 1;
  annoDirty = true;
  updateView();
  // 长图模式选区框隐藏遮罩，但要显示工具栏。
  root.dataset.hasSelection = "true";
  buildSubbar();
  render();
}

/* --------------------------- 结果面板 --------------------------- */

let currentPanel = null;
let busy = false;

function dockPanel() {
  const narrow = window.innerWidth < 760;
  let overlapsRight = false;
  if (selection) {
    const selRightCss = vx(selection.x + selection.w);
    overlapsRight = selRightCss > window.innerWidth - 380;
  }
  panel.dataset.dock = narrow || overlapsRight ? "bottom" : "right";
}

function showPanelLoading(title, text) {
  dockPanel();
  panel.hidden = false;
  panelTitle.textContent = title;
  panelLoadingText.textContent = text;
  panelLoading.hidden = false;
  panelSourceWrap.hidden = true;
  panelText.hidden = true;
  panelFoot.hidden = true;
}

function showPanelError(msg) {
  panelLoading.hidden = true;
  panelSourceWrap.hidden = true;
  panelText.hidden = false;
  panelFoot.hidden = true;
  panelText.value = msg;
}

function showOcrPanel(text) {
  currentPanel = "ocr";
  dockPanel();
  panel.hidden = false;
  panelTitle.textContent = "提取文字";
  panelLoading.hidden = true;
  panelSourceWrap.hidden = true;
  panelTextLabel.textContent = "识别结果";
  panelText.hidden = false;
  panelText.value = text || "";
  panelFoot.hidden = false;
}

function hidePanel() {
  panel.hidden = true;
  currentPanel = null;
}

async function copyPanel() {
  const text = panelText.value;
  try {
    if (api && typeof api.copyText === "function") {
      await api.copyText(text);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      panelText.focus();
      panelText.select();
      document.execCommand("copy");
    }
    showToast("已复制");
  } catch (err) {
    showToast("复制失败：" + messageOf(err));
  }
}

function messageOf(err) {
  if (!err) return "未知错误";
  return typeof err === "string" ? err : err.message || String(err);
}

/* --------------------------- Toast --------------------------- */

let toastTimer = null;
function showToast(msg) {
  toast.hidden = false;
  toast.textContent = msg;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.hidden = true;
    }, 200);
  }, 1600);
}

/* --------------------------- 键盘 --------------------------- */

window.addEventListener("keydown", async (e) => {
  const inField = e.target === panelText || e.target === textEditor;

  if (e.key === "Escape") {
    if (!textEditor.hidden) {
      e.preventDefault();
      cancelTextEditor();
      return;
    }
    if (selectedIndex >= 0) {
      e.preventDefault();
      selectedIndex = -1;
      annoDirty = true;
      render();
      return;
    }
    e.preventDefault();
    if (!panel.hidden) {
      hidePanel();
      return;
    }
    api.close();
    return;
  }

  if (inField) return;

  if ((e.key === "Delete" || e.key === "Backspace") && selectedIndex >= 0) {
    e.preventDefault();
    deleteSelectedAnno();
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    if (!imageReady) return;
    if (!selection && !longMode) {
      selection = { x: 0, y: 0, w: natW, h: natH };
      render();
    }
    const copied = await doCopy();
    if (copied) api.close();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    if (selection) doCopy();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    if (selection) doSave();
    return;
  }

  if ((!selection && !longMode) || e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { r: "rect", e: "ellipse", a: "arrow", p: "pen", m: "mosaic", t: "text" };
  const t = map[e.key.toLowerCase()];
  if (t) {
    e.preventDefault();
    setTool(t);
  }
});

function deleteSelectedAnno() {
  if (selectedIndex < 0 || selectedIndex >= annotations.length) return;
  pushHistory();
  annotations.splice(selectedIndex, 1);
  selectedIndex = -1;
  annoDirty = true;
  render();
}

function cancelTextEditor() {
  textEditor.hidden = true;
  textEditor.value = "";
  textEditor.dataset.editing = "";
}

/* --------------------------- 窗口尺寸变化 --------------------------- */

window.addEventListener("resize", () => {
  updateView();
  if (imageReady) {
    annoDirty = true;
    render();
  }
});

syncToolbar();
