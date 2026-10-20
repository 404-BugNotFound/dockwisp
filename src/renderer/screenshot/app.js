"use strict";

/* ------------------------------------------------------------------ *
 * Dockwisp 截图覆盖层
 * 坐标约定：选区与标注一律以“图片原始像素”存储，显示时按比例换算。
 * ------------------------------------------------------------------ */

const api = window.screenshot || {
  // 开发/自检时的降级桩，真实环境由 preload 注入。
  onState() {},
  close() {},
  ready() {},
  async copyImage() { return false; },
  async saveImage() { return null; },
  async ocr() { return ""; },
  async translate(t) {
    return { translatedText: t, sourceLanguage: "auto", targetLanguage: "zh", provider: "mock" };
  },
};

const root = document.getElementById("root");
const shot = document.getElementById("shot");
const anno = document.getElementById("anno");
const selEl = document.getElementById("selection");
const sizeTag = document.getElementById("sizeTag");
const toolbar = document.getElementById("toolbar");
const toast = document.getElementById("toast");

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

/* ------------------------------ 状态 ------------------------------ */

const MIN_SELECTION_CSS = 8; // 选区过小（CSS px）不生效

let imageReady = false;
let baseImage = null; // 已加载的原图 <img>/Image
let natW = 0; // 图片原始宽（像素）
let natH = 0; // 图片原始高（像素）

let selection = null; // { x, y, w, h } —— 原始像素
let selectionVersion = 0; // 选区变化计数，用于丢弃过期的 OCR/翻译结果
let annotations = []; // 已完成的标注
let activeTool = null; // "rect" | "arrow" | "pen" | "mosaic" | null
let activeColor = "#ff4d4f";

// 识别/翻译缓存
let ocrText = null;

// 交互运行时
const pointer = {
  mode: "idle", // idle | creating | moving | resizing | drawing
  handle: null,
  startX: 0, // 原始像素
  startY: 0,
  originSel: null, // moving/resizing 起始选区快照
  draft: null, // 正在绘制的标注
};

/* --------------------------- 坐标换算 --------------------------- */

// 原始像素 → CSS 像素的比例（分别计算，不依赖 scaleFactor 精确值）。
function scaleX() {
  return shot.clientWidth / natW;
}
function scaleY() {
  return shot.clientHeight / natH;
}

