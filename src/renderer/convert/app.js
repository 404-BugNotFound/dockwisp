"use strict";

/* ------------------------------------------------------------------ *
 * Dockwisp 文件转换窗口
 * 渲染器负责：文件列表、目标格式选择、拖放、发起转换、进度/结果展示，
 * 以及文档组件（LibreOffice）首次使用时的下载确认与进度。图片/文档的
 * 实际转换都在主进程完成（sharp / LibreOffice / printToPDF）。
 * ------------------------------------------------------------------ */

const api = window.convert;

const capsLine = document.getElementById("capsLine");
const addFilesBtn = document.getElementById("addFiles");
const closeBtn = document.getElementById("closeWindow");
const dropzone = document.getElementById("dropzone");
const fileListEl = document.getElementById("fileList");
const outDirBtn = document.getElementById("outDir");
const clearOutBtn = document.getElementById("clearOut");
const convertBtn = document.getElementById("convert");
const summaryEl = document.getElementById("summary");
const batchBar = document.getElementById("batchBar");
const batchTarget = document.getElementById("batchTarget");
const mergePdfBtn = document.getElementById("mergePdf");
const batchStatus = document.getElementById("batchStatus");
const toast = document.getElementById("toast");
const overlay = document.getElementById("downloadOverlay");
const dlTitle = document.getElementById("dlTitle");
const dlDetail = document.getElementById("dlDetail");
const dlBar = document.getElementById("dlBar");
const dlConfirm = document.getElementById("dlConfirm");
const dlCancel = document.getElementById("dlCancel");

const ICO_SIZES = [16, 32, 48, 256];

let theme = "light";
let capabilities = { office: false, pdfword: false };
const components = {
  office: { name: "文档转换组件", version: "", sizeMb: 0, intro: "首次转换文档/表格/演示文稿需要下载 LibreOffice" },
  pdfword: { name: "PDF 转换组件", version: "", sizeMb: 0, intro: "首次把 PDF 转为 Word 或图片需要下载 pdf2docx 及其 Python 运行环境" },
};
// The component the download overlay is currently about.
let activeComponent = "office";
let files = [];
let outputDir = null;
const selection = new Map(); // id -> { targetId, quality, icoSizes:Set, targets:[] }
const cardEls = new Map();
let converting = false;
let downloading = false;
let toastTimer = null;
// A deferred target to auto-select / auto-run after the office download.
let pendingAfterDownload = null;

// --- Helpers --------------------------------------------------------------

function showToast(message) {
  toast.hidden = false;
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1900);
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

const CATEGORY_LABEL = {
  image: "图片",
  data: "数据",
  document: "文档",
  spreadsheet: "表格",
  presentation: "演示",
};

function fileIconSvg(category) {
  if (category === "image") return '<path d="M4 5h16v14H4z"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l5-5 4 4 2-2 3 3"/>';
  if (category === "spreadsheet") return '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>';
  if (category === "presentation") return '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>';
  return '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
}

