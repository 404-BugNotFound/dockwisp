"use strict";

/**
 * Renderer for the "文本对比" window — a single live view: each side is an
 * editable <textarea> with transparent text laid over a "mirror" layer that
 * paints the diff highlights. Typing recomputes the diff (debounced, in the
 * main process) and repaints the mirrors while the caret and scroll stay put.
 *
 * Alignment relies on the textarea and its mirror sharing identical metrics
 * (font, size, line-height, padding, tab-size, wrap). The mirror and the line
 * gutter are translated to follow the textarea's own scrolling.
 */

const api = window.diff;

const el = (id) => document.getElementById(id);

const inputs = { left: el("leftInput"), right: el("rightInput") };
const mirrors = { left: el("leftMirror"), right: el("rightMirror") };
const gutters = { left: el("leftGutter"), right: el("rightGutter") };
const boxes = { left: el("leftBox"), right: el("rightBox") };
const metaEls = { left: el("leftMeta"), right: el("rightMeta") };

const ui = {
  optWrap: el("optWrap"),
  optWhitespace: el("optWhitespace"),
  optCase: el("optCase"),
  optSync: el("optSync"),
  statAdded: el("statAdded"),
  statRemoved: el("statRemoved"),
  navPrev: el("navPrev"),
  navNext: el("navNext"),
  navLabel: el("navLabel"),
  btnSwap: el("btnSwap"),
  btnClear: el("btnClear"),
  btnCopy: el("btnCopy"),
  closeWindow: el("closeWindow"),
  status: el("status"),
  toast: el("toast"),
  searchBar: el("searchBar"),
  searchInput: el("searchInput"),
  searchCount: el("searchCount"),
  searchLeft: el("searchLeft"),
  searchBoth: el("searchBoth"),
  searchRight: el("searchRight"),
  searchPrev: el("searchPrev"),
  searchNext: el("searchNext"),
  searchClose: el("searchClose"),
};

const STORAGE = {
  wrap: "dockwisp.diff.wrap",
  whitespace: "dockwisp.diff.ignoreWhitespace",
  ignoreCase: "dockwisp.diff.ignoreCase",
  sync: "dockwisp.diff.syncScroll",
  searchScope: "dockwisp.diff.searchScope",
};

// Text metrics are read from the live CSS so the mirror never drifts from the
// textarea even if the stylesheet changes.
let LINE_H = 20;
let PAD_Y = 10;

const state = {
  result: null,
  lineText: { left: [""], right: [""] },
  lineInfo: { left: [], right: [] }, // per line: { type, segments? }
  lineStart: { left: [0], right: [0] }, // absolute char offset of each line
  map: { left: [], right: [] }, // left line -> right line, and vice versa
  diffRows: [], // rows with a change, for navigation
  currentDiff: -1,
  offsets: { left: null, right: null }, // wrap-mode line tops (lazy)
  searchScope: "both",
  matches: [],
  searchIndex: -1,
  decorated: [], // lines whose mirror HTML holds search marks
  computeSeq: 0,
};

let toastTimer = null;
let debounceTimer = null;
let navLock = false;
let crossLock = false;
let resizeRaf = 0;

/* ------------------------- storage helpers ------------------------- */

function readBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}
function writeBool(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
function readString(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}
function writeString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/* ------------------------- misc helpers ------------------------- */

function showToast(message) {
  ui.toast.hidden = false;
  ui.toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 1600);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalize(text) {
  return text.replace(/\r\n?/g, "\n");
}

function isWrap() {
  return ui.optWrap.checked;
}
function isSync() {
  return ui.optSync.checked;
}

function applyTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function diffOptions() {
  return {
    ignoreWhitespace: ui.optWhitespace.checked,
    ignoreCase: ui.optCase.checked,
  };
}

function readMetrics() {
  const cs = getComputedStyle(mirrors.left);
  const lh = parseFloat(cs.lineHeight);
  const pt = parseFloat(cs.paddingTop);
  if (Number.isFinite(lh) && lh > 0) LINE_H = lh;
  if (Number.isFinite(pt)) PAD_Y = pt;
}

/* ------------------------- compute (debounced) ------------------------- */

function lineCount(side) {
  return state.lineText[side].length;
}

function scheduleCompute() {
  updateMeta();
  clearTimeout(debounceTimer);
  // Larger inputs (or wrap-mode full layout) get a longer debounce so typing
  // never blocks on a recompute/repaint.
  const bulky =
    lineCount("left") + lineCount("right") > 12000 || (isWrap() && heavy());
  debounceTimer = setTimeout(() => void runCompute(), bulky ? 420 : 170);
}

function heavy() {
  return lineCount("left") + lineCount("right") > 6000;
}

function updateMeta() {
  // Count lines straight from the raw value so the meta updates instantly.
  metaEls.left.textContent = `${normalize(inputs.left.value).split("\n").length} 行`;
  metaEls.right.textContent = `${normalize(inputs.right.value).split("\n").length} 行`;
}

async function runCompute() {
  const seq = ++state.computeSeq;
  const left = inputs.left.value;
  const right = inputs.right.value;
  ui.status.textContent = "对比中…";
  let result;
  try {
    result = await api.compute(left, right, diffOptions());
  } catch (error) {
    ui.status.textContent = "";
    showToast(error && error.message ? error.message : "对比失败");
    return;
  }
  if (seq !== state.computeSeq) return; // superseded by a newer request
  state.result = result;
  ingest(left, right, result);
  rebuild();
  updateStats();
}

/* ------------------------- turn diff rows into per-line data ------------- */

function ingest(left, right, result) {
  const leftLines = normalize(left).split("\n");
  const rightLines = normalize(right).split("\n");
  state.lineText.left = leftLines;
  state.lineText.right = rightLines;
  state.lineStart.left = buildLineStarts(leftLines);
  state.lineStart.right = buildLineStarts(rightLines);

  const leftInfo = new Array(leftLines.length);
  const rightInfo = new Array(rightLines.length);
  for (let i = 0; i < leftLines.length; i++) leftInfo[i] = { type: "equal" };
  for (let i = 0; i < rightLines.length; i++) rightInfo[i] = { type: "equal" };

  const rawLeftMap = new Array(leftLines.length);
  const rawRightMap = new Array(rightLines.length);
  const diffRows = [];

  for (const row of result.rows) {
    const li = row.left ? row.left.lineNumber - 1 : -1;
    const ri = row.right ? row.right.lineNumber - 1 : -1;
    if (row.type === "equal") {
      if (li >= 0) leftInfo[li] = { type: "equal" };
      if (ri >= 0) rightInfo[ri] = { type: "equal" };
    } else if (row.type === "insert") {
      if (ri >= 0) rightInfo[ri] = { type: "insert" };
    } else if (row.type === "delete") {
      if (li >= 0) leftInfo[li] = { type: "delete" };
    } else {
      if (li >= 0) leftInfo[li] = { type: "modify", segments: row.left.segments };
      if (ri >= 0) rightInfo[ri] = { type: "modify", segments: row.right.segments };
    }
    if (li >= 0 && ri >= 0) {
      rawLeftMap[li] = ri;
      rawRightMap[ri] = li;
    }
    if (row.type !== "equal") diffRows.push(row);
  }

  state.lineInfo.left = leftInfo;
  state.lineInfo.right = rightInfo;
  state.map.left = fillMap(rawLeftMap, leftLines.length);
  state.map.right = fillMap(rawRightMap, rightLines.length);
  state.diffRows = diffRows;
  state.currentDiff = -1;
  state.offsets.left = null;
  state.offsets.right = null;
}

function buildLineStarts(lines) {
  const starts = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = acc;
    acc += lines[i].length + 1; // + newline
  }
  return starts;
}

// Give every line a counterpart on the other side; unpaired (inserted/deleted)
// lines borrow the last paired position so sync-scroll stays monotonic.
function fillMap(raw, len) {
  const out = new Array(len);
  let last = 0;
  for (let i = 0; i < len; i++) {
    if (raw[i] != null) last = raw[i];
    out[i] = last;
  }
  return out;
}

/* ------------------------- rendering the mirrors ------------------------- */

function lineInnerHTML(side, idx, ranges) {
  const text = state.lineText[side][idx] ?? "";
  if (ranges && ranges.length) {
    let html = "";
    let cur = 0;
    for (const r of ranges) {
      if (r.start > cur) html += escapeHtml(text.slice(cur, r.start));
      html += `<span class="search-mark" data-mi="${r.mi}">${escapeHtml(
        text.slice(r.start, r.start + r.len),
      )}</span>`;
      cur = r.start + r.len;
    }
    if (cur < text.length) html += escapeHtml(text.slice(cur));
    return html;
  }
  const info = state.lineInfo[side][idx];
  if (info && info.type === "modify" && info.segments) {
    const cls = side === "left" ? "chg-del" : "chg-add";
    let html = "";
    for (const seg of info.segments) {
      const e = escapeHtml(seg.text);
      html += seg.changed ? `<span class="${cls}">${e}</span>` : e;
    }
    return html;
  }
  return escapeHtml(text);
}