// 指针事件 → 图片原始像素坐标（相对 #shot 左上角）。
function toImageCoords(ev) {
  const rect = shot.getBoundingClientRect();
  const cssX = ev.clientX - rect.left;
  const cssY = ev.clientY - rect.top;
  return {
    x: clamp((cssX / rect.width) * natW, 0, natW),
    y: clamp((cssY / rect.height) * natH, 0, natH),
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* --------------------------- 初始化 --------------------------- */

api.onState((state) => {
  if (!state || typeof state.image !== "string") return;
  const img = new Image();
  img.onload = () => {
    baseImage = img;
    // naturalWidth 作为真实像素基准（state.width 可能与之一致，优先用 natural）。
    natW = img.naturalWidth || state.width || img.width;
    natH = img.naturalHeight || state.height || img.height;
    anno.width = natW;
    anno.height = natH;
    shot.src = img.src;
    imageReady = true;
    render();
    // 首帧绘制完成后再通知主进程显示窗口，避免解码前的暗色空屏闪烁。
    // 窗口在 ready 之前通常是隐藏的，隐藏窗口的 requestAnimationFrame 可能不触发，
    // 故同时挂一个 setTimeout 兜底，保证 ready 一定被调用一次（避免“等 rAF→不显示→rAF 不触发”的死锁）。
    notifyReady();
  };
  img.src = state.image;
});

let readyNotified = false;
function notifyReady() {
  if (readyNotified) return;
  const fire = () => {
    if (readyNotified) return;
    readyNotified = true;
    if (typeof api.ready === "function") api.ready();
  };
  // 优先在下一帧（已完成首帧绘制）通知；隐藏窗口 rAF 可能不触发，用 setTimeout 兜底。
  requestAnimationFrame(fire);
  setTimeout(fire, 60);
}

/* --------------------------- 工具栏事件 --------------------------- */

for (const btn of document.querySelectorAll("#tools .tb-btn")) {
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
}
for (const dot of document.querySelectorAll("#colors .dot")) {
  dot.style.background = dot.dataset.color;
  dot.addEventListener("pointerdown", (e) => e.stopPropagation());
  dot.addEventListener("click", () => setColor(dot.dataset.color));
}

// 阻止工具栏/面板上的指针事件穿透到画布。
for (const stop of [toolbar, panel]) {
  stop.addEventListener("pointerdown", (e) => e.stopPropagation());
}

document.getElementById("undo").addEventListener("click", undo);
document.getElementById("close").addEventListener("click", () => api.close());
document.getElementById("copy").addEventListener("click", async () => {
  const copied = await doCopy();
  if (copied) api.close();
});
document.getElementById("save").addEventListener("click", doSave);
document.getElementById("ocr").addEventListener("click", () => runOcr());
document.getElementById("translate").addEventListener("click", runTranslate);

document.getElementById("panelClose").addEventListener("click", hidePanel);
document.getElementById("panelCopy").addEventListener("click", copyPanel);
document.getElementById("panelSelectAll").addEventListener("click", () => {
  panelText.focus();
  panelText.select();
});
panelText.addEventListener("pointerdown", (e) => e.stopPropagation());
panelText.addEventListener("input", () => {
  // 用户编辑后，识别文本缓存同步更新，供“翻译”使用。
  if (currentPanel === "ocr") ocrText = panelText.value;
});

function setColor(color) {
  activeColor = color;
  syncToolbar();
}

function setTool(tool) {
  activeTool = activeTool === tool ? null : tool;
  root.dataset.toolActive = activeTool ? "true" : "false";
  syncToolbar();
}

function syncToolbar() {
  for (const btn of document.querySelectorAll("#tools .tb-btn")) {
    btn.setAttribute("aria-pressed", btn.dataset.tool === activeTool ? "true" : "false");
  }
  for (const dot of document.querySelectorAll("#colors .dot")) {
    dot.setAttribute("aria-pressed", dot.dataset.color === activeColor ? "true" : "false");
  }
  document.getElementById("undo").disabled = annotations.length === 0;
}

/* --------------------------- 指针交互 --------------------------- */
/* 画布级交互挂在 root 上（透明层覆盖全屏）。 */

root.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

// 右键：有选区则清除选区（回到重新框选），无选区则关闭覆盖层。
root.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (selection) {
    selection = null;
    selectionVersion += 1;
    annotations = [];
    ocrText = null;
    activeTool = null;
    root.dataset.toolActive = "false";
    hidePanel();
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

// 选区变化后旧的 OCR 文本/翻译结果就过期了；重新框选同时清空标注。
function invalidateSelectionState(clearAnnotations) {
  selectionVersion += 1;
  ocrText = null;
  if (clearAnnotations) annotations = [];
  hidePanel();
}

function onPointerDown(ev) {
  if (!imageReady || ev.button !== 0) return;
  const p = toImageCoords(ev);

  // 1) 已有选区 + 选了标注工具 → 在选区内绘制标注。
  if (selection && activeTool && insideSelection(p)) {
    pointer.mode = "drawing";
    pointer.draft = startDraft(activeTool, activeColor, p);
    root.dataset.mode = "drawing";
    render();
    return;
  }

  // 2) 命中手柄 → 调整大小。
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

  // 3) 选区内部（无工具）→ 移动选区。
  if (selection && !activeTool && insideSelection(p)) {
    invalidateSelectionState(false);
    pointer.mode = "moving";
    pointer.originSel = { ...selection };
    pointer.startX = p.x;
    pointer.startY = p.y;
    root.dataset.mode = "dragging";
    return;
  }

  // 4) 其它 → 重新拉选区。
  invalidateSelectionState(true);
  pointer.mode = "creating";
  pointer.startX = p.x;
  pointer.startY = p.y;
  selection = { x: p.x, y: p.y, w: 0, h: 0 };
  root.dataset.mode = "dragging";
  render();
}

function onPointerMove(ev) {
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
    render();
  }
}

function onPointerUp() {
  if (pointer.mode === "idle") return;

  if (pointer.mode === "creating") {
    // 选区过小视为点击空白处：直接关闭覆盖层（也可用来取消本次截图）。
    if (!selection || selection.w * scaleX() < MIN_SELECTION_CSS || selection.h * scaleY() < MIN_SELECTION_CSS) {
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
      annotations.push(pointer.draft);
    }
    pointer.draft = null;
  }

  pointer.mode = "idle";
  pointer.handle = null;
  pointer.originSel = null;
  root.dataset.mode = "idle";
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

function startDraft(tool, color, p) {
  if (tool === "pen") {
    return { tool, color, points: [{ x: p.x, y: p.y }] };
  }
  return { tool, color, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
}

function updateDraft(draft, p) {
  if (!draft) return;
  if (draft.tool === "pen") {
    draft.points.push({ x: p.x, y: p.y });
  } else {
    draft.x1 = p.x;
    draft.y1 = p.y;
  }
}

function draftIsValid(draft) {
  if (draft.tool === "pen") return draft.points.length > 1;
  const w = Math.abs(draft.x1 - draft.x0);
  const h = Math.abs(draft.y1 - draft.y0);
  return w * scaleX() > 2 || h * scaleY() > 2;
}

function undo() {
  if (annotations.length === 0) return;
  annotations.pop();
  render();
}

/* --------------------------- 渲染 --------------------------- */

function render() {
  if (!imageReady) return;

  const hasSel = !!(selection && selection.w > 0 && selection.h > 0);
  root.dataset.hasSelection = hasSel ? "true" : "false";

  // 选区框（CSS 像素定位）。
  if (hasSel) {
    const sx = scaleX();
    const sy = scaleY();
    const rect = shot.getBoundingClientRect();
    selEl.hidden = false;
    selEl.style.left = `${rect.left + selection.x * sx}px`;
    selEl.style.top = `${rect.top + selection.y * sy}px`;
    selEl.style.width = `${selection.w * sx}px`;
    selEl.style.height = `${selection.h * sy}px`;
    sizeTag.textContent = `${Math.round(selection.w)} × ${Math.round(selection.h)}`;
    // 顶部空间不足时标签落到选区内。
    selEl.dataset.tag = selection.y * sy < 26 ? "inside" : "outside";
  } else {
    selEl.hidden = true;
  }

  drawAnnotations();
  positionToolbar(hasSel);
  syncToolbar();
}

// 在标注 canvas 上绘制全部标注 + 当前草稿（原始像素坐标）。
function drawAnnotations() {
  octx.clearRect(0, 0, natW, natH);
  const list = pointer.draft ? annotations.concat(pointer.draft) : annotations;
  for (const a of list) {
    drawOne(octx, a);
  }
}

function drawOne(ctx, a) {
  // 线宽随图片尺寸缩放，保持视觉一致（约 3 CSS px）。
  const lw = Math.max(2, Math.round(3 / scaleX()));
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (a.tool === "rect") {
    const r = normalizeRect(a.x0, a.y0, a.x1, a.y1);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  } else if (a.tool === "arrow") {
    drawArrow(ctx, a.x0, a.y0, a.x1, a.y1, lw);
  } else if (a.tool === "pen") {
    ctx.beginPath();
    ctx.moveTo(a.points[0].x, a.points[0].y);
    for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
    ctx.stroke();
  } else if (a.tool === "mosaic") {
    drawMosaic(ctx, normalizeRect(a.x0, a.y0, a.x1, a.y1));
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

// 马赛克：从原图采样缩小区域，再关闭平滑放大回填。
function drawMosaic(ctx, r) {
  if (!baseImage || r.w < 1 || r.h < 1) return;
  const block = 10; // 原始像素块大小
  const sw = Math.max(1, Math.round(r.w / block));
  const sh = Math.max(1, Math.round(r.h / block));
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = false;
  // 把原图对应区域画成极小图。
  tctx.drawImage(baseImage, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  // 再放大回填（像素化）。
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = true;
}

/* --------------------------- 工具栏定位 --------------------------- */

function positionToolbar(hasSel) {
  if (!hasSel) {
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;

  const sx = scaleX();
  const sy = scaleY();
  const rect = shot.getBoundingClientRect();
  const selLeft = rect.left + selection.x * sx;
  const selTop = rect.top + selection.y * sy;
  const selBottom = selTop + selection.h * sy;

  const tbW = toolbar.offsetWidth;
  const tbH = toolbar.offsetHeight;
  const gap = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 水平：左对齐选区，必要时收回视口内。
  let left = selLeft;
  left = clamp(left, 8, vw - tbW - 8);

  // 垂直：优先选区下方，空间不足放上方，再不足放选区内底部。
  let top;
  if (selBottom + gap + tbH <= vh - 4) {
    top = selBottom + gap;
  } else if (selTop - gap - tbH >= 4) {
    top = selTop - gap - tbH;
  } else {
    top = clamp(selBottom - tbH - gap, 4, vh - tbH - 4);
  }

  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

/* --------------------------- 导出选区 PNG --------------------------- */

function exportSelectionPng(includeAnnotations = true) {
  if (!selection || selection.w < 1 || selection.h < 1) return null;
  const w = Math.max(1, Math.round(selection.w));
  const h = Math.max(1, Math.round(selection.h));
  const sx = Math.round(selection.x);
  const sy = Math.round(selection.y);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");

  // 1) 截图对应区域。
  ctx.drawImage(baseImage, sx, sy, w, h, 0, 0, w, h);

  // 2) 标注对应区域：以选区左上为原点重绘（含马赛克像素化）。
  // OCR 只需要干净的截图（includeAnnotations=false），标注线会干扰识别。
  if (includeAnnotations) {
    ctx.save();
    ctx.translate(-sx, -sy);
    for (const a of annotations) drawOne(ctx, a);
    ctx.restore();
  }

  return out.toDataURL("image/png");
}

/* --------------------------- 复制 / 保存 --------------------------- */

async function doCopy() {
  const url = exportSelectionPng();
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
  const url = exportSelectionPng();
  if (!url) return;
  try {
    const result = await api.saveImage(url);
    // 返回 null = 用户取消，不提示。
    if (result) showToast("已保存");
  } catch (err) {
    showToast("保存失败：" + messageOf(err));
  }
}

/* --------------------------- OCR / 翻译 --------------------------- */

let currentPanel = null; // "ocr" | "translate"
let busy = false;

function setBusy(btnId, label, on) {
  const btn = document.getElementById(btnId);
  btn.classList.toggle("busy", on);
  btn.disabled = on;
  if (on) btn.dataset.label = btn.textContent;
  btn.textContent = on ? label : btn.dataset.label || btn.textContent;
}

// 返回识别文本；force=false 时复用缓存。
async function runOcr(force = false) {
  if (busy) return ocrText;
  if (!selection) return null;
  if (!force && ocrText != null) {
    showOcrPanel(ocrText);
    return ocrText;
  }
  const url = exportSelectionPng(false);
  if (!url) return null;
  const version = selectionVersion;

  busy = true;
  showPanelLoading("文字识别", "识别中…");
  setBusy("ocr", "识别中", true);
  try {
    const text = await api.ocr(url);
    if (version !== selectionVersion) return null;
    ocrText = text || "";
    showOcrPanel(ocrText);
    return ocrText;
  } catch (err) {
    if (version !== selectionVersion) return null;
    showPanelError("识别失败：" + messageOf(err));
    return null;
  } finally {
    busy = false;
    setBusy("ocr", "识别中", false);
  }
}

async function runTranslate() {
  if (busy || !selection) return;
  const version = selectionVersion;

  // 没有识别文本则先识别。
  let text = ocrText;
  if (text == null || text.trim() === "") {
    text = await runOcr(false);
    if (text == null || version !== selectionVersion) return; // 识别失败或选区已变
  }
  if (!text || text.trim() === "") {
    showPanelError("未识别到文字");
    return;
  }

  busy = true;
  showPanelLoading("翻译", "翻译中…");
  setBusy("translate", "翻译中", true);
  try {
    const res = await api.translate(text);
    if (version !== selectionVersion) return;
    showTranslatePanel(text, res);
  } catch (err) {
    if (version !== selectionVersion) return;
    showPanelError("翻译失败：" + messageOf(err));
  } finally {
    busy = false;
    setBusy("translate", "翻译中", false);
  }
}

function messageOf(err) {
  if (!err) return "未知错误";
  return typeof err === "string" ? err : err.message || String(err);
}

/* --------------------------- 结果面板 --------------------------- */

function dockPanel() {
  // 窄屏直接底部停靠。
  const narrow = window.innerWidth < 760;
  // 选区右边缘进入右侧面板预计区域时也改为底部，避免遮挡选区右半部分。
  let overlapsRight = false;
  if (selection) {
    const rect = shot.getBoundingClientRect();
    const selRightCss = rect.left + (selection.x + selection.w) * scaleX();
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
  panelTitle.textContent = "文字识别";
  panelLoading.hidden = true;
  panelSourceWrap.hidden = true;
  panelTextLabel.textContent = "识别结果";
  panelText.hidden = false;
  panelText.value = text || "";
  panelFoot.hidden = false;
}

function showTranslatePanel(source, res) {
  currentPanel = "translate";
  dockPanel();
  panel.hidden = false;
  const lang =
    res && res.sourceLanguage && res.targetLanguage
      ? `${res.sourceLanguage} → ${res.targetLanguage}`
      : "翻译";
  panelTitle.textContent = res && res.provider ? `${lang} · ${res.provider}` : lang;
  panelLoading.hidden = true;
  panelSourceWrap.hidden = false;
  panelSource.textContent = source || "";
  panelTextLabel.textContent = "译文";
  panelText.hidden = false;
  panelText.value = (res && res.translatedText) || "";
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

/* --------------------------- Toast --------------------------- */

let toastTimer = null;
function showToast(msg) {
  toast.hidden = false;
  toast.textContent = msg;
  // 触发过渡。
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
  // 面板文本框内只处理 Esc 关面板；Enter 用于换行。
  const inField = e.target === panelText;

  if (e.key === "Escape") {
    e.preventDefault();
    if (!panel.hidden) {
      hidePanel();
      return;
    }
    api.close();
    return;
  }

  // 默认操作：Enter 复制当前选区并关闭截图界面；没有选区时复制全屏。
  if (e.key === "Enter" && !inField) {
    e.preventDefault();
    if (!imageReady) return;
    if (!selection) {
      selection = { x: 0, y: 0, w: natW, h: natH };
      render();
    }
    const copied = await doCopy();
    if (copied) api.close();
    return;
  }

  if (inField) return;

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

  // 工具快捷键仅在已有选区时生效。
  if (!selection || e.ctrlKey || e.metaKey || e.altKey) return;
  const map = { r: "rect", a: "arrow", p: "pen", m: "mosaic" };
  const t = map[e.key.toLowerCase()];
  if (t) {
    e.preventDefault();
    setTool(t);
  }
});

/* --------------------------- 窗口尺寸变化 --------------------------- */

window.addEventListener("resize", () => {
  if (imageReady) render();
});

// 初始同步一次（state 未到也不报错）。
syncToolbar();