function applyTheme(next) {
  theme = next === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function renderCaps() {
  const ready = [];
  if (capabilities.office) ready.push(`LibreOffice ${components.office.version}`);
  if (capabilities.pdfword) ready.push(`pdf2docx ${components.pdfword.version}`);
  capsLine.textContent = ready.length
    ? `已就绪：${ready.join("、")}`
    : "图片转换已内置；文档转换首次使用时需下载组件";
}

// --- File list rendering --------------------------------------------------

function renderFiles() {
  const hasFiles = files.length > 0;
  fileListEl.hidden = !hasFiles;
  dropzone.classList.toggle("compact", hasFiles);

  const present = new Set(files.map((f) => f.id));
  for (const id of [...selection.keys()]) if (!present.has(id)) selection.delete(id);
  for (const id of [...cardEls.keys()]) if (!present.has(id)) cardEls.delete(id);

  fileListEl.replaceChildren();
  for (const file of files) fileListEl.append(buildCard(file));
  batchStatus.hidden = true;
  batchStatus.replaceChildren();
  updateSummary();
  refreshBatchBar();
}

function buildCard(file) {
  const li = document.createElement("li");
  li.className = "file-card";
  li.dataset.id = file.id;

  const thumb = document.createElement("div");
  thumb.className = "file-thumb";
  if (file.category === "image") {
    const img = document.createElement("img");
    img.alt = "";
    api.readSource(file.path).then((url) => { if (url) img.src = url; }).catch(() => {});
    thumb.append(img);
  } else {
    thumb.innerHTML = `<svg viewBox="0 0 24 24">${fileIconSvg(file.category)}</svg>`;
  }

  const main = document.createElement("div");
  main.className = "file-main";
  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = file.name;
  name.title = file.path;
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = `${CATEGORY_LABEL[file.category] || "文件"} · ${file.ext.toUpperCase()} · ${formatBytes(file.size)}`;
  main.append(name, meta);

  const remove = document.createElement("button");
  remove.className = "file-remove";
  remove.type = "button";
  remove.title = "移除";
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>';
  remove.addEventListener("click", () => api.removeFile(file.id));

  const controls = document.createElement("div");
  controls.className = "file-controls";

  const status = document.createElement("div");
  status.className = "file-status";
  status.hidden = true;

  li.append(thumb, main, remove, controls, status);
  const refs = { li, controls, status, thumb };
  cardEls.set(file.id, refs);
  void populateControls(file, refs);
  return li;
}

async function populateControls(file, refs) {
  const targets = await api.listTargets(file.ext);
  let sel = selection.get(file.id);
  if (!sel) {
    const first = targets[0];
    sel = {
      targetId: first ? first.id : "",
      quality: 0.9,
      icoSizes: new Set([32]),
      fitSheets: false,
      targets,
    };
    selection.set(file.id, sel);
  } else {
    sel.targets = targets;
    if (!targets.some((t) => t.id === sel.targetId) && targets[0]) sel.targetId = targets[0].id;
  }
  drawControls(file, refs, sel);
  updateSummary();
  refreshBatchBar();
}

function drawControls(file, refs, sel) {
  const controls = refs.controls;
  controls.replaceChildren();

  const field = document.createElement("label");
  field.className = "field";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = "转为";
  const select = document.createElement("select");
  select.className = "select";
  for (const target of sel.targets) {
    const option = document.createElement("option");
    option.value = target.id;
    let text = target.label;
    if (target.needsDownload) text += " （需下载）";
    option.textContent = text;
    if (target.id === sel.targetId) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => {
    sel.targetId = select.value;
    drawControls(file, refs, sel);
    updateSummary();
  });
  field.append(label, select);
  controls.append(field);

  const current = sel.targets.find((t) => t.id === sel.targetId);

  if (current && current.quality) {
    const quality = document.createElement("div");
    quality.className = "quality";
    const qLabel = document.createElement("span");
    qLabel.className = "field-label";
    qLabel.textContent = "质量";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "10";
    range.max = "100";
    range.step = "1";
    range.value = String(Math.round(sel.quality * 100));
    const val = document.createElement("span");
    val.className = "quality-val";
    val.textContent = `${range.value}%`;
    range.addEventListener("input", () => {
      sel.quality = Number(range.value) / 100;
      val.textContent = `${range.value}%`;
    });
    quality.append(qLabel, range, val);
    controls.append(quality);
  }

  if (current && current.fitSheets) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ico-chip";
    chip.textContent = "每个工作表缩到一页";
    chip.title = "宽表格不再被拆成很多页";
    chip.setAttribute("aria-pressed", sel.fitSheets ? "true" : "false");
    chip.addEventListener("click", () => {
      sel.fitSheets = !sel.fitSheets;
      chip.setAttribute("aria-pressed", sel.fitSheets ? "true" : "false");
    });
    controls.append(chip);
  }

  if (current && current.id === "ico") {
    const wrap = document.createElement("div");
    wrap.className = "ico-sizes";
    const icoLabel = document.createElement("span");
    icoLabel.className = "field-label";
    icoLabel.textContent = "尺寸";
    wrap.append(icoLabel);
    for (const size of ICO_SIZES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ico-chip";
      chip.textContent = `${size}`;
      chip.setAttribute("aria-pressed", sel.icoSizes.has(size) ? "true" : "false");
      chip.addEventListener("click", () => {
        if (sel.icoSizes.has(size)) {
          if (sel.icoSizes.size > 1) sel.icoSizes.delete(size);
        } else {
          sel.icoSizes.add(size);
        }
        chip.setAttribute("aria-pressed", sel.icoSizes.has(size) ? "true" : "false");
      });
      wrap.append(chip);
    }
    controls.append(wrap);
  }

  if (current && current.note) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = current.note;
    controls.append(note);
  }
}

