"use strict";

/* ------------------------------------------------------------------ *
 * Dockwisp 局域网互传窗口
 * 渲染器负责：展示二维码与访问地址、网络适配器切换、连接状态、发送/接收
 * 文件列表、拖放发送，以及进行中的传输进度。实际的 HTTP 服务、文件读写
 * 都在主进程完成（lan-transfer-server / controller）。
 * ------------------------------------------------------------------ */

const api = window.lanTransfer;

const el = (id) => document.getElementById(id);

const closeBtn = el("closeWindow");
const connLive = el("connLive");
const connDown = el("connDown");
const qrImage = el("qrImage");
const qrEmpty = el("qrEmpty");
const urlField = el("urlField");
const copyUrlBtn = el("copyUrl");
const adapterField = el("adapterField");
const adapterSelect = el("adapterSelect");
const connStatus = el("connStatus");
const connStatusText = el("connStatusText");
const connMessage = el("connMessage");
const restartBtn = el("restartBtn");

const addFilesBtn = el("addFiles");
const clearSendBtn = el("clearSend");
const sendList = el("sendList");
const sendEmpty = el("sendEmpty");

const receiveDirChip = el("receiveDir");
const changeDirBtn = el("changeDir");
const openDirBtn = el("openDir");
const recvList = el("recvList");
const recvEmpty = el("recvEmpty");

const progressDock = el("progressDock");
const progressList = el("progressList");
const dropVeil = el("dropVeil");
const toast = el("toast");

let toastTimer = null;
let dragDepth = 0;
// id -> { li, bar, pct, name, timer }
const progressRows = new Map();

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

function formatTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

function applyTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

// --- Connection panel -----------------------------------------------------

function renderConnection(state) {
  const running = !!state.running;
  connLive.hidden = !running;
  connDown.hidden = running;

  if (!running) {
    connMessage.textContent = state.message || "传输服务未运行";
    return;
  }

  // QR
  if (state.qr) {
    qrImage.src = state.qr;
    qrImage.hidden = false;
    qrEmpty.hidden = true;
  } else {
    qrImage.hidden = true;
    qrEmpty.hidden = false;
  }

  // URL
  if (urlField.value !== (state.url || "")) urlField.value = state.url || "";

  // Adapter select (only when more than one)
  const addresses = Array.isArray(state.addresses) ? state.addresses : [];
  if (addresses.length > 1) {
    adapterField.hidden = false;
    const current = adapterSelect.value;
    const next = addresses.map((a) => `${a.address}|${a.name || ""}`).join("~");
    if (adapterSelect.dataset.sig !== next) {
      adapterSelect.dataset.sig = next;
      adapterSelect.replaceChildren();
      for (const item of addresses) {
        const option = document.createElement("option");
        option.value = item.address;
        option.textContent = item.name ? `${item.name} · ${item.address}` : item.address;
        adapterSelect.append(option);
      }
    }
    adapterSelect.value = state.address || current || addresses[0].address;
  } else {
    adapterField.hidden = true;
    adapterSelect.dataset.sig = "";
  }

  // Status
  const count = Array.isArray(state.clients) ? state.clients.length : 0;
  if (count > 0) {
    connStatus.classList.add("connected");
    connStatusText.textContent = `已连接 ${count} 台设备`;
  } else {
    connStatus.classList.remove("connected");
    connStatusText.textContent = "等待手机扫码";
  }
}

// --- Send list ------------------------------------------------------------

function renderSendFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const has = list.length > 0;
  sendList.hidden = !has;
  sendEmpty.hidden = has;
  clearSendBtn.hidden = !has;

  sendList.replaceChildren();
  for (const file of list) {
    const li = document.createElement("li");
    li.className = "row";

    const thumb = document.createElement("div");
    thumb.className = "row-thumb";
    thumb.innerHTML = FILE_ICON;

    const main = document.createElement("div");
    main.className = "row-main";
    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = file.name;
    name.title = file.path || file.name;
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = formatBytes(file.size);
    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const remove = document.createElement("button");
    remove.className = "mini-button danger";
    remove.type = "button";
    remove.title = "移除";
    remove.setAttribute("aria-label", "移除");
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>';
    remove.addEventListener("click", () => api.removeFile(file.id));
    actions.append(remove);

    li.append(thumb, main, actions);
    sendList.append(li);
  }
}

// --- Received list --------------------------------------------------------

function renderReceived(files) {
  const list = Array.isArray(files) ? files : [];
  const has = list.length > 0;
  recvList.hidden = !has;
  recvEmpty.hidden = has;

  recvList.replaceChildren();
  for (const file of list) {
    const li = document.createElement("li");
    li.className = "row clickable";

    const thumb = document.createElement("div");
    thumb.className = "row-thumb";
    thumb.innerHTML = FILE_ICON;

    const main = document.createElement("div");
    main.className = "row-main";
    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = file.name;
    name.title = "点击打开";
    name.addEventListener("click", () => api.openFile(file.path));
    const meta = document.createElement("div");
    meta.className = "row-meta";
    const bits = [formatBytes(file.size)];
    if (file.from) bits.push(`来自 ${file.from}`);
    if (file.at) bits.push(formatTime(file.at));
    meta.textContent = bits.filter(Boolean).join(" · ");
    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const reveal = document.createElement("button");
    reveal.className = "mini-button";
    reveal.type = "button";
    reveal.title = "在文件夹中显示";
    reveal.setAttribute("aria-label", "在文件夹中显示");
    reveal.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    reveal.addEventListener("click", () => api.revealFile(file.path));
    actions.append(reveal);

    li.append(thumb, main, actions);
    recvList.append(li);
  }
}