function rebuild() {
  const wrap = isWrap();
  for (const side of ["left", "right"]) {
    const texts = state.lineText[side];
    const info = state.lineInfo[side];
    const mirrorParts = new Array(texts.length);
    const gutterParts = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const type = info[i] ? info[i].type : "equal";
      mirrorParts[i] = `<div class="mirror-line t-${type}" data-line="${i}">${lineInnerHTML(
        side,
        i,
        null,
      )}</div>`;
      gutterParts[i] = `<div class="gutter-line t-${type}" data-line="${i}">${i + 1}</div>`;
    }
    mirrors[side].innerHTML = mirrorParts.join("");
    gutters[side].innerHTML = gutterParts.join("");

    mirrors[side].classList.toggle("wrap", wrap);
    mirrors[side].style.width = wrap ? `${inputs[side].clientWidth}px` : "";

    inputs[side].classList.toggle("wrap", wrap);
    inputs[side].wrap = wrap ? "soft" : "off";

    if (wrap) syncGutterHeights(side);
  }
  state.offsets.left = null;
  state.offsets.right = null;

  visualSync("left");
  visualSync("right");
  updateNavLabel();

  // Repaint an active search over the fresh content.
  if (!ui.searchBar.hidden && ui.searchInput.value) {
    state.decorated = [];
    runSearch(false);
  }
}

// In wrap mode line heights vary; match each gutter row to its mirror row.
function syncGutterHeights(side) {
  const mc = mirrors[side].children;
  const gc = gutters[side].children;
  for (let i = 0; i < mc.length; i++) {
    if (gc[i]) gc[i].style.height = `${mc[i].offsetHeight}px`;
  }
}

function updateStats() {
  const stats = state.result ? state.result.stats : { added: 0, removed: 0 };
  ui.statAdded.textContent = `+${stats.added}`;
  ui.statRemoved.textContent = `−${stats.removed}`;
  const total = state.diffRows.length;
  ui.status.textContent =
    total === 0 ? "两侧内容相同" : `${total} 处差异`;
}

/* ------------------------- scroll syncing ------------------------- */

function visualSync(side) {
  const ta = inputs[side];
  const st = ta.scrollTop;
  const sl = ta.scrollLeft;
  mirrors[side].style.transform = `translate(${-sl}px, ${-st}px)`;
  gutters[side].style.transform = `translateY(${-st}px)`;
}

function ensureOffsets(side) {
  if (state.offsets[side]) return state.offsets[side];
  const children = mirrors[side].children;
  const arr = new Array(children.length);
  for (let i = 0; i < children.length; i++) {
    arr[i] = children[i].offsetTop - PAD_Y;
  }
  state.offsets[side] = arr;
  return arr;
}

function lineTop(side, line) {
  const n = lineCount(side);
  const i = Math.max(0, Math.min(n - 1, line));
  if (!isWrap()) return i * LINE_H;
  const offs = ensureOffsets(side);
  return offs[i] || 0;
}