function updateSummary() {
  summaryEl.textContent = files.length ? `${files.length} 个文件` : "";
  convertBtn.disabled = converting || downloading || files.length === 0;
}

// --- Batch controls --------------------------------------------------------

/** Target formats offered by every file (intersection by id); label from the first file. */
function sharedTargets() {
  if (files.length < 2) return [];
  const sels = files.map((f) => selection.get(f.id));
  if (sels.some((s) => !s || !Array.isArray(s.targets) || s.targets.length === 0)) return [];
  const [first, ...rest] = sels;
  return first.targets.filter((t) =>
    rest.every((s) => s.targets.some((o) => o.id === t.id)),
  );
}

/** All files currently in the list are images. */
function allImages() {
  return files.length >= 2 && files.every((f) => f.category === "image");
}

function refreshBatchBar() {
  const shared = sharedTargets();
  const showMerge = allImages();
  const showBar = shared.length > 0 || showMerge;
  batchBar.hidden = !showBar;
  if (!showBar) {
    batchTarget.hidden = true;
    mergePdfBtn.hidden = true;
    return;
  }

  // "全部转为" select: rebuilt from the current intersection.
  const batchField = batchTarget.closest(".field");
  if (shared.length > 0) {
    batchTarget.hidden = false;
    if (batchField) batchField.hidden = false;
    batchTarget.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择格式…";
    placeholder.selected = true;
    batchTarget.append(placeholder);
    for (const target of shared) {
      const option = document.createElement("option");
      option.value = target.id;
      option.textContent = target.needsDownload ? `${target.label} （需下载）` : target.label;
      batchTarget.append(option);
    }
    batchTarget.disabled = converting || downloading;
  } else {
    batchTarget.hidden = true;
    if (batchField) batchField.hidden = true;
  }

  mergePdfBtn.hidden = !showMerge;
  mergePdfBtn.disabled = converting || downloading;
}

function applyBatchTarget(targetId) {
  if (!targetId) return;
  for (const file of files) {
    const sel = selection.get(file.id);
    if (!sel) continue;
    if (!sel.targets.some((t) => t.id === targetId)) continue;
    sel.targetId = targetId;
    const refs = cardEls.get(file.id);
    if (refs) drawControls(file, refs, sel);
  }
  updateSummary();
}

async function mergeToPdf() {
  if (converting || downloading) return;
  if (!allImages()) return;
  converting = true;
  updateSummary();
  mergePdfBtn.disabled = true;
  const prevLabel = mergePdfBtn.textContent;
  mergePdfBtn.textContent = "合并中…";
  try {
    const result = await api.mergeImagesToPdf(files.map((f) => f.id), outputDir);
    if (result && result.ok) {
      const outName = (result.outputPath || "").split(/[\\/]/).pop() || "";
      showToast(`已合并：${outName}`);
      showBatchResult(result.outputPath);
    } else {
      showToast((result && result.message) || "合并失败");
    }
  } catch (error) {
    showToast(error && error.message ? error.message : String(error));
  } finally {
    converting = false;
    mergePdfBtn.textContent = prevLabel;
    updateSummary();
    refreshBatchBar();
  }
}

