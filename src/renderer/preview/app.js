"use strict";

const api = window.preview;

const stage = document.getElementById("stage");
const loading = document.getElementById("loading");
const content = document.getElementById("content");
const fileIcon = document.getElementById("fileIcon");
const fileIconFallback = document.getElementById("fileIconFallback");
const fileName = document.getElementById("fileName");
const filePath = document.getElementById("filePath");
const meta = document.getElementById("meta");
const toast = document.getElementById("toast");

let current = null;
let toastTimer = null;

const KIND_LABEL = {
  image: "图片",
  text: "文本",
  audio: "音频",
  video: "视频",
  pdf: "PDF",
  unsupported: "文件",
};

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function showToast(message) {
  toast.hidden = false;
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 1600);
}

function clearContent() {
  content.replaceChildren();
  content.hidden = true;
}

function renderEmpty(state, message) {
  clearContent();
  const wrap = document.createElement("div");
  wrap.className = "empty";

  const icon = document.createElement("img");
  icon.className = "big-icon";
  if (state.iconUrl) icon.src = state.iconUrl;
  else icon.hidden = true;
  wrap.append(icon);

  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = state.name || "无法预览";
  wrap.append(title);

  const text = document.createElement("div");
  text.className = "empty-message";
  text.textContent = message || "暂不支持预览此文件类型。";
  wrap.append(text);

  const actions = document.createElement("div");
  actions.className = "empty-actions";
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "soft-button primary";
  openButton.textContent = "用默认应用打开";
  openButton.addEventListener("click", () => void openExternal());
  actions.append(openButton);
  const revealButton = document.createElement("button");
  revealButton.type = "button";
  revealButton.className = "soft-button";
  revealButton.textContent = "打开所在目录";
  revealButton.addEventListener("click", () => void reveal());
  actions.append(revealButton);
  wrap.append(actions);

  content.append(wrap);
  content.hidden = false;
}

function renderText(state) {
  clearContent();
  const wrap = document.createElement("div");
  wrap.className = "text-wrap";
  const pre = document.createElement("pre");
  pre.className = "text-content";
  pre.textContent = state.text || "";
  if (state.truncated) {
    const note = document.createElement("span");
    note.className = "truncated-note";
    note.textContent = "文件较大，仅显示前 2 MB 内容。";
    pre.append(note);
  }
  wrap.append(pre);
  content.append(wrap);
  content.hidden = false;
}

function renderImage(state) {
  clearContent();
  const wrap = document.createElement("div");
  wrap.className = "image-wrap";
  const image = document.createElement("img");
  image.alt = state.name || "";
  image.src = state.dataUrl || "";
  image.addEventListener("error", () => {
    renderEmpty(state, "图片解码失败，可能已损坏或格式不受支持。");
  });
  wrap.append(image);
  content.append(wrap);
  content.hidden = false;
}

function renderMedia(state) {
  clearContent();
  const wrap = document.createElement("div");
  wrap.className = "media-wrap";
  const holder = document.createElement("div");
  holder.style.width = "100%";
  holder.style.display = "grid";
  holder.style.justifyItems = "center";

  let media;
  if (state.kind === "audio") {
    media = document.createElement("audio");
    media.controls = true;
    media.src = state.dataUrl || "";
  } else {
    media = document.createElement("video");
    media.controls = true;
    media.src = state.dataUrl || "";
  }
  media.addEventListener("error", () => {
    renderEmpty(state, "当前媒体编码不受支持，可使用系统默认应用播放。");
  });
  holder.append(media);

  const label = document.createElement("div");
  label.className = "media-label";
  label.textContent = state.name || "";
  holder.append(label);
  wrap.append(holder);
  content.append(wrap);
  content.hidden = false;
}

function renderPdf(state) {
  clearContent();
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.title = state.name || "PDF 预览";
  frame.src = state.dataUrl || "";
  content.append(frame);
  content.hidden = false;
}

function renderState(state) {
  current = state;
  document.documentElement.dataset.theme = state.theme === "dark" ? "dark" : "light";
  document.documentElement.style.colorScheme = state.theme === "dark" ? "dark" : "light";

  fileName.textContent = state.name || "预览";
  filePath.textContent = state.path || "";
  filePath.title = state.path || "";

  if (state.iconUrl) {
    fileIcon.src = state.iconUrl;
    fileIcon.hidden = false;
    fileIconFallback.hidden = true;
  } else {
    fileIcon.hidden = true;
    fileIconFallback.hidden = false;
  }

  const parts = [
    KIND_LABEL[state.kind] || "文件",
    formatBytes(state.size),
    formatDate(state.modified),
  ].filter(Boolean);
  meta.textContent = parts.join(" · ");

  loading.hidden = true;
  switch (state.kind) {
    case "image":
      renderImage(state);
      break;
    case "text":
      renderText(state);
      break;
    case "audio":
    case "video":
      renderMedia(state);
      break;
    case "pdf":
      renderPdf(state);
      break;
    default:
      renderEmpty(state, state.message);
      break;
  }
}

async function openExternal() {
  try {
    const result = await api.openExternal();
    if (result && result.ok === false) showToast(result.message || "无法打开文件");
  } catch (error) {
    showToast(error.message || String(error));
  }
}

async function reveal() {
  try {
    await api.reveal();
  } catch (error) {
    showToast(error.message || String(error));
  }
}

async function copyPath() {
  try {
    await api.copyPath();
    showToast("已复制路径");
  } catch (error) {
    showToast(error.message || String(error));
  }
}

document.getElementById("openFile").addEventListener("click", () => void openExternal());
document.getElementById("revealFile").addEventListener("click", () => void reveal());
document.getElementById("copyPath").addEventListener("click", () => void copyPath());
document.getElementById("closeWindow").addEventListener("click", () => api.close());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    api.close();
  }
});

api.onState(renderState);