function lineAtOffset(side, top) {
  const n = lineCount(side);
  if (!isWrap()) {
    const i = Math.max(0, Math.min(n - 1, Math.floor(top / LINE_H)));
    return { line: i, frac: top - i * LINE_H };
  }
  const offs = ensureOffsets(side);
  let lo = 0;
  let hi = offs.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (offs[m] <= top) {
      ans = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  return { line: ans, frac: top - offs[ans] };
}

function mapLine(side, line) {
  const arr = state.map[side];
  if (!arr.length) return line;
  return arr[Math.max(0, Math.min(arr.length - 1, line))];
}

function counterpartTop(side, other) {
  const { line, frac } = lineAtOffset(side, inputs[side].scrollTop);
  const target = mapLine(side, line);
  return lineTop(other, target) + frac;
}

function onScroll(side) {
  visualSync(side);
  if (navLock || crossLock || !isSync()) return;
  const other = side === "left" ? "right" : "left";
  const ta = inputs[other];
  const max = ta.scrollHeight - ta.clientHeight;
  const target = Math.max(0, Math.min(max, counterpartTop(side, other)));
  if (Math.abs(target - ta.scrollTop) > 0.5) {
    crossLock = true;
    ta.scrollTop = target;
    visualSync(other);
    requestAnimationFrame(() => {
      crossLock = false;
    });
  } else {
    visualSync(other);
  }
}

function scrollLineToCenter(side, line) {
  const ta = inputs[side];
  const top = lineTop(side, line) - ta.clientHeight / 2 + LINE_H / 2;
  ta.scrollTop = Math.max(0, Math.min(ta.scrollHeight - ta.clientHeight, top));
  visualSync(side);
}

/* ------------------------- diff navigation ------------------------- */

function updateNavLabel() {
  const total = state.diffRows.length;
  const current = state.currentDiff >= 0 ? state.currentDiff + 1 : 0;
  ui.navLabel.textContent = `${current}/${total}`;
  ui.navPrev.disabled = total === 0;
  ui.navNext.disabled = total === 0;
}

function clearFocusLines() {
  for (const side of ["left", "right"]) {
    mirrors[side].querySelectorAll(".focus-line").forEach((n) => n.classList.remove("focus-line"));
    gutters[side].querySelectorAll(".focus-line").forEach((n) => n.classList.remove("focus-line"));
  }
}

function markFocusLine(side, idx) {
  const m = mirrors[side].querySelector(`.mirror-line[data-line="${idx}"]`);
  const g = gutters[side].querySelector(`.gutter-line[data-line="${idx}"]`);
  if (m) m.classList.add("focus-line");
  if (g) g.classList.add("focus-line");
}

function gotoDiff(step) {
  const total = state.diffRows.length;
  if (total === 0) return;
  if (state.currentDiff === -1) state.currentDiff = step > 0 ? 0 : total - 1;
  else state.currentDiff = (state.currentDiff + step + total) % total;

  const row = state.diffRows[state.currentDiff];
  const li = row.left ? row.left.lineNumber - 1 : null;
  const ri = row.right ? row.right.lineNumber - 1 : null;

  clearFocusLines();
  navLock = true;
  // Center the real line on each side; for a one-sided change, center the
  // mapped counterpart so the other pane follows along.
  const leftLine = li != null ? li : mapLine("right", ri);
  const rightLine = ri != null ? ri : mapLine("left", li);
  scrollLineToCenter("left", leftLine);
  scrollLineToCenter("right", rightLine);
  if (li != null) markFocusLine("left", li);
  if (ri != null) markFocusLine("right", ri);

  // Position the caret in whichever side carries the change (prefer left).
  if (li != null) placeCaret("left", li);
  else if (ri != null) placeCaret("right", ri);

  requestAnimationFrame(() => {
    navLock = false;
  });
  updateNavLabel();
}

function placeCaret(side, line) {
  const ta = inputs[side];
  const start = state.lineStart[side][line] ?? 0;
  const end = start + (state.lineText[side][line] ?? "").length;
  ta.focus({ preventScroll: true });
  try {
    ta.setSelectionRange(start, end);
  } catch {
    /* ignore */
  }
  // setSelectionRange can nudge the native scroll; restore our centered view.
  scrollLineToCenter(side, line);
}

/* ------------------------- actions ------------------------- */

function swapSides() {
  const left = inputs.left.value;
  inputs.left.value = inputs.right.value;
  inputs.right.value = left;
  updateMeta();
  void runCompute();
  showToast("已交换左右");
}

function clearAll() {
  inputs.left.value = "";
  inputs.right.value = "";
  updateMeta();
  void runCompute();
  inputs.left.focus();
  showToast("已清空");
}

function buildReport() {
  const result = state.result;
  if (!result) return "";
  const lines = [];
  for (const row of result.rows) {
    if (row.type === "equal") lines.push(`  ${row.left.text}`);
    else if (row.type === "insert") lines.push(`+ ${row.right.text}`);
    else if (row.type === "delete") lines.push(`- ${row.left.text}`);
    else {
      lines.push(`- ${row.left.text}`);
      lines.push(`+ ${row.right.text}`);
    }
  }
  return lines.join("\n");
}

async function copyReport() {
  if (!state.result) await runCompute();
  const report = buildReport();
  if (!report) {
    showToast("没有可复制的内容");
    return;
  }
  try {
    await api.copy(report);
    showToast("已复制差异报告");
  } catch (error) {
    showToast(error && error.message ? error.message : "复制失败");
  }
}

/* ------------------------- drag & drop ------------------------- */

function wireDrop(side) {
  const pane = inputs[side].closest(".pane");
  const hint = pane.querySelector(".drop-hint");
  pane.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    pane.classList.add("drag-over");
    if (hint) hint.hidden = false;
  });
  pane.addEventListener("dragleave", (event) => {
    if (event.target === pane || !pane.contains(event.relatedTarget)) {
      pane.classList.remove("drag-over");
      if (hint) hint.hidden = true;
    }
  });
  pane.addEventListener("drop", async (event) => {
    event.preventDefault();
    pane.classList.remove("drag-over");
    if (hint) hint.hidden = true;
    const file =
      event.dataTransfer && event.dataTransfer.files
        ? event.dataTransfer.files[0]
        : null;
    if (!file) return;
    try {
      const text = await file.text();
      inputs[side].value = text.replace(/^\uFEFF/, "");
      updateMeta();
      void runCompute();
      showToast(`已读入 ${file.name}`);
    } catch (error) {
      showToast(error && error.message ? error.message : "读取文件失败");
    }
  });
}