function showBatchResult(outputPath) {
  batchStatus.replaceChildren();
  if (!outputPath) {
    batchStatus.hidden = true;
    return;
  }
  batchStatus.hidden = false;
  const dot = document.createElement("span");
  dot.className = "status-dot";
  const text = document.createElement("span");
  const outName = outputPath.split(/[\\/]/).pop() || "";
  text.textContent = `已合并 ${outName}`;
  const actions = document.createElement("span");
  actions.className = "result-actions";
  const open = document.createElement("button");
  open.className = "link-button";
  open.type = "button";
  open.textContent = "打开";
  open.addEventListener("click", () => api.openFile(outputPath));
  const reveal = document.createElement("button");
  reveal.className = "link-button";
  reveal.type = "button";
  reveal.textContent = "打开目录";
  reveal.addEventListener("click", () => api.revealFile(outputPath));
  actions.append(open, reveal);
  batchStatus.append(dot, text, actions);
}

// --- Conversion ------------------------------------------------------------

function setProgress(fileId, percent) {
  const refs = cardEls.get(fileId);
  if (!refs) return;
  let bar = refs.status.querySelector(".progress-bar");
  if (!bar) {
    refs.status.hidden = false;
    refs.status.innerHTML = '<div class="progress"><div class="progress-bar"></div></div>';
    bar = refs.status.querySelector(".progress-bar");
  }
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function showResult(result) {
  const refs = cardEls.get(result.id);
  if (!refs) return;
  refs.status.hidden = false;
  refs.status.innerHTML = "";
  if (result.ok) {
    const line = document.createElement("div");
    line.className = "status-line ok";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const text = document.createElement("span");
    const outName = (result.outputPath || "").split(/[\\/]/).pop();
    text.textContent = `已生成 ${outName || ""}`;
    const actions = document.createElement("span");
    actions.className = "result-actions";
    const open = document.createElement("button");
    open.className = "link-button";
    open.type = "button";
    open.textContent = "打开";
    open.addEventListener("click", () => api.openFile(result.outputPath));
    const reveal = document.createElement("button");
    reveal.className = "link-button";
    reveal.type = "button";
    reveal.textContent = "打开目录";
    reveal.addEventListener("click", () => api.revealFile(result.outputPath));
    actions.append(open, reveal);
    line.append(dot, text, actions);
    refs.status.append(line);
  } else if (result.needsDownload) {
    const line = document.createElement("div");
    line.className = "status-line err";
    const text = document.createElement("span");
    text.textContent = result.message || "需下载转换组件";
    const act = document.createElement("button");
    act.className = "link-button";
    act.type = "button";
    act.textContent = "立即下载";
    act.addEventListener("click", () => {
      const missing = missingComponents();
      if (missing.length) openDownloadConfirm(missing[0], null);
    });
    line.append(text, act);
    refs.status.append(line);
  } else {
    const line = document.createElement("div");
    line.className = "status-line err";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const text = document.createElement("span");
    text.textContent = result.message || "转换失败";
    line.append(dot, text);
    refs.status.append(line);
  }
}

/** Components the currently selected targets still need, in order. */
function missingComponents() {
  const missing = [];
  for (const file of files) {
    const sel = selection.get(file.id);
    if (!sel) continue;
    const target = sel.targets && sel.targets.find((t) => t.id === sel.targetId);
    const component = target && target.needsDownload ? target.component || "office" : null;
    if (component && !missing.includes(component)) missing.push(component);
  }
  return missing;
}

async function startConvert() {
  if (converting || downloading) return;
  const missing = missingComponents();
  if (missing.length) {
    openDownloadConfirm(missing[0], { action: "convert" });
    return;
  }
  const requests = [];
  for (const file of files) {
    const sel = selection.get(file.id);
    if (!sel || !sel.targetId) continue;
    const target = sel.targets && sel.targets.find((t) => t.id === sel.targetId);
    if (!target) continue;
    const request = { id: file.id, path: file.path, targetExt: sel.targetId };
    if (target.quality) request.quality = sel.quality;
    if (sel.targetId === "ico") request.icoSizes = [...sel.icoSizes];
    if (target.fitSheets && sel.fitSheets) request.fitSheets = true;
    if (outputDir) request.outputDir = outputDir;
    requests.push(request);
    setProgress(file.id, 0);
  }
  if (requests.length === 0) return;
  converting = true;
  convertBtn.disabled = true;
  convertBtn.textContent = "转换中…";
  refreshBatchBar();
  try {
    await api.start(requests);
  } catch (error) {
    showToast(error && error.message ? error.message : String(error));
  } finally {
    converting = false;
    convertBtn.textContent = "开始转换";
    updateSummary();
    refreshBatchBar();
  }
}

// --- Office download flow ---------------------------------------------------

function openDownloadConfirm(component, after) {
  activeComponent = components[component] ? component : "office";
  const info = components[activeComponent];
  pendingAfterDownload = after;
  overlay.hidden = false;
  overlay.dataset.mode = "confirm";
  dlTitle.textContent = `需要下载${info.name}`;
  const size = info.sizeMb ? `（约 ${info.sizeMb} MB）` : "";
  const version = info.version ? ` ${info.version}` : "";
  dlDetail.textContent = `${info.intro}${activeComponent === "office" ? version : ""}${size}，仅需一次。`;
  dlBar.style.width = "0%";
  dlConfirm.hidden = false;
  dlConfirm.disabled = false;
  dlConfirm.textContent = "下载并安装";
  dlCancel.textContent = "暂不";
}

function setDownloadPhase(progress) {
  overlay.dataset.mode = "progress";
  dlConfirm.hidden = true;
  dlCancel.textContent = "取消";
  if (progress.phase === "download") {
    const pct = typeof progress.percent === "number" ? progress.percent : null;
    dlTitle.textContent = `正在下载${components[activeComponent].name}…`;
    if (pct !== null) {
      dlBar.style.width = `${pct}%`;
      const recv = formatBytes(progress.received || 0);
      const total = progress.total ? ` / ${formatBytes(progress.total)}` : "";
      dlDetail.textContent = `${pct}% （${recv}${total}）`;
    } else {
      dlDetail.textContent = `已下载 ${formatBytes(progress.received || 0)}`;
    }
  } else if (progress.phase === "unpack") {
    dlTitle.textContent = "正在安装…";
    dlDetail.textContent = "正在解包组件，请稍候";
    dlBar.style.width = "100%";
    dlBar.classList.add("indeterminate");
  } else if (progress.phase === "done") {
    dlBar.classList.remove("indeterminate");
    dlBar.style.width = "100%";
  }
}

async function runDownload() {
  if (downloading) return;
  downloading = true;
  dlConfirm.disabled = true;
  overlay.dataset.mode = "progress";
  dlConfirm.hidden = true;
  dlCancel.textContent = "取消";
  dlTitle.textContent = "正在准备下载…";
  dlDetail.textContent = "";
  dlBar.style.width = "0%";
  try {
    const result = await api.downloadOffice(activeComponent);
    downloading = false;
    dlBar.classList.remove("indeterminate");
    if (result.ok) {
      overlay.hidden = true;
      showToast(`${components[activeComponent].name}已就绪`);
      const after = pendingAfterDownload;
      pendingAfterDownload = null;
      // Refresh target lists now that the component is available.
      for (const file of files) {
        const refs = cardEls.get(file.id);
        if (refs) await populateControls(file, refs);
      }
      if (after && after.action === "convert") {
        const missing = missingComponents();
        if (missing.length) openDownloadConfirm(missing[0], after);
        else void startConvert();
      }
    } else if (result.cancelled) {
      overlay.hidden = true;
      showToast("已取消下载");
    } else {
      overlay.dataset.mode = "error";
      dlTitle.textContent = "下载失败";
      dlDetail.textContent = result.message || "请检查网络后重试";
      dlConfirm.hidden = false;
      dlConfirm.disabled = false;
      dlConfirm.textContent = "重试";
      dlCancel.textContent = "关闭";
    }
  } catch (error) {
    downloading = false;
    overlay.dataset.mode = "error";
    dlTitle.textContent = "下载失败";
    dlDetail.textContent = error && error.message ? error.message : String(error);
    dlConfirm.hidden = false;
    dlConfirm.disabled = false;
    dlConfirm.textContent = "重试";
    dlCancel.textContent = "关闭";
  }
  updateSummary();
}

dlConfirm.addEventListener("click", () => void runDownload());
dlCancel.addEventListener("click", () => {
  if (downloading) {
    api.cancelDownload();
  } else {
    overlay.hidden = true;
    pendingAfterDownload = null;
  }
});

// --- Drag & drop ------------------------------------------------------------

function onDragEnter(event) {
  event.preventDefault();
  dropzone.classList.add("drag");
}
function onDragLeave(event) {
  if (event.target === dropzone || !dropzone.contains(event.relatedTarget)) {
    dropzone.classList.remove("drag");
  }
}
function onDrop(event) {
  event.preventDefault();
  dropzone.classList.remove("drag");
  const dropped = Array.from(event.dataTransfer.files || []);
  if (dropped.length === 0) return;
  const paths = api.pathsForFiles(dropped).filter(Boolean);
  if (paths.length) api.addDroppedPaths(paths);
}

// --- Output directory -------------------------------------------------------

function setOutputDir(dir) {
  outputDir = dir || null;
  outDirBtn.textContent = outputDir || "源文件目录";
  outDirBtn.title = outputDir || "输出到每个源文件所在目录";
  clearOutBtn.hidden = !outputDir;
}

// --- Preset (from launcher) -------------------------------------------------

function applyPreset(preset) {
  if (!preset || !preset.target) return;
  const targetId = preset.target.toLowerCase();
  let missing = null;
  for (const file of files) {
    const sel = selection.get(file.id);
    if (!sel) continue;
    if (sel.targets.some((t) => t.id === targetId)) {
      sel.targetId = targetId;
      const refs = cardEls.get(file.id);
      if (refs) drawControls(file, refs, sel);
      const target = sel.targets.find((t) => t.id === targetId);
      if (target && target.needsDownload && !missing) missing = target.component || "office";
    }
  }
  updateSummary();
  if (missing) openDownloadConfirm(missing, { action: "convert" });
}

// --- Wire up ----------------------------------------------------------------

addFilesBtn.addEventListener("click", () => api.addFiles());
dropzone.addEventListener("click", () => api.addFiles());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    api.addFiles();
  }
});
closeBtn.addEventListener("click", () => api.close());
convertBtn.addEventListener("click", () => void startConvert());
batchTarget.addEventListener("change", () => {
  applyBatchTarget(batchTarget.value);
});
mergePdfBtn.addEventListener("click", () => void mergeToPdf());
outDirBtn.addEventListener("click", async () => {
  const dir = await api.chooseOutputDir();
  if (dir) setOutputDir(dir);
});
clearOutBtn.addEventListener("click", () => setOutputDir(null));

