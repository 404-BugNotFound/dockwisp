const THEME_VALUES = ["system", "light", "dark"];
const THEME_CACHE_KEY = "dockwisp.theme";
const TRANSPARENCY_CACHE_KEY = "dockwisp.panelTransparency";
const DEFAULT_PANEL_TRANSPARENCY = 12;

function normalizePanelTransparency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PANEL_TRANSPARENCY;
  return Math.min(40, Math.max(0, Math.round(numeric)));
}

function readCachedPanelTransparency() {
  try {
    return normalizePanelTransparency(window.localStorage.getItem(TRANSPARENCY_CACHE_KEY));
  } catch {
    return DEFAULT_PANEL_TRANSPARENCY;
  }
}

function applyPanelTransparency(value) {
  const percent = normalizePanelTransparency(value);
  document.documentElement.style.setProperty("--panel-alpha", String((100 - percent) / 100));
  const slider = document.querySelector("#panel-transparency");
  if (slider && Number(slider.value) !== percent) slider.value = String(percent);
  const label = document.querySelector("#panel-transparency-value");
  if (label) label.textContent = `${percent}%`;
  try {
    window.localStorage.setItem(TRANSPARENCY_CACHE_KEY, String(percent));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeTheme(value) {
  return THEME_VALUES.includes(value) ? value : "system";
}

function readCachedTheme() {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_CACHE_KEY));
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  const next = normalizeTheme(theme);
  // Explicitly set data-theme even for "system" so the CSS system branch applies.
  document.documentElement.dataset.theme = next;
  const choices = document.querySelector("#theme-choices");
  if (choices) {
    const buttons = choices.querySelectorAll("[data-theme-choice]");
    buttons.forEach((button) => {
      const active = button.dataset.themeChoice === next;
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.classList.toggle("is-active", active);
    });
  }
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, next);
  } catch {
    // Ignore storage failures (private mode / disabled storage).
  }
}

// Apply the cached theme/transparency before any DOM query to minimize flicker.
applyTheme(readCachedTheme());
applyPanelTransparency(readCachedPanelTransparency());

const api = window.dockwisp;
const launcher = document.querySelector("#launcher");
const settingsPanel = document.querySelector("#settings");
const searchBar = document.querySelector("#search-bar");
const query = document.querySelector("#query");
const results = document.querySelector("#results");
const home = document.querySelector("#home");
const toast = document.querySelector("#toast");
const contextMenu = document.querySelector("#context-menu");
const contentDropZone = document.querySelector("#content-drop-zone");
const fileTags = document.querySelector("#file-tags");
const customItemsList = document.querySelector("#custom-items-list");
const customItemsEmpty = document.querySelector("#custom-items-empty");
const customItemCount = document.querySelector("#custom-item-count");

const FILE_PREFIXES = ["文件 ", "file "];
const FILE_MODE_RE = /^(?:文件|file)\s+/i;
const MAX_VISIBLE_ROWS = 8;
const ROW_HEIGHT = 64; // one result row incl. margin
const BAR_HEIGHT = 64;
const LIST_PADDING = 20; // results top+bottom padding (8px top + 12px bottom)
const SETTINGS_WIDTH = 1000;
const SETTINGS_HEIGHT = 660;

let matches = [];
let homeMatches = [];
let selected = 0;
let searchToken = 0;
let lastResizeHeight = 0;
let contextTarget = null;
let toastTimer = null;
let hasSearched = false;
let filePollTimer = null;
let fileNextOffset = 0;
let fileHasMore = false;
let fileTotal = 0;
let fileLoadingMore = false;
let fileQuery = "";
let pointerX = -1;
let pointerY = -1;
let hoverOriginX = -1;
let hoverOriginY = -1;
let hoverArmed = false;
let windowDragEnabled = true;
let windowDrag = null;
let suppressNextClick = false;
// File-tag mode: paths shown as chips in the search bar (pasted/dropped files).
// While non-empty, searches run in files mode and the typed query filters the
// result list locally.
let fileTagPaths = [];
// Tracks in-flight "转换为 X" rows by match id so their row shows a spinner.
const convertingIds = new Set();

const WINDOW_DRAG_THRESHOLD = 4;
const WINDOW_DRAG_EDGE = 10;
const WINDOW_DRAG_SIDE = 48;

function isEdgeDragZone(event) {
  const rect = searchBar.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return (
    y < WINDOW_DRAG_EDGE ||
    y > rect.height - WINDOW_DRAG_EDGE ||
    x < WINDOW_DRAG_SIDE ||
    x > rect.width - WINDOW_DRAG_SIDE
  );
}

function isWindowDragZone(event) {
  // The trailing settings icon supports both click and drag.
  if (event.target.closest("#open-settings")) return true;
  return isEdgeDragZone(event);
}

function clearDragCursor() {
  searchBar.classList.remove("drag-zone");
  query.classList.remove("drag-zone");
}

function updateDragCursor(event) {
  if (!windowDragEnabled) {
    clearDragCursor();
    return;
  }
  const overBrand = event.target.closest("#open-settings");
  const edge = !overBrand && isEdgeDragZone(event);
  searchBar.classList.toggle("drag-zone", edge);
  query.classList.toggle("drag-zone", edge);
}

// Suppress the click that follows a drag (important for the settings icon).
searchBar.addEventListener(
  "click",
  (event) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);
searchBar.addEventListener("pointermove", updateDragCursor);
searchBar.addEventListener("pointerleave", clearDragCursor);

function applyWindowDragSetting(enabled) {
  windowDragEnabled = enabled !== false;
  document.body.classList.toggle("window-drag-disabled", !windowDragEnabled);
  if (!windowDragEnabled) clearDragCursor();
  const choices = document.querySelector("#window-drag-choices");
  if (!choices) return;
  for (const button of choices.querySelectorAll("[data-drag-choice]")) {
    const active =
      (button.dataset.dragChoice === "enabled") === windowDragEnabled;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.classList.toggle("is-active", active);
  }
}

function finishWindowDrag(event) {
  if (!windowDrag) return;
  const { pointerId, active } = windowDrag;
  windowDrag = null;
  document.body.classList.remove("window-dragging");
  try {
    searchBar.releasePointerCapture(pointerId);
  } catch {
    // The pointer may already be released.
  }
  if (active && api && typeof api.dragEnd === "function") api.dragEnd();
  if (active) {
    suppressNextClick = true;
    setTimeout(() => {
      suppressNextClick = false;
    }, 250);
  }
}

// Hold anywhere on the search bar (except the settings icon) to move the
// window. A small threshold keeps normal clicks/caret placement working.
searchBar.addEventListener("pointerdown", (event) => {
  if (!windowDragEnabled || event.button !== 0 || windowDrag) return;
  if (!isWindowDragZone(event)) return;
  windowDrag = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    active: false,
  };
});

