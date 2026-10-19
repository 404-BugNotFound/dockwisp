const THEME_VALUES = ["system", "light", "dark"];
const THEME_CACHE_KEY = "dockwisp.theme";

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

// Apply the cached theme before any DOM query to minimize first-paint flicker.
applyTheme(readCachedTheme());

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
const SETTINGS_HEIGHT = 600;

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
  api.resize(height);
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
async function openSettings() {
  closeContextMenu();
  clearFilePoll();
  launcher.hidden = true;
  settingsPanel.hidden = false;
  lastResizeHeight = 0;
  api.resize(SETTINGS_HEIGHT);
  const settings = await api.getSettings();
  applyTheme(settings.theme);
  document.querySelector("#hotkey").value = settings.hotkey;
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
}

function closeSettings() {
  settingsPanel.hidden = true;
  launcher.hidden = false;
  lastResizeHeight = 0;
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
    document.querySelector("#settings-status").textContent = `已保存。当前快捷键：${saved.registeredHotkey || "注册失败"}`;
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});

document.querySelector("#add-plugin").addEventListener("click", async () => {
  await api.addPluginDirectory();
  await openSettings();
});
document.querySelector("#install-plugin").addEventListener("click", async () => {
  try {
    const installed = await api.installPluginPackage();
    if (installed) {
      document.querySelector("#settings-status").textContent =
        `已安装：${installed.pluginName} ${installed.version}`;
    }
  } catch (error) {
    document.querySelector("#settings-status").textContent = error.message || String(error);
  }
});
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
api.onOpenSettings(openSettings);
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

/* ---------- startup ---------- */
query.focus();
runSearch();

// Fetch the authoritative theme; keep the cached value on failure.
if (api && typeof api.getSettings === "function") {
  api
    .getSettings()
    .then((settings) => {
      if (settings && settings.theme) applyTheme(settings.theme);
    })
    .catch(() => {
      // Keep the cached theme; do not surface an error.
    });
}