// --- Progress -------------------------------------------------------------

const DIR_ICON = {
  send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M12 5l-6 6M12 5l6 6"/></svg>',
  receive: '<svg viewBox="0 0 24 24"><path d="M12 5v14M12 19l-6-6M12 19l6-6"/></svg>',
};

function ensureProgressRow(p) {
  let row = progressRows.get(p.id);
  if (row) return row;

  const li = document.createElement("li");
  li.className = "prog";

  const top = document.createElement("div");
  top.className = "prog-top";
  const dir = document.createElement("span");
  dir.className = "prog-dir";
  dir.innerHTML = DIR_ICON[p.direction] || DIR_ICON.send;
  const name = document.createElement("span");
  name.className = "prog-name";
  name.textContent = p.name || "";
  name.title = p.name || "";
  const pct = document.createElement("span");
  pct.className = "prog-pct";
  pct.textContent = p.direction === "receive" ? "接收中…" : "发送中…";
  top.append(dir, name, pct);

  const track = document.createElement("div");
  track.className = "prog-track";
  const bar = document.createElement("div");
  bar.className = "prog-bar";
  track.append(bar);

  li.append(top, track);
  progressList.append(li);
  progressDock.hidden = false;

  row = { li, bar, pct, name, timer: null };
  progressRows.set(p.id, row);
  return row;
}

function onProgress(p) {
  if (!p || !p.id) return;
  const row = ensureProgressRow(p);
  if (row.timer) {
    clearTimeout(row.timer);
    row.timer = null;
  }
  if (p.name && row.name.textContent !== p.name) {
    row.name.textContent = p.name;
    row.name.title = p.name;
  }

  if (!p.done) {
    row.li.classList.remove("ok", "err");
    if (p.total > 0) {
      const ratio = Math.max(0, Math.min(1, p.transferred / p.total));
      row.bar.classList.remove("indeterminate");
      row.bar.style.width = `${Math.round(ratio * 100)}%`;
      row.pct.textContent = `${formatBytes(p.transferred)} / ${formatBytes(p.total)}`;
    } else {
      row.bar.classList.add("indeterminate");
      row.pct.textContent = formatBytes(p.transferred);
    }
    return;
  }

  // Done
  row.bar.classList.remove("indeterminate");
  const ok = p.ok !== false;
  row.li.classList.toggle("ok", ok);
  row.li.classList.toggle("err", !ok);
  row.bar.style.width = "100%";
  if (ok) {
    row.pct.textContent = p.direction === "receive" ? "已接收" : "已发送";
  } else {
    row.pct.textContent = p.message || "失败";
  }
  // Remove finished rows after a short while.
  row.timer = setTimeout(() => {
    removeProgressRow(p.id);
  }, ok ? 2600 : 6000);
}

function removeProgressRow(id) {
  const row = progressRows.get(id);
  if (!row) return;
  if (row.timer) clearTimeout(row.timer);
  row.li.remove();
  progressRows.delete(id);
  if (progressRows.size === 0) progressDock.hidden = true;
}

// --- Receive dir ----------------------------------------------------------

function setReceiveDir(dir) {
  receiveDirChip.textContent = dir || "默认接收目录";
  receiveDirChip.title = dir || "";
}

// --- Drag & drop ----------------------------------------------------------

function onDrop(event) {
  event.preventDefault();
  dragDepth = 0;
  dropVeil.hidden = true;
  const dropped = Array.from(event.dataTransfer?.files || []);
  if (dropped.length) api.addDropped(dropped);
}

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files")) {
    dragDepth += 1;
    dropVeil.hidden = false;
  }
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropVeil.hidden = true;
});
window.addEventListener("drop", onDrop);

// --- Wire up --------------------------------------------------------------

closeBtn.addEventListener("click", () => api.close());
addFilesBtn.addEventListener("click", () => api.addFiles());
sendEmpty.addEventListener("click", () => api.addFiles());
sendEmpty.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    api.addFiles();
  }
});
clearSendBtn.addEventListener("click", () => api.clearFiles());
restartBtn.addEventListener("click", () => api.restart());
changeDirBtn.addEventListener("click", () => api.chooseReceiveDir());
openDirBtn.addEventListener("click", () => api.openReceiveDir());

adapterSelect.addEventListener("change", () => api.selectAddress(adapterSelect.value));

copyUrlBtn.addEventListener("click", async () => {
  const url = urlField.value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showToast("已复制地址");
  } catch {
    // Fallback: select the field so the user can copy manually.
    urlField.focus();
    urlField.select();
    showToast("请手动复制地址");
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    api.close();
  }
});

api.onState((state) => {
  if (!state) return;
  applyTheme(state.theme);
  renderConnection(state);
  if (typeof state.receiveDir === "string") setReceiveDir(state.receiveDir);
});
api.onFiles((files) => renderSendFiles(files));
api.onReceived((files) => renderReceived(files));
api.onProgress((p) => onProgress(p));

// Prime from the current state so a reopened window isn't blank.
void (async () => {
  try {
    const state = await api.getState();
    if (state) {
      applyTheme(state.theme);
      renderConnection(state);
      if (typeof state.receiveDir === "string") setReceiveDir(state.receiveDir);
    }
  } catch {
    // Ignore: onState will deliver it.
  }
})();