/* ------------------------- search ------------------------- */

function searchSides() {
  if (state.searchScope === "left") return ["left"];
  if (state.searchScope === "right") return ["right"];
  return ["left", "right"];
}

function clearSearchMarks() {
  for (const { side, i } of state.decorated) {
    const node = mirrors[side].querySelector(`.mirror-line[data-line="${i}"]`);
    if (node) node.innerHTML = lineInnerHTML(side, i, null);
  }
  state.decorated = [];
}

function runSearch(reset) {
  clearSearchMarks();
  const query = ui.searchInput.value;
  state.matches = [];
  if (!query) {
    state.searchIndex = -1;
    updateSearchCount();
    return;
  }
  const lower = query.toLowerCase();
  const perLine = { left: new Map(), right: new Map() };

  for (const side of searchSides()) {
    const texts = state.lineText[side];
    for (let i = 0; i < texts.length; i++) {
      const lv = texts[i].toLowerCase();
      let from = 0;
      let p = lv.indexOf(lower, from);
      if (p < 0) continue;
      let bucket = perLine[side].get(i);
      if (!bucket) {
        bucket = [];
        perLine[side].set(i, bucket);
      }
      while (p >= 0) {
        const mi = state.matches.length;
        const hit = { side, line: i, start: p, len: query.length, mi };
        state.matches.push(hit);
        bucket.push(hit);
        from = p + query.length;
        p = lv.indexOf(lower, from);
      }
    }
  }

  for (const side of searchSides()) {
    for (const [i, bucket] of perLine[side]) {
      const node = mirrors[side].querySelector(`.mirror-line[data-line="${i}"]`);
      if (node) {
        node.innerHTML = lineInnerHTML(side, i, bucket);
        state.decorated.push({ side, i });
      }
    }
  }

  if (state.matches.length === 0) state.searchIndex = -1;
  else if (reset || state.searchIndex < 0 || state.searchIndex >= state.matches.length) {
    state.searchIndex = 0;
  }
  applyCurrentSearch(reset !== false);
  updateSearchCount();
}

function applyCurrentSearch(scroll) {
  for (const m of document.querySelectorAll(".search-mark.current")) {
    m.classList.remove("current");
  }
  if (state.searchIndex < 0) return;
  const mark = document.querySelector(`.search-mark[data-mi="${state.searchIndex}"]`);
  if (mark) mark.classList.add("current");
  const hit = state.matches[state.searchIndex];
  if (!hit) return;
  if (scroll) {
    const abs = (state.lineStart[hit.side][hit.line] ?? 0) + hit.start;
    const ta = inputs[hit.side];
    ta.focus({ preventScroll: true });
    try {
      ta.setSelectionRange(abs, abs + hit.len);
    } catch {
      /* ignore */
    }
    scrollLineToCenter(hit.side, hit.line);
  }
}

function updateSearchCount() {
  const total = state.matches.length;
  const current = total === 0 ? 0 : state.searchIndex + 1;
  ui.searchCount.textContent = `${current}/${total}`;
}

function gotoSearch(step) {
  const total = state.matches.length;
  if (total === 0) return;
  state.searchIndex = (state.searchIndex + step + total) % total;
  applyCurrentSearch(true);
  updateSearchCount();
}

function openSearch() {
  ui.searchBar.hidden = false;
  ui.searchInput.focus();
  ui.searchInput.select();
  if (ui.searchInput.value) runSearch(true);
}

function closeSearch() {
  ui.searchBar.hidden = true;
  clearSearchMarks();
  state.matches = [];
  state.searchIndex = -1;
  updateSearchCount();
}

