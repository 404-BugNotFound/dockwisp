"use strict";

/**
 * Renderer for the "翻译" editor window. The left pane is an editable source,
 * the right pane a read-only target. Typing (when auto-translate is on) or
 * Ctrl+Enter / the button asks the main process to translate over ipc; stale
 * responses are dropped by sequence number.
 */

const api = window.translate;
const el = (id) => document.getElementById(id);

const ui = {
  sourceLang: el("sourceLang"),
  targetLang: el("targetLang"),
  swapLang: el("swapLang"),
  optAuto: el("optAuto"),
  btnTranslate: el("btnTranslate"),
  closeWindow: el("closeWindow"),
  sourceText: el("sourceText"),
  targetText: el("targetText"),
  sourceMeta: el("sourceMeta"),
  targetMeta: el("targetMeta"),
  overlay: el("overlay"),
  overlayText: el("overlayText"),
  counts: el("counts"),
  providerName: el("providerName"),
  errorMsg: el("errorMsg"),
  btnCopy: el("btnCopy"),
  btnClear: el("btnClear"),
  toast: el("toast"),
};

const STORAGE = {
  auto: "dockwisp.translate.auto",
  source: "dockwisp.translate.source",
  target: "dockwisp.translate.target",
};

// Source list has an "auto" option; target list does not (a concrete language
// is always required, "auto" there would be ambiguous for the user).
const LANGUAGES = [
  { code: "zh-CN", name: "简体中文" },
  { code: "en", name: "英语" },
  { code: "ja", name: "日语" },
  { code: "ko", name: "韩语" },
  { code: "fr", name: "法语" },
  { code: "de", name: "德语" },
  { code: "es", name: "西班牙语" },
  { code: "ru", name: "俄语" },
  { code: "it", name: "意大利语" },
  { code: "pt", name: "葡萄牙语" },
];

const state = {
  seq: 0,
  busy: false,
  lastTranslated: "",
  provider: "mymemory",
};

let toastTimer = null;
let debounceTimer = null;

/* ------------------------- storage ------------------------- */

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

/* ------------------------- helpers ------------------------- */

function showToast(message) {
  ui.toast.hidden = false;
  ui.toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 1600);
}

function applyTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function charCount(text) {
  // Count by code points so surrogate pairs (emoji, rare CJK) read as one.
  return Array.from(text).length;
}

function updateCounts() {
  const s = charCount(ui.sourceText.value);
  const t = charCount(ui.targetText.value);
  ui.sourceMeta.textContent = `${s} 字`;
  ui.targetMeta.textContent = `${t} 字`;
  ui.counts.textContent = `原文 ${s} 字 · 译文 ${t} 字`;
}

function setError(message) {
  if (message) {
    ui.errorMsg.textContent = message;
    ui.errorMsg.hidden = false;
  } else {
    ui.errorMsg.textContent = "";
    ui.errorMsg.hidden = true;
  }
}

function setBusy(busy) {
  state.busy = busy;
  ui.overlay.hidden = !busy;
  ui.btnTranslate.disabled = busy;
}

/* ------------------------- language selects ------------------------- */

function fillLanguageSelects() {
  const sourceOptions = [{ code: "auto", name: "自动检测" }, ...LANGUAGES];
  for (const { code, name } of sourceOptions) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    ui.sourceLang.append(opt);
  }
  for (const { code, name } of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    ui.targetLang.append(opt);
  }
  ui.sourceLang.value = readString(STORAGE.source, "auto");
  ui.targetLang.value = readString(STORAGE.target, "zh-CN");
  if (!ui.sourceLang.value) ui.sourceLang.value = "auto";
  if (!ui.targetLang.value) ui.targetLang.value = "zh-CN";
}

/* ------------------------- translation ------------------------- */

function scheduleTranslate() {
  updateCounts();
  if (!ui.optAuto.checked) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runTranslate(), 600);
}