window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
dropzone.addEventListener("dragenter", onDragEnter);
dropzone.addEventListener("dragover", onDragEnter);
dropzone.addEventListener("dragleave", onDragLeave);
dropzone.addEventListener("drop", onDrop);
document.getElementById("stage").addEventListener("drop", onDrop);
document.getElementById("stage").addEventListener("dragover", (event) => event.preventDefault());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !converting && !downloading) {
    event.preventDefault();
    if (!overlay.hidden) {
      overlay.hidden = true;
      pendingAfterDownload = null;
    } else {
      api.close();
    }
  }
});

api.onState((state) => {
  applyTheme(state.theme);
  capabilities = state.capabilities || { office: false, pdfword: false };
  for (const key of Object.keys(components)) {
    if (state[key]) Object.assign(components[key], state[key]);
  }
  renderCaps();
  for (const file of files) {
    const refs = cardEls.get(file.id);
    if (refs) void populateControls(file, refs);
  }
});
api.onFiles((next) => {
  files = Array.isArray(next) ? next : [];
  renderFiles();
});
api.onProgress((p) => setProgress(p.id, p.percent));
api.onResult((result) => showResult(result));
api.onPreset((preset) => applyPreset(preset));
api.onPromptDownload((info) => openDownloadConfirm((info && info.component) || "office", { action: "convert" }));
api.onDownloadProgress((progress) => {
  if (!overlay.hidden) setDownloadPhase(progress);
});

setOutputDir(null);