searchBar.addEventListener("pointermove", (event) => {
  if (!windowDrag || event.pointerId !== windowDrag.pointerId) return;
  const dx = event.screenX - windowDrag.startX;
  const dy = event.screenY - windowDrag.startY;
  if (!windowDrag.active) {
    if (Math.hypot(dx, dy) < WINDOW_DRAG_THRESHOLD) return;
    windowDrag.active = true;
    document.body.classList.add("window-dragging");
    try {
      searchBar.setPointerCapture(windowDrag.pointerId);
    } catch {
      // Capture is best-effort; the window follows the cursor either way.
    }
    if (api && typeof api.dragStart === "function") {
      api.dragStart(windowDrag.startX, windowDrag.startY);
    }
  }
  event.preventDefault();
  if (api && typeof api.dragMove === "function") {
    api.dragMove(event.screenX, event.screenY);
  }
});

searchBar.addEventListener("pointerup", finishWindowDrag);
searchBar.addEventListener("pointercancel", finishWindowDrag);
searchBar.addEventListener("lostpointercapture", finishWindowDrag);
window.addEventListener("blur", () => finishWindowDrag(null));

function clearFilePoll() {
  if (filePollTimer) {
    clearTimeout(filePollTimer);
    filePollTimer = null;
  }
}

function resetFilePagination() {
  fileNextOffset = 0;
  fileHasMore = false;
  fileTotal = 0;
  fileLoadingMore = false;
  fileQuery = "";
  results.setAttribute("aria-label", "搜索结果");
}

function unpackSearchResponse(response) {
  if (Array.isArray(response)) return { list: response, page: null };
  if (!response || typeof response !== "object") return { list: [], page: null };
  return {
    list: Array.isArray(response.matches) ? response.matches : [],
    page:
      response.filePage && typeof response.filePage === "object"
        ? response.filePage
        : null,
  };
}

function applyFilePage(page, pendingQuery, requestedOffset = 0) {
  if (!page) {
    resetFilePagination();
    return;
  }
  const nextOffset = Number.isSafeInteger(page.nextOffset)
    ? Math.max(0, page.nextOffset)
    : requestedOffset;
  fileNextOffset = nextOffset;
  fileHasMore = page.hasMore === true && nextOffset > requestedOffset;
  fileTotal = Number.isSafeInteger(page.total) ? Math.max(0, page.total) : 0;
  fileQuery = pendingQuery;
  results.setAttribute(
    "aria-label",
    fileTotal > 0 ? `搜索结果，已加载 ${Math.min(nextOffset, fileTotal)} / ${fileTotal}` : "搜索结果",
  );
}

function isFileModeInput(resolved) {
  return (
    !!resolved &&
    resolved.type === "text" &&
    typeof resolved.data === "string" &&
    FILE_MODE_RE.test(resolved.data)
  );
}

// A status row (loading spinner / indexing / info message) is non-interactive:
// Enter and click must not execute anything.
function isStatusRow(match) {
  return (
    !!match &&
    (match.loading === true ||
      match.action === "file-indexing" ||
      match.action === "info")
  );
}

function isSpinnerRow(match) {
  return !!match && (match.loading === true || match.action === "file-indexing");
}

document.addEventListener("mousemove", (event) => {
  // Use screen coordinates: moving the window (offscreen reveal, resize) changes
  // clientX/clientY under a stationary pointer, but not screenX/screenY.
  pointerX = event.screenX;
  pointerY = event.screenY;
});

function iconFor(match) {
  if (isSpinnerRow(match)) {
    const spinner = document.createElement("span");
    spinner.className = "fallback-icon spinner";
    return spinner;
  }
  if (match.iconUrl) {
    const image = document.createElement("img");
    image.src = match.iconUrl;
    image.alt = "";
    image.draggable = false;
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = "fallback-icon";
  if (match.kind === "file") {
    fallback.classList.add("file-fallback");
    return fallback;
  }
  fallback.textContent = match.kind === "app" ? "A" : match.kind === "plugin" ? "P" : "•";
  return fallback;
}

function desiredHeight() {
  if (!settingsPanel.hidden) return SETTINGS_HEIGHT;
  // Home grid visible
  if (!home.hidden) {
    const rect = home.getBoundingClientRect();
    const contentHeight = home.scrollHeight;
    const maxHome = ROW_HEIGHT * MAX_VISIBLE_ROWS;
    return Math.round(BAR_HEIGHT + Math.min(contentHeight, maxHome) + 2);
  }
  // Results visible
  if (!results.hidden && matches.length > 0) {
    const rows = Math.min(matches.length, MAX_VISIBLE_ROWS);
    return Math.round(BAR_HEIGHT + rows * ROW_HEIGHT + LIST_PADDING);
  }
  // Compact: just the search bar
  return BAR_HEIGHT;
}

function applyResize() {
  const height = desiredHeight();
  if (height === lastResizeHeight) return;
  lastResizeHeight = height;
  api.resize(height, settingsPanel.hidden ? undefined : SETTINGS_WIDTH);
}

function prepareResultRender() {
  // A fresh result set must start with the first (most relevant) row selected.
  // Layout changes under a stationary pointer can emit a mousemove with the
  // same coordinates; only arm hover selection after the pointer really moves.
  hoverOriginX = pointerX;
  hoverOriginY = pointerY;
  hoverArmed = false;
}

function appendRenderedResults(startIndex) {
  for (let index = startIndex; index < matches.length; index += 1) {
    const match = matches[index];
    const item = document.createElement("li");
    const statusRow = isStatusRow(match);
    item.className = `result${index === selected ? " selected" : ""}${statusRow ? " status" : ""}`;
    item.dataset.index = String(index);
    item.append(iconFor(match));
    const text = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = match.title;
    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = match.subtitle || "";
    text.append(title, subtitle);
    item.append(text);
    if (statusRow) {
      // Non-interactive: no hover-select, no click, no context menu.
      results.append(item);
      continue;
    }
    item.addEventListener("mousemove", (event) => {
      if (pointerX < 0) {
        // First pointer event after the window is shown: treat it as the
        // baseline so a window appearing under a stationary cursor cannot
        // steal the default selection.
        pointerX = event.screenX;
        pointerY = event.screenY;
        hoverOriginX = pointerX;
        hoverOriginY = pointerY;
        return;
      }
      if (!hoverArmed) {
        if (
          Math.abs(event.screenX - hoverOriginX) < 2 &&
          Math.abs(event.screenY - hoverOriginY) < 2
        ) {
          return;
        }
        hoverArmed = true;
      }
      if (selected !== index) {
        selected = index;
        syncSelection();
      }
    });
    item.addEventListener("click", () => activate(index));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(match, event.clientX, event.clientY);
    });
    results.append(item);
  }
}

function renderResults() {
  prepareResultRender();
  results.replaceChildren();
  results.scrollTop = 0;
  appendRenderedResults(0);
}

