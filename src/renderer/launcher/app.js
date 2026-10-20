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
let pointerX = -1;
let pointerY = -1;
let hoverOriginX = -1;
let hoverOriginY = -1;
let hoverArmed = false;
let windowDragEnabled = true;
let windowDrag = null;
let suppressNextClick = false;

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

function renderResults() {
  // A fresh result set must start with the first (most relevant) row selected.
  // Layout changes under a stationary pointer can emit a mousemove with the
  // same coordinates; only arm hover selection after the pointer really moves.
  hoverOriginX = pointerX;
  hoverOriginY = pointerY;
  hoverArmed = false;
  results.replaceChildren();
  matches.forEach((match, index) => {
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
      return;
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
  });
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

async function runSearch(input, quiet = false) {
  const resolved = input || { type: "text", data: query.value };
  const token = ++searchToken;
  const fileMode = isFileModeInput(resolved);
  // Any new search invalidates a pending indexing re-poll.
  clearFilePoll();

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
    const list = next || [];
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
        }, 1500);
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

    matches = list;
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
  executeMatch(match);
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
  selected = (selected + offset + matches.length) % matches.length;
  syncSelection();
  results.children[selected]?.scrollIntoView({ block: "nearest" });
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
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2500);
}

/* ---------- input & keyboard ---------- */
query.addEventListener("input", () => {
  closeContextMenu();
  runSearch();
});

query.addEventListener("keydown", (event) => {
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
    } else {
      clearFilePoll();
      api.hide();
    }
  }
});

/* ---------- drag & drop ---------- */
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  searchBar.classList.add("drag-active");
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) {
    searchBar.classList.remove("drag-active");
  }
});
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  searchBar.classList.remove("drag-active");
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  const paths = api.pathsForFiles(files);
  if (!paths.length) return;
  try {
    const result = await api.addPaths(paths);
    const added = (result && result.added) || [];
    if (added.length > 0) {
      const names = added.map((entry) => entry.name).join("、");
      showToast(`已添加：${names}`);
      query.value = added[0].name;
      runSearch();
      query.focus();
    } else {
      // Nothing added — fall back to plugin file commands.
      runSearch({ type: "files", data: paths });
    }
  } catch (error) {
    showToast(error.message || String(error));
  }
});

/* ---------- settings ---------- */
const HUB_PAGES = new Set(["settings", "plugins"]);
let hubPage = "settings";
let pluginList = [];

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
  card.title = plugin.builtin ? "打开截图工具" : `搜索 ${plugin.name} 的功能`;

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
      if (api && typeof api.startScreenshot === "function") api.startScreenshot();
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

async function openSettings(page = "settings") {
  closeContextMenu();
  clearFilePoll();
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
document.querySelector("#add-item").addEventListener("click", () => api.addCustomItem());
document.querySelector("#refresh-index").addEventListener("click", async () => {
  const report = await api.refresh();
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