async function runTranslate() {
  clearTimeout(debounceTimer);
  const text = ui.sourceText.value.trim();
  if (!text) {
    ui.targetText.value = "";
    updateCounts();
    setError("");
    return;
  }
  const seq = ++state.seq;
  setError("");
  setBusy(true);
  let response;
  try {
    response = await api.run({
      text: ui.sourceText.value,
      source: ui.sourceLang.value,
      target: ui.targetLang.value,
    });
  } catch (error) {
    if (seq !== state.seq) return;
    setBusy(false);
    setError(error && error.message ? error.message : "翻译失败");
    return;
  }
  if (seq !== state.seq) return; // a newer request superseded this one
  setBusy(false);
  if (response && response.ok) {
    ui.targetText.value = response.result.translatedText;
    state.lastTranslated = ui.sourceText.value;
    updateCounts();
  } else {
    setError((response && response.message) || "翻译失败");
  }
}

/* ------------------------- actions ------------------------- */

function swapLanguages() {
  const source = ui.sourceLang.value;
  const target = ui.targetLang.value;
  // "auto" has no target counterpart; fall back to Chinese as the new source.
  ui.sourceLang.value = target;
  ui.targetLang.value = source === "auto" ? "zh-CN" : source;
  writeString(STORAGE.source, ui.sourceLang.value);
  writeString(STORAGE.target, ui.targetLang.value);

  // Move the current translation back into the source box.
  if (ui.targetText.value.trim()) {
    ui.sourceText.value = ui.targetText.value;
    ui.targetText.value = "";
  }
  updateCounts();
  setError("");
  ui.sourceText.focus();
  void runTranslate();
}

function clearAll() {
  ui.sourceText.value = "";
  ui.targetText.value = "";
  state.seq++; // invalidate any in-flight request
  setBusy(false);
  setError("");
  updateCounts();
  ui.sourceText.focus();
}

async function copyResult() {
  const text = ui.targetText.value;
  if (!text.trim()) {
    showToast("没有可复制的译文");
    return;
  }
  try {
    await api.copy(text);
    showToast("已复制译文");
  } catch (error) {
    showToast(error && error.message ? error.message : "复制失败");
  }
}

/* ------------------------- wiring ------------------------- */

function wireEvents() {
  ui.sourceText.addEventListener("input", scheduleTranslate);

  ui.optAuto.addEventListener("change", () => {
    writeBool(STORAGE.auto, ui.optAuto.checked);
    if (ui.optAuto.checked) scheduleTranslate();
  });

  ui.sourceLang.addEventListener("change", () => {
    writeString(STORAGE.source, ui.sourceLang.value);
    if (ui.sourceText.value.trim()) void runTranslate();
  });
  ui.targetLang.addEventListener("change", () => {
    writeString(STORAGE.target, ui.targetLang.value);
    if (ui.sourceText.value.trim()) void runTranslate();
  });

  ui.swapLang.addEventListener("click", swapLanguages);
  ui.btnTranslate.addEventListener("click", () => void runTranslate());
  ui.btnCopy.addEventListener("click", () => void copyResult());
  ui.btnClear.addEventListener("click", clearAll);
  ui.closeWindow.addEventListener("click", () => api.close());

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void runTranslate();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      api.close();
    }
  });
}

/* ------------------------- init ------------------------- */

function handleState(incoming) {
  if (!incoming) return;
  applyTheme(incoming.theme);
  if (incoming.providerName) {
    state.provider = incoming.provider || "mymemory";
    ui.providerName.textContent = incoming.providerName;
  }
  if (typeof incoming.text === "string") {
    ui.sourceText.value = incoming.text;
    ui.targetText.value = "";
    setError("");
    updateCounts();
    focusSourceEnd();
    // Opening with seeded text translates immediately, regardless of the
    // auto-translate toggle (the user explicitly asked to translate it).
    if (incoming.text.trim()) void runTranslate();
  }
}

function focusSourceEnd() {
  ui.sourceText.focus();
  const end = ui.sourceText.value.length;
  try {
    ui.sourceText.setSelectionRange(end, end);
  } catch {
    /* ignore */
  }
}

function init() {
  fillLanguageSelects();
  ui.optAuto.checked = readBool(STORAGE.auto, true);
  wireEvents();
  updateCounts();
  focusSourceEnd();

  if (api && typeof api.onState === "function") api.onState(handleState);
  if (api && typeof api.onTheme === "function") api.onTheme(applyTheme);
}

init();