function syncSelection() {
  const children = results.children;
  for (let i = 0; i < children.length; i += 1) {
    children[i].classList.toggle("selected", i === selected);
  }
}

function renderHome() {
  home.replaceChildren();
  homeMatches.forEach((match) => {
    const item = document.createElement("div");
    item.className = "home-item";
    item.append(iconFor(match));
    const label = document.createElement("span");
    label.className = "home-label";
    label.textContent = match.title;
    item.append(label);
    item.addEventListener("click", () => api.execute(match.id));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(match, event.clientX, event.clientY);
    });
    home.append(item);
  });
}

function showEmptyHome() {
  results.hidden = true;
  if (homeMatches.length > 0) {
    renderHome();
    home.hidden = false;
  } else {
    home.hidden = true;
  }
  applyResize();
}

function showResults() {
  home.hidden = true;
  results.hidden = matches.length === 0;
  renderResults();
  applyResize();
}

// In file-tag mode the typed text narrows the returned rows locally (e.g.
// "pdf" keeps only 转换为 PDF). Status rows and the "更多选项" entry are kept.
function applyFileTagFilter(list) {
  if (fileTagPaths.length === 0) return list;
  const needle = query.value.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((match) => {
    if (isStatusRow(match)) return true;
    if (match.action === "convert") return true; // keep the "更多选项" entry
    const haystack = `${match.title || ""} ${match.subtitle || ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

async function runSearch(input, quiet = false) {
  // File-tag mode: always search the tagged files; the typed text filters the
  // returned rows locally (e.g. "pdf" keeps only 转换为 PDF).
  // returned rows locally (e.g. "pdf" keeps only 转换为 PDF).
  const tagMode = !input && fileTagPaths.length > 0;
  const resolved = input || (tagMode
    ? { type: "files", data: fileTagPaths.slice() }
    : { type: "text", data: query.value });
  const token = ++searchToken;
  const fileMode = isFileModeInput(resolved);
  // Any new search invalidates a pending indexing re-poll.
  clearFilePoll();
  resetFilePagination();

  if (fileMode && !quiet) {
    // Show an immediate loading row so pressing Enter visibly expands the panel
    // before the (possibly slow) Everything query resolves.
    matches = [
      {
        kind: "builtin",
        action: "file-indexing",
        title: "正在搜索文件…",
        subtitle: "Everything 全盘索引",
        loading: true,
        score: 9999,
      },
    ];
    selected = 0;
    showResults();
  }

  try {
    const next = await api.search(resolved);
    if (token !== searchToken) return;
    hasSearched = true;
    const { list, page } = unpackSearchResponse(next);
    const isEmptyText =
      resolved.type === "text" && (!resolved.data || resolved.data.length === 0);

    if (isEmptyText) {
      homeMatches = list;
      matches = [];
      selected = 0;
      showEmptyHome();
      return;
    }

    if (fileMode) {
      applyFilePage(page, resolved.data, 0);
      const indexing = list.find((match) => match.action === "file-indexing");
      if (indexing) {
        matches = [{ ...indexing, loading: true }];
        selected = 0;
        showResults();
        // Poll again shortly, but only while the same query is still showing.
        const pending = resolved.data;
        filePollTimer = setTimeout(() => {
          filePollTimer = null;
          if (
            launcher.hidden ||
            !settingsPanel.hidden ||
            query.value !== pending
          ) {
            return;
          }
          runSearch({ type: "text", data: query.value }, true);
        }, 1000);
        return;
      }
      if (list.length === 0) {
        matches = [
          {
            kind: "builtin",
            action: "info",
            title: "没有找到文件",
            subtitle: "Everything 全盘搜索 · 换个关键词试试",
          },
        ];
        selected = 0;
        showResults();
        return;
      }
    }

    matches = applyFileTagFilter(list);
    selected = 0;
    showResults();
  } catch (error) {
    if (token !== searchToken) return;
    const message = error.message || String(error);
    if (fileMode) {
      matches = [
        {
          kind: "builtin",
          action: "info",
          title: "文件搜索失败",
          subtitle: message,
        },
      ];
      selected = 0;
      showResults();
    } else {
      showToast(message);
    }
  }
}

function isNearFileListEnd() {
  return results.scrollHeight - results.scrollTop - results.clientHeight <= ROW_HEIGHT * 2;
}

async function loadMoreFiles() {
  if (
    fileLoadingMore ||
    !fileHasMore ||
    !fileQuery ||
    query.value !== fileQuery ||
    launcher.hidden ||
    !settingsPanel.hidden
  ) {
    return;
  }

  const pendingQuery = fileQuery;
  const requestedOffset = fileNextOffset;
  const token = searchToken;
  fileLoadingMore = true;
  try {
    const response = await api.search({
      type: "text",
      data: pendingQuery,
      fileOffset: requestedOffset,
    });
    if (
      token !== searchToken ||
      query.value !== pendingQuery ||
      launcher.hidden ||
      !settingsPanel.hidden
    ) {
      return;
    }

    const { list, page } = unpackSearchResponse(response);
    const existing = new Set(matches.map((match) => match.id));
    const additions = list.filter(
      (match) => !isStatusRow(match) && match.id && !existing.has(match.id),
    );
    const startIndex = matches.length;
    for (const match of additions) {
      existing.add(match.id);
      matches.push(match);
    }
    applyFilePage(page, pendingQuery, requestedOffset);
    if (additions.length > 0) {
      appendRenderedResults(startIndex);
      applyResize();
    }
  } catch (error) {
    if (token === searchToken) showToast(error.message || String(error));
  } finally {
    if (token === searchToken) fileLoadingMore = false;
  }
}

results.addEventListener("scroll", () => {
  if (isNearFileListEnd()) void loadMoreFiles();
});

function activate(index) {
  selected = index;
  const match = matches[selected];
  if (!match) return;
  // Status rows (loading / indexing / info) are not actionable.
  if (isStatusRow(match)) return;
  // Builtin file-search switch
  if (match.kind === "builtin" && match.action === "file-search") {
    query.value = FILE_PREFIXES[0] + (match.payload ?? "");
    closeContextMenu();
    runSearch();
    query.focus();
    return;
  }
  // Builtin window-search switch
  if (match.kind === "builtin" && match.action === "window-search") {
    query.value = "窗口 " + (match.payload ?? "");
    closeContextMenu();
    runSearch();
    query.focus();
    return;
  }
  // Convert-to: run in-process, showing a spinner on this row, then a toast
  // with open / reveal actions. The launcher stays open during conversion.
  if (match.kind === "builtin" && match.action === "convert-to") {
    void runConvertTo(match);
    return;
  }
  executeMatch(match);
}

async function runConvertTo(match) {
  if (convertingIds.has(match.id)) return;
  convertingIds.add(match.id);
  const originalTitle = match.title;
  const originalSubtitle = match.subtitle;
  match.loading = true;
  match.subtitle = "转换中…";
  renderResults();
  try {
    const result = await api.execute(match.id);
    match.loading = false;
    if (result && result.needsDownload) {
      // The convert window took over (download confirmation + progress).
      return;
    }
    if (result && result.ok) {
      const outputs = (result.outputs || []).filter(Boolean);
      match.subtitle = outputs.length
        ? `已转换 · ${baseNameOf(outputs[0])}${outputs.length > 1 ? ` 等 ${outputs.length} 个文件` : ""}`
        : "已完成";
      renderResults();
      showToast(outputs.length ? `转换完成：${baseNameOf(outputs[0])}` : "转换完成");
      showConvertActions(outputs);
    } else {
      match.title = originalTitle;
      match.subtitle = originalSubtitle;
      renderResults();
      showToast((result && result.message) || "转换失败");
    }
  } catch (error) {
    match.loading = false;
    match.title = originalTitle;
    match.subtitle = originalSubtitle;
    renderResults();
    showToast(error.message || String(error));
  } finally {
    convertingIds.delete(match.id);
  }
}

async function executeMatch(match) {
  if (!match) return;
  try {
    await api.execute(match.id);
  } catch (error) {
    showToast(error.message || String(error));
  }
}

function selectBy(offset) {
  if (!matches.length) return;
  if (
    offset > 0 &&
    selected === matches.length - 1 &&
    (fileHasMore || fileLoadingMore)
  ) {
    void loadMoreFiles();
    return;
  }
  selected = (selected + offset + matches.length) % matches.length;
  syncSelection();
  results.children[selected]?.scrollIntoView({ block: "nearest" });
  if (offset > 0 && selected >= matches.length - MAX_VISIBLE_ROWS) {
    void loadMoreFiles();
  }
}

/* ---------- context menu ---------- */
function canRunAsAdmin(match) {
  if (match.kind !== "app" || !match.path) return false;
  const lower = match.path.toLowerCase();
  return lower.endsWith(".exe") || lower.endsWith(".lnk") || lower.endsWith(".appref-ms");
}

function buildContextItems(match) {
  const items = [];
  if (match.kind === "app" || match.kind === "file") {
    if (match.kind === "file") {
      items.push({ action: "preview", label: "预览" });
    }
    items.push({ action: "open", label: "打开" });
    items.push({ action: "reveal", label: "打开所在目录" });
    items.push({ action: "copy-path", label: "复制路径" });
    items.push({ action: "copy-name", label: "复制文件名" });
    if (canRunAsAdmin(match)) {
      items.push({ action: "run-as-admin", label: "以管理员身份运行" });
    }
    items.push({ separator: true });
  }
  items.push({ action: "pin", label: match.pinned ? "取消固定" : "固定到主页" });
  return items;
}

async function handleContextAction(match, action) {
  if (action === "pin") {
    try {
      const nextHome = await api.pinMatch(match.id, !match.pinned);
      homeMatches = nextHome || [];
      // Refresh current view so pinned state updates.
      if (query.value) {
        runSearch();
      } else {
        showEmptyHome();
      }
    } catch (error) {
      showToast(error.message || String(error));
    }
    return;
  }
  // File/app actions: open, reveal, copy-path, copy-name, run-as-admin.
  try {
    const result = await api.itemAction(match.id, action);
    if (result && result.message) {
      showToast(result.message);
    } else if (result && result.ok === false) {
      showToast("操作失败");
    }
    // When result.hide is true the main process already hides the launcher.
  } catch (error) {
    showToast(error.message || String(error));
  }
}

function openContextMenu(match, x, y) {
  // builtin / file-status / info rows have no menu.
  if (!match || (match.kind !== "app" && match.kind !== "plugin" && match.kind !== "file")) {
    return;
  }
  if (isStatusRow(match)) return;
  contextTarget = match;
  contextMenu.replaceChildren();
  buildContextItems(match).forEach((entry) => {
    if (entry.separator) {
      const sep = document.createElement("div");
      sep.className = "context-separator";
      contextMenu.append(sep);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-item";
    button.setAttribute("role", "menuitem");
    button.dataset.action = entry.action;
    button.textContent = entry.label;
    button.addEventListener("click", async () => {
      const target = contextTarget;
      closeContextMenu();
      if (!target) return;
      await handleContextAction(target, entry.action);
    });
    contextMenu.append(button);
  });
  contextMenu.hidden = false;
  const menuRect = contextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - menuRect.width - 6;
  const maxY = window.innerHeight - menuRect.height - 6;
  contextMenu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  contextMenu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
}

function closeContextMenu() {
  contextMenu.hidden = true;
  contextTarget = null;
}

document.addEventListener("mousedown", (event) => {
  if (!contextMenu.hidden && !contextMenu.contains(event.target)) {
    closeContextMenu();
  }
});

window.addEventListener("blur", () => {
  // Stop polling when the window loses focus (it will be hidden shortly).
  clearFilePoll();
});

/* ---------- toast ---------- */
function showToast(message) {
  if (!message) return;
  toast.classList.remove("toast-actions");
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2500);
}

// After a successful convert, offer 打开 / 打开所在目录 on the first output.
function showConvertActions(outputs) {
  const target = (outputs || []).filter(Boolean)[0];
  if (!target) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.classList.add("toast-actions");
  toast.replaceChildren();
  const label = document.createElement("span");
  label.className = "toast-label";
  label.textContent = `已转换：${baseNameOf(target)}`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "toast-button";
  open.textContent = "打开";
  open.addEventListener("click", () => {
    void api.openPath(target);
    toast.hidden = true;
  });
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "toast-button";
  reveal.textContent = "打开所在目录";
  reveal.addEventListener("click", () => {
    void api.revealPath(target);
    toast.hidden = true;
  });
  toast.append(label, open, reveal);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 6000);
}

/* ---------- file tags (pasted / dropped files) ---------- */
function baseNameOf(filePath) {
  const normalized = String(filePath || "").replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return normalized.slice(slash + 1) || normalized;
}

function renderFileTags() {
  if (!fileTags) return;
  fileTags.replaceChildren();
  if (fileTagPaths.length === 0) {
    fileTags.hidden = true;
    query.placeholder = "Dockwisp · 搜索应用、文件或命令";
    return;
  }
  fileTags.hidden = false;
  query.placeholder = "输入可过滤转换目标…";
  for (const filePath of fileTagPaths) {
    const tag = document.createElement("span");
    tag.className = "file-tag";
    tag.title = filePath;
    const icon = document.createElement("span");
    icon.className = "file-tag-icon";
    const name = document.createElement("span");
    name.className = "file-tag-name";
    name.textContent = baseNameOf(filePath);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-tag-remove";
    remove.setAttribute("aria-label", `移除 ${baseNameOf(filePath)}`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFileTag(filePath);
    });
    tag.append(icon, name, remove);
    fileTags.append(tag);
  }
}

function enterFileTagMode(paths) {
  const unique = [];
  const seen = new Set();
  for (const filePath of [...fileTagPaths, ...paths]) {
    const key = String(filePath).toLowerCase();
    if (!filePath || seen.has(key)) continue;
    seen.add(key);
    unique.push(filePath);
  }
  fileTagPaths = unique;
  renderFileTags();
  closeContextMenu();
  runSearch();
  query.focus();
}

function removeFileTag(filePath) {
  const key = String(filePath).toLowerCase();
  fileTagPaths = fileTagPaths.filter((item) => String(item).toLowerCase() !== key);
  renderFileTags();
  runSearch();
  query.focus();
}

function clearFileTags() {
  if (fileTagPaths.length === 0) return;
  fileTagPaths = [];
  renderFileTags();
}

/* ---------- input & keyboard ---------- */
query.addEventListener("input", () => {
  closeContextMenu();
  runSearch();
});

// Pasting files copied in Explorer shows them as file tags in the search bar
// (the results list then offers "转换为 X"). Plain-text pastes keep the default
// behaviour. We no longer early-return on the presence of text/plain: Explorer
// copies can expose both a text representation and the file list, and the
// clipboard fallback resolves the real paths.
query.addEventListener("paste", async (event) => {
  const clip = event.clipboardData;
  const types = [...(clip?.types || [])];
  const hasFiles = types.includes("Files") || (clip?.files && clip.files.length > 0);
  // A pure-text paste (no file payload) keeps the native behaviour.
  if (!hasFiles && types.includes("text/plain")) return;
  const fromEvent = api.pathsForFiles([...(clip?.files || [])]).filter(Boolean);
  const paths = fromEvent.length ? fromEvent : await api.clipboardFiles();
  if (!paths || !paths.length) return;
  // Resolved real file paths: take over the paste and show file tags.
  event.preventDefault();
  enterFileTagMode(paths);
});

query.addEventListener("keydown", (event) => {
  if (event.key === "Backspace" && query.value === "" && fileTagPaths.length > 0) {
    event.preventDefault();
    removeFileTag(fileTagPaths[fileTagPaths.length - 1]);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectBy(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    selectBy(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    activate(selected);
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (!contextMenu.hidden) {
      closeContextMenu();
    } else if (fileTagPaths.length > 0) {
      // First Escape exits file-tag mode; a second one hides the launcher.
      clearFileTags();
      runSearch();
    } else {
      clearFilePoll();
      api.hide();
    }
  }
});

/* ---------- drag & drop ---------- */
document.addEventListener("dragover", (event) => {
  if (!settingsPanel.hidden) {
    event.preventDefault();
    if (!contentDropZone?.contains(event.target)) event.dataTransfer.dropEffect = "none";
    return;
  }
  event.preventDefault();
  searchBar.classList.add("drag-active");
});
document.addEventListener("dragleave", (event) => {
  if (!settingsPanel.hidden) return;
  if (event.relatedTarget === null) {
    searchBar.classList.remove("drag-active");
  }
});
document.addEventListener("drop", async (event) => {
  if (!settingsPanel.hidden) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  searchBar.classList.remove("drag-active");
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  const paths = api.pathsForFiles(files).filter(Boolean);
  if (!paths.length) return;
  try {
    // Launchable files (.exe/.lnk/…) are added as custom apps as before; any
    // other dropped files become file tags so the convert targets show up.
    const result = await api.addPaths(paths);
    const added = (result && result.added) || [];
    const addedPaths = new Set(added.map((entry) => String(entry.path || "").toLowerCase()));
    const remaining = paths.filter((item) => !addedPaths.has(String(item).toLowerCase()));
    if (added.length > 0) {
      const names = added.map((entry) => entry.name).join("、");
      showToast(`已添加：${names}`);
    }
    if (remaining.length > 0) {
      enterFileTagMode(remaining);
    } else if (added.length > 0) {
      query.value = added[0].name;
      runSearch();
      query.focus();
    }
  } catch (error) {
    showToast(error.message || String(error));
  }
});

if (contentDropZone) {
  contentDropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    contentDropZone.classList.add("is-dragging");
  });
  contentDropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    contentDropZone.classList.add("is-dragging");
  });
  contentDropZone.addEventListener("dragleave", (event) => {
    if (!contentDropZone.contains(event.relatedTarget)) {
      contentDropZone.classList.remove("is-dragging");
    }
  });
  contentDropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    contentDropZone.classList.remove("is-dragging");
    const files = [...event.dataTransfer.files];
    const paths = api.pathsForFiles(files);
    if (!paths.length) return;
    try {
      const result = await api.addPaths(paths);
      await loadCustomItems();
      reportCustomItemResult(result, "应用");
    } catch (error) {
      document.querySelector("#settings-status").textContent =
        error.message || String(error);
    }
  });
}

/* ---------- settings ---------- */
const HUB_PAGES = new Set(["settings", "plugins"]);
let hubPage = "settings";
let pluginList = [];
let customItems = [];

function showHubPage(page = "settings") {
  const next = HUB_PAGES.has(page) ? page : "settings";
  hubPage = next;
  for (const button of document.querySelectorAll(".nav-item[data-page]")) {
    const active = button.dataset.page === next;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
  document.querySelector("#page-settings").hidden = next !== "settings";
  document.querySelector("#page-plugins").hidden = next !== "plugins";
  document.querySelector("#save-settings").hidden = next !== "settings";
  if (next === "plugins") void loadPlugins();
}

function createPluginCard(plugin) {
  const card = document.createElement("div");
  card.className = "plugin-card";
  card.setAttribute("role", "listitem");
  card.tabIndex = 0;
  card.title = plugin.builtin ? `打开${plugin.name}` : `搜索 ${plugin.name} 的功能`;

  const head = document.createElement("div");
  head.className = "plugin-card-head";
  if (plugin.iconUrl) {
    const icon = document.createElement("img");
    icon.className = "plugin-icon";
    icon.src = plugin.iconUrl;
    icon.alt = "";
    head.append(icon);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "plugin-icon fallback";
    fallback.textContent = plugin.name ? plugin.name.slice(0, 1) : "✦";
    head.append(fallback);
  }
  const title = document.createElement("div");
  title.className = "plugin-title";
  const name = document.createElement("div");
  name.className = "plugin-name";
  name.textContent = plugin.name || plugin.id;
  const version = document.createElement("div");
  version.className = "plugin-version";
  version.textContent = plugin.builtin ? "内置工具" : `v${plugin.version || "0.0.0"}`;
  title.append(name, version);
  head.append(title);
  card.append(head);

  const description = document.createElement("div");
  description.className = "plugin-desc";
  description.textContent = plugin.description || "已安装插件";
  card.append(description);

  const foot = document.createElement("div");
  foot.className = "plugin-foot";
  const count = document.createElement("span");
  count.textContent = `${plugin.featureCount || 0} 个功能`;
  foot.append(count);
  if (plugin.builtin) {
    const badge = document.createElement("span");
    badge.className = "plugin-badge";
    badge.textContent = "内置";
    foot.append(badge);
  }
  card.append(foot);

  const activate = () => {
    if (plugin.builtin) {
      closeSettings();
      if (api && typeof api.openBuiltin === "function") api.openBuiltin(plugin.id);
      return;
    }
    closeSettings();
    query.value = plugin.name;
    runSearch();
    query.focus();
  };
  card.addEventListener("click", activate);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  return card;
}

function fuzzyPluginMatch(text, query) {
  const haystack = String(text || "").toLowerCase();
  const needle = String(query || "").toLowerCase();
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  // Subsequence match: "j工" still finds "JSON 工具".
  let index = 0;
  for (const character of needle) {
    index = haystack.indexOf(character, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

function renderPluginGrid() {
  const grid = document.querySelector("#plugin-grid");
  const empty = document.querySelector("#plugin-empty");
  if (!grid || !empty) return;
  const filter = (document.querySelector("#plugin-search")?.value || "").trim();
  const items = pluginList.filter((plugin) =>
    fuzzyPluginMatch(`${plugin.name} ${plugin.description}`, filter),
  );
  grid.replaceChildren(...items.map(createPluginCard));
  empty.hidden = items.length > 0;
}

async function loadPlugins() {
  if (!api || typeof api.listPlugins !== "function") return;
  try {
    pluginList = (await api.listPlugins()) || [];
    renderPluginGrid();
  } catch (error) {
    document.querySelector("#settings-status").textContent =
      error.message || String(error);
  }
}

function customItemTypeLabel(item) {
  if (item.kind === "directory") return "索引目录";
  if (item.kind === "application") return "应用";
  return "文件";
}

function renderCustomItems() {
  if (!customItemsList || !customItemsEmpty || !customItemCount) return;
  customItemsList.replaceChildren();
  customItemCount.textContent = `${customItems.length} 项`;
  customItemsEmpty.hidden = customItems.length > 0;
  for (const item of customItems) {
    const row = document.createElement("div");
    row.className = `custom-item${item.exists === false ? " is-missing" : ""}`;
    row.setAttribute("role", "listitem");

    const info = document.createElement("div");
    info.className = "custom-item-info";
    const title = document.createElement("div");
    title.className = "custom-item-title";
    const name = document.createElement("strong");
    name.textContent = item.name || item.path;
    const badge = document.createElement("span");
    badge.className = "custom-item-badge";
    badge.textContent = `${customItemTypeLabel(item)}${item.exists === false ? " · 文件缺失" : ""}`;
    title.append(name, badge);
    const filePath = document.createElement("div");
    filePath.className = "custom-item-path";
    filePath.textContent = item.path;
    filePath.title = item.path;
    info.append(title, filePath);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "custom-item-remove";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除 ${item.name || item.path}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        customItems = (await api.removeCustomItem(item.path)) || [];
        renderCustomItems();
        document.querySelector("#settings-status").textContent =
          `已移除：${item.name || item.path}`;
      } catch (error) {
        remove.disabled = false;
        document.querySelector("#settings-status").textContent =
          error.message || String(error);
      }
    });
    row.append(info, remove);
    customItemsList.append(row);
  }
}

async function loadCustomItems() {
  if (!api || typeof api.listCustomItems !== "function") return;
  try {
    customItems = (await api.listCustomItems()) || [];
    renderCustomItems();
  } catch (error) {
    document.querySelector("#settings-status").textContent =
      error.message || String(error);
  }
}

function reportCustomItemResult(result, itemLabel) {
  const added = (result && result.added) || [];
  const skipped = (result && result.skipped) || [];
  if (added.length > 0) {
    const names = added.map((item) => item.name).join("、");
    document.querySelector("#settings-status").textContent =
      `已添加${itemLabel}：${names}${skipped.length ? ` · 跳过 ${skipped.length} 项` : ""}`;
  } else if (skipped.length > 0) {
    document.querySelector("#settings-status").textContent =
      `未添加：所选项目已存在或不是受支持的${itemLabel}`;
  }
}

async function openSettings(page = "settings") {
  closeContextMenu();
  clearFilePoll();
  clearFileTags();
  launcher.hidden = true;
  settingsPanel.hidden = false;
  lastResizeHeight = 0;
  api.resize(SETTINGS_HEIGHT, SETTINGS_WIDTH);
  const settings = await api.getSettings();
  applyTheme(settings.theme);
  applyWindowDragSetting(settings.windowDragEnabled);
  applyPanelTransparency(settings.panelTransparency);
  document.querySelector("#hotkey").value = settings.hotkey;
  document.querySelector("#screenshot-hotkey").value = settings.screenshotHotkey || "";
  document.querySelector("#long-press").value = settings.longPressMs;
  document.querySelector("#translation-enabled").checked = settings.translationEnabled;
  document.querySelector("#launch-at-login").checked = settings.launchAtLogin;
  document.querySelector("#translation-provider").value = settings.translation.provider;
  document.querySelector("#translation-endpoint").value = settings.translation.endpoint;
  document.querySelector("#translation-key").value = settings.translation.apiKey;
  document.querySelector("#process-blacklist").value = settings.processBlacklist.join("\n");
  const hotkeyState = document.querySelector("#hotkey-state");
  hotkeyState.textContent = settings.registeredHotkey
    ? `快捷键已启用 · ${settings.registeredHotkey}`
    : "快捷键注册失败";
  hotkeyState.className = `health-badge ${settings.registeredHotkey ? "ok" : "warn"}`;
  const screenshotHotkeyState = document.querySelector("#screenshot-hotkey-state");
  screenshotHotkeyState.textContent = settings.registeredScreenshotHotkey
    ? `截图快捷键已启用 · ${settings.registeredScreenshotHotkey}`
    : "截图快捷键注册失败";
  screenshotHotkeyState.className = `health-badge ${settings.registeredScreenshotHotkey ? "ok" : "warn"}`;
  const helperState = document.querySelector("#helper-state");
  helperState.textContent = settings.inputHelperReady ? "原生输入服务正常" : "原生输入服务未就绪";
  helperState.className = `health-badge ${settings.inputHelperReady ? "ok" : "warn"}`;
  const translationDiagnostics = settings.translationDiagnostics || {};
  document.querySelector("#translation-diagnostics").textContent = [
    `状态：${translationDiagnostics.lastStage || "等待中键"}`,
    `中键按下：${translationDiagnostics.middleDowns || 0} 次 · 有效长按：${translationDiagnostics.longPresses || 0} 次`,
    `上次取词：${translationDiagnostics.lastSelectedLength || 0} 字符${translationDiagnostics.lastError ? ` · ${translationDiagnostics.lastError}` : ""}`,
  ].join("\n");
  const diagnostics = [
    ...(settings.pluginErrors || []).map((item) => `${item.directory}: ${item.message}`),
  ];
  document.querySelector("#settings-status").textContent = diagnostics.join("\n") || "所有配置均可用";
  const version = document.querySelector("#hub-version");
  if (version) version.textContent = settings.appVersion ? `v${settings.appVersion}` : "";
  const updateCurrent = document.querySelector("#update-current");
  if (updateCurrent) updateCurrent.textContent = settings.appVersion ? `v${settings.appVersion}` : "v—";
  await loadCustomItems();
  showHubPage(page);
}

function closeSettings() {
  settingsPanel.hidden = true;
  launcher.hidden = false;
  lastResizeHeight = 0;
  api.resize(BAR_HEIGHT);
  query.focus();
  runSearch();
}

document.querySelector("#open-settings").addEventListener("click", () => {
  openSettings();
});

document.querySelector("#settings-back").addEventListener("click", closeSettings);

document.querySelector("#save-settings").addEventListener("click", async () => {
  const processBlacklist = document
    .querySelector("#process-blacklist")
    .value.split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  try {
    const saved = await api.updateSettings({
      hotkey: document.querySelector("#hotkey").value,
      screenshotHotkey: document.querySelector("#screenshot-hotkey").value,
      windowDragEnabled,
      panelTransparency: normalizePanelTransparency(
        document.querySelector("#panel-transparency").value,
      ),
      longPressMs: Number(document.querySelector("#long-press").value),
      translationEnabled: document.querySelector("#translation-enabled").checked,
      launchAtLogin: document.querySelector("#launch-at-login").checked,
      processBlacklist,
      translation: {
        provider: document.querySelector("#translation-provider").value,
        endpoint: document.querySelector("#translation-endpoint").value,
        apiKey: document.querySelector("#translation-key").value,
      },
    });
    await openSettings();
    document.querySelector("#settings-status").textContent =
      `已保存。启动快捷键：${saved.registeredHotkey || "注册失败"} · 截图快捷键：${saved.registeredScreenshotHotkey || "注册失败"}`;
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});

document.querySelector("#add-plugin").addEventListener("click", async () => {
  try {
    const added = await api.addPluginDirectory();
    await loadPlugins();
    if (added) {
      document.querySelector("#settings-status").textContent = "已添加插件目录";
    }
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
document.querySelector("#install-plugin").addEventListener("click", async () => {
  try {
    const installed = await api.installPluginPackage();
    await loadPlugins();
    if (installed) {
      document.querySelector("#settings-status").textContent =
        `已安装：${installed.pluginName} ${installed.version}`;
    }
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
document.querySelector("#refresh-plugins").addEventListener("click", async () => {
  try {
    const report = await api.refresh();
    await loadPlugins();
    document.querySelector("#settings-status").textContent = `插件已刷新：${report.plugins} 个插件`;
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
document.querySelector("#plugin-search").addEventListener("input", renderPluginGrid);
for (const button of document.querySelectorAll(".nav-item[data-page]")) {
  button.addEventListener("click", () => showHubPage(button.dataset.page));
}
document.querySelector("#add-item").addEventListener("click", async () => {
  try {
    const result = await api.addCustomItem();
    await loadCustomItems();
    reportCustomItemResult(result, "应用");
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
document.querySelector("#add-directory").addEventListener("click", async () => {
  try {
    const result = await api.addCustomDirectory();
    await loadCustomItems();
    reportCustomItemResult(result, "目录");
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
document.querySelector("#refresh-index").addEventListener("click", async () => {
  const report = await api.refresh();
  await loadCustomItems();
  document.querySelector("#settings-status").textContent = `索引已刷新：${report.applications} 个应用，${report.plugins} 个插件`;
});
document.querySelector("#clear-usage").addEventListener("click", async () => {
  try {
    await api.clearUsage();
    document.querySelector("#settings-status").textContent = "使用统计已清空";
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
document.querySelector("#reset-position").addEventListener("click", async () => {
  try {
    const result = await api.resetPosition();
    if (result && result.ok) {
      document.querySelector("#settings-status").textContent = "窗口位置已还原";
      showToast("窗口位置已还原");
    }
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});

/* ---------- 检查更新 ---------- */
// 当前可下载的更新信息（来自 updater:check），下载完成后标记 ready。
let pendingUpdate = null;
let updateDownloaded = false;
let updateBusy = false;

function setUpdateStatus(message, isError) {
  const node = document.querySelector("#update-status");
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("is-error", Boolean(isError));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function setUpdateProgress(received, total) {
  const wrap = document.querySelector("#update-progress");
  const bar = document.querySelector("#update-progress-bar");
  const label = document.querySelector("#update-progress-label");
  if (!wrap || !bar || !label) return;
  wrap.hidden = false;
  if (total > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((received / total) * 100)));
    bar.style.width = `${percent}%`;
    label.textContent = `${percent}%`;
  } else {
    // 没有 Content-Length 时只显示已下载大小。
    bar.style.width = "100%";
    label.textContent = formatBytes(received) || "下载中";
  }
}

function resetUpdateProgress() {
  const wrap = document.querySelector("#update-progress");
  const bar = document.querySelector("#update-progress-bar");
  const label = document.querySelector("#update-progress-label");
  if (wrap) wrap.hidden = true;
  if (bar) bar.style.width = "0%";
  if (label) label.textContent = "0%";
}

// 使用 textContent 渲染更新说明，避免 release body 中的 HTML 注入。
function renderUpdateAvailable(info) {
  pendingUpdate = info;
  updateDownloaded = false;
  const result = document.querySelector("#update-result");
  const latest = document.querySelector("#update-latest");
  const published = document.querySelector("#update-published");
  const notes = document.querySelector("#update-notes");
  const warning = document.querySelector("#update-digest-warning");
  const downloadButton = document.querySelector("#update-download");

  if (result) result.hidden = false;
  if (latest) {
    const sizeText = formatBytes(info.size);
    latest.textContent = `新版本 v${info.latest}${sizeText ? ` · ${sizeText}` : ""}`;
  }
  if (published) {
    published.textContent = info.publishedAt
      ? new Date(info.publishedAt).toLocaleDateString()
      : "";
  }
  if (notes) notes.textContent = info.notes ? info.notes.trim() : "（本次发布没有提供更新说明）";
  if (warning) warning.hidden = !info.digestMissing;
  if (downloadButton) {
    downloadButton.textContent = "下载并安装";
    downloadButton.disabled = false;
  }
  resetUpdateProgress();
}

async function checkForUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  const button = document.querySelector("#check-update");
  if (button) button.disabled = true;
  setUpdateStatus("正在检查更新…", false);
  try {
    const info = await api.checkUpdate();
    if (!info || info.status === "error") {
      document.querySelector("#update-result").hidden = true;
      setUpdateStatus(info && info.message ? info.message : "检查更新失败", true);
    } else if (info.status === "latest") {
      document.querySelector("#update-result").hidden = true;
      setUpdateStatus(`已是最新版本（v${info.current}）`, false);
    } else if (info.status === "available") {
      renderUpdateAvailable(info);
      setUpdateStatus(
        info.digestMissing
          ? "发现新版本。该版本无校验摘要，下载后将跳过完整性校验。"
          : "发现新版本，可下载并安装。",
        false,
      );
    }
  } catch (error) {
    document.querySelector("#update-result").hidden = true;
    setUpdateStatus(error.message || String(error), true);
  } finally {
    updateBusy = false;
    if (button) button.disabled = false;
  }
}

async function downloadAndInstall() {
  if (updateBusy) return;
  const button = document.querySelector("#update-download");

  // 下载完成后，按钮变为“立即安装并重启”。
  if (updateDownloaded) {
    updateBusy = true;
    if (button) button.disabled = true;
    setUpdateStatus("正在启动安装程序，应用即将重启…", false);
    try {
      const result = await api.installUpdate();
      if (!result || !result.ok) {
        setUpdateStatus(result && result.message ? result.message : "安装失败", true);
        if (button) button.disabled = false;
        updateBusy = false;
      }
      // 成功时主进程会退出应用，无需进一步处理。
    } catch (error) {
      setUpdateStatus(error.message || String(error), true);
      if (button) button.disabled = false;
      updateBusy = false;
    }
    return;
  }

  if (!pendingUpdate || !pendingUpdate.downloadUrl) {
    setUpdateStatus("没有可下载的更新", true);
    return;
  }

  updateBusy = true;
  if (button) {
    button.disabled = true;
    button.textContent = "下载中…";
  }
  setUpdateStatus("正在下载更新…", false);
  resetUpdateProgress();
  setUpdateProgress(0, pendingUpdate.size || 0);

  try {
    const result = await api.downloadUpdate({
      url: pendingUpdate.downloadUrl,
      assetName: pendingUpdate.assetName,
      sha256: pendingUpdate.sha256 || null,
      version: pendingUpdate.latest,
    });
    if (!result || !result.ok) {
      setUpdateStatus(result && result.message ? result.message : "下载失败", true);
      if (button) {
        button.disabled = false;
        button.textContent = "重试下载";
      }
      updateBusy = false;
      return;
    }
    updateDownloaded = true;
    setUpdateStatus(
      result.verified
        ? "下载完成并校验通过，可立即安装。"
        : "下载完成（未校验摘要）。安装前请确认来源可信。",
      false,
    );
    if (button) {
      button.disabled = false;
      button.textContent = "立即安装并重启";
    }
  } catch (error) {
    setUpdateStatus(error.message || String(error), true);
    if (button) {
      button.disabled = false;
      button.textContent = "重试下载";
    }
  } finally {
    updateBusy = false;
  }
}

if (api && typeof api.onUpdateProgress === "function") {
  api.onUpdateProgress((progress) => {
    if (progress) setUpdateProgress(progress.received || 0, progress.total || 0);
  });
}

const checkUpdateButton = document.querySelector("#check-update");
if (checkUpdateButton) checkUpdateButton.addEventListener("click", checkForUpdate);
const updateDownloadButton = document.querySelector("#update-download");
if (updateDownloadButton) updateDownloadButton.addEventListener("click", downloadAndInstall);
const openReleaseButton = document.querySelector("#update-open-release");
if (openReleaseButton) {
  openReleaseButton.addEventListener("click", () => {
    if (api && typeof api.openReleasePage === "function") api.openReleasePage();
  });
}

/* ---------- events ---------- */
api.onFocus((point) => {
  if (!settingsPanel.hidden) return;
  closeContextMenu();
  // The main process passes the current cursor point in screen coordinates.
  // Seeding the baseline here means the first real mouse movement can select a
  // row, while synthetic moves caused by showing/moving the window cannot.
  pointerX = point && Number.isFinite(point.x) ? point.x : -1;
  pointerY = point && Number.isFinite(point.y) ? point.y : -1;
  hoverOriginX = pointerX;
  hoverOriginY = pointerY;
  hoverArmed = false;
  query.focus();
  query.select();
  // Startup race recovery: if the first search/resize were lost (IPC handlers
  // not yet registered when the window loaded), run the search once here.
  if (!hasSearched) {
    lastResizeHeight = 0;
    runSearch();
    return;
  }
  // Blur hides the compact launcher and pauses indexing polls. If it is opened
  // again while the status row is still visible, resume the pending query so a
  // completed Everything index replaces the status automatically.
  if (
    matches.some((match) => match.action === "file-indexing") &&
    isFileModeInput({ type: "text", data: query.value })
  ) {
    runSearch({ type: "text", data: query.value }, true);
    return;
  }
  // Do not re-run the search on every focus; the existing view stays.
});
api.onOpenSettings((page) => openSettings(page));
api.onIndexUpdated(() => {
  if (!launcher.hidden) runSearch();
});

/* ---------- theme ---------- */
const themeChoices = document.querySelector("#theme-choices");
if (themeChoices) {
  themeChoices.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-theme-choice]");
    if (!button || !themeChoices.contains(button)) return;
    const theme = normalizeTheme(button.dataset.themeChoice);
    // Apply immediately for instant preview, then persist.
    applyTheme(theme);
    try {
      await api.updateSettings({ theme });
    } catch (error) {
      showToast(error.message || String(error));
    }
  });
}

/* ---------- panel transparency ---------- */
const transparencySlider = document.querySelector("#panel-transparency");
if (transparencySlider) {
  transparencySlider.addEventListener("input", () => {
    applyPanelTransparency(transparencySlider.value);
  });
  transparencySlider.addEventListener("change", async () => {
    const panelTransparency = normalizePanelTransparency(transparencySlider.value);
    applyPanelTransparency(panelTransparency);
    try {
      await api.updateSettings({ panelTransparency });
    } catch (error) {
      showToast(error.message || String(error));
    }
  });
}

/* ---------- window drag setting ---------- */
const dragChoices = document.querySelector("#window-drag-choices");
if (dragChoices) {
  dragChoices.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-drag-choice]");
    if (!button || !dragChoices.contains(button)) return;
    const enabled = button.dataset.dragChoice === "enabled";
    applyWindowDragSetting(enabled);
    try {
      await api.updateSettings({ windowDragEnabled: enabled });
    } catch (error) {
      showToast(error.message || String(error));
    }
  });
}

/* ---------- startup ---------- */
query.focus();
runSearch();

// Fetch the authoritative theme/drag preference; keep cached/default values on failure.
if (api && typeof api.getSettings === "function") {
  api
    .getSettings()
    .then((settings) => {
      if (settings && settings.theme) applyTheme(settings.theme);
      if (settings) {
        applyWindowDragSetting(settings.windowDragEnabled);
        applyPanelTransparency(settings.panelTransparency);
      }
    })
    .catch(() => {
      // Keep the cached theme; do not surface an error.
    });
}