function setSearchScope(scope) {
  state.searchScope = scope;
  writeString(STORAGE.searchScope, scope);
  ui.searchLeft.setAttribute("aria-pressed", String(scope === "left"));
  ui.searchBoth.setAttribute("aria-pressed", String(scope === "both"));
  ui.searchRight.setAttribute("aria-pressed", String(scope === "right"));
  if (!ui.searchBar.hidden) runSearch(true);
}

/* ------------------------- wrap / resize ------------------------- */

function applyWrapChange() {
  writeBool(STORAGE.wrap, ui.optWrap.checked);
  rebuild();
}

function onResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if (isWrap()) {
      for (const side of ["left", "right"]) {
        mirrors[side].style.width = `${inputs[side].clientWidth}px`;
        syncGutterHeights(side);
      }
      state.offsets.left = null;
      state.offsets.right = null;
    }
    visualSync("left");
    visualSync("right");
  });
}

/* ------------------------- wiring ------------------------- */

function wireEvents() {
  ui.optWrap.addEventListener("change", applyWrapChange);
  ui.optWhitespace.addEventListener("change", () => {
    writeBool(STORAGE.whitespace, ui.optWhitespace.checked);
    void runCompute();
  });
  ui.optCase.addEventListener("change", () => {
    writeBool(STORAGE.ignoreCase, ui.optCase.checked);
    void runCompute();
  });
  ui.optSync.addEventListener("change", () => {
    writeBool(STORAGE.sync, ui.optSync.checked);
  });

  for (const side of ["left", "right"]) {
    inputs[side].addEventListener("input", scheduleCompute);
    inputs[side].addEventListener("scroll", () => onScroll(side), { passive: true });
    wireDrop(side);
  }

  ui.navPrev.addEventListener("click", () => gotoDiff(-1));
  ui.navNext.addEventListener("click", () => gotoDiff(1));
  ui.btnSwap.addEventListener("click", swapSides);
  ui.btnClear.addEventListener("click", clearAll);
  ui.btnCopy.addEventListener("click", () => void copyReport());
  ui.closeWindow.addEventListener("click", () => api.close());

  ui.searchInput.addEventListener("input", () => runSearch(true));
  ui.searchPrev.addEventListener("click", () => gotoSearch(-1));
  ui.searchNext.addEventListener("click", () => gotoSearch(1));
  ui.searchClose.addEventListener("click", () => {
    closeSearch();
    inputs.left.focus();
  });
  ui.searchLeft.addEventListener("click", () => setSearchScope("left"));
  ui.searchBoth.addEventListener("click", () => setSearchScope("both"));
  ui.searchRight.addEventListener("click", () => setSearchScope("right"));

  ui.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      gotoSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      inputs.left.focus();
    }
  });

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === "F3") {
      event.preventDefault();
      gotoDiff(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      if (!ui.searchBar.hidden) {
        event.preventDefault();
        closeSearch();
        return;
      }
      const inField =
        event.target === inputs.left || event.target === inputs.right;
      if (!inField) {
        event.preventDefault();
        api.close();
      }
    }
  });

  window.addEventListener("resize", onResize);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(onResize);
    ro.observe(boxes.left);
    ro.observe(boxes.right);
  }
}

/* ------------------------- init ------------------------- */

function restoreOptions() {
  ui.optWrap.checked = readBool(STORAGE.wrap, true);
  ui.optWhitespace.checked = readBool(STORAGE.whitespace, false);
  ui.optCase.checked = readBool(STORAGE.ignoreCase, false);
  ui.optSync.checked = readBool(STORAGE.sync, true);
  const scope = readString(STORAGE.searchScope, "both");
  state.searchScope = scope === "left" || scope === "right" ? scope : "both";
  ui.searchLeft.setAttribute("aria-pressed", String(state.searchScope === "left"));
  ui.searchBoth.setAttribute("aria-pressed", String(state.searchScope === "both"));
  ui.searchRight.setAttribute("aria-pressed", String(state.searchScope === "right"));
}

function handleState(incoming) {
  if (!incoming) return;
  applyTheme(incoming.theme);
  if (typeof incoming.left === "string") inputs.left.value = incoming.left;
  if (typeof incoming.right === "string") inputs.right.value = incoming.right;
  updateMeta();
  void runCompute();
}

restoreOptions();
readMetrics();
wireEvents();
updateMeta();
void runCompute();

if (api && typeof api.onState === "function") api.onState(handleState);
if (api && typeof api.onTheme === "function") api.onTheme(applyTheme);
