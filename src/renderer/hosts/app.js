"use strict";

const api = window.hosts;

const SYSTEM_ID = "__system__";

const els = {
  profileList: document.getElementById("profileList"),
  addProfile: document.getElementById("addProfile"),
  importRemote: document.getElementById("importRemote"),
  exclusiveToggle: document.getElementById("exclusiveToggle"),
  editorTitle: document.getElementById("editorTitle"),
  editorSubtitle: document.getElementById("editorSubtitle"),
  refreshRemote: document.getElementById("refreshRemote"),
  renameProfile: document.getElementById("renameProfile"),
  deleteProfile: document.getElementById("deleteProfile"),
  codeScroll: document.getElementById("codeScroll"),
  gutter: document.getElementById("gutter"),
  highlight: document.getElementById("highlight"),
  editor: document.getElementById("editor"),
  readonlyBadge: document.getElementById("readonlyBadge"),
  validation: document.getElementById("validation"),
  savedHint: document.getElementById("savedHint"),
  applyButton: document.getElementById("applyButton"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modalTitle"),
  modalNameLabel: document.getElementById("modalNameLabel"),
  modalName: document.getElementById("modalName"),
  modalUrlField: document.getElementById("modalUrlField"),
  modalUrl: document.getElementById("modalUrl"),
  modalError: document.getElementById("modalError"),
  modalCancel: document.getElementById("modalCancel"),
  modalConfirm: document.getElementById("modalConfirm"),
  toast: document.getElementById("toast"),
};

let state = { theme: "light", exclusive: false, profiles: [], systemContent: "", systemPath: "" };
let selectedId = SYSTEM_ID;
let saveTimer = null;
let toastTimer = null;
let modalHandler = null;

// ---------- helpers ----------

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function showToast(message, isError) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  els.toast.classList.toggle("error", Boolean(isError));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, isError ? 3200 : 1800);
}

function formatTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

function selectedProfile() {
  if (selectedId === SYSTEM_ID) return null;
  return state.profiles.find((p) => p.id === selectedId) || null;
}

function enabledCount() {
  return state.profiles.filter((p) => p.enabled).length;
}

// ---------- syntax highlighting + validation (mirrors core/hosts rules) ----------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIPv4(value) {
  const m = IPV4_RE.exec(value);
  if (!m) return false;
  return m.slice(1).every((part) => {
    if (part.length > 1 && part[0] === "0") return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isValidIPv6(value) {
  const address = value.split("%")[0];
  if (!address.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(address)) return false;
  const doubles = address.match(/::/g);
  if (doubles && doubles.length > 1) return false;
  const hasCompression = address.includes("::");
  const [head, tail = ""] = hasCompression ? address.split("::") : [address, ""];
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const all = [...headGroups, ...tailGroups];
  for (let i = 0; i < all.length; i += 1) {
    const g = all[i];
    const isLast = i === all.length - 1;
    if (g.includes(".")) {
      if (!(isLast && isValidIPv4(g))) return false;
    } else if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      return false;
    }
  }
  const embeddedV4 = all.length > 0 && all[all.length - 1].includes(".");
  const groupCount = all.length + (embeddedV4 ? 1 : 0);
  return hasCompression ? groupCount <= 7 : groupCount === 8;
}

function isValidIp(value) {
  return isValidIPv4(value) || isValidIPv6(value);
}

function isValidHostname(value) {
  if (!value || value.length > 253) return false;
  if (value === "localhost") return true;
  return value.split(".").every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[A-Za-z0-9_-]+$/.test(label);
  });
}

/** Classify one line -> { kind, error? }. Keep in sync with core/hosts.ts. */
function classifyLine(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "blank" };
  if (trimmed.startsWith("#")) {
    const body = trimmed.replace(/^#+\s*/, "");
    if (parseMapping(body)) return { kind: "mapping", disabled: true };
    return { kind: "comment" };
  }
  if (parseMapping(trimmed)) return { kind: "mapping", disabled: false };
  const first = trimmed.split(/\s+/)[0];
  return { kind: "invalid", error: isValidIp(first) ? "缺少主机名" : "无法识别的 IP 地址" };
}

function parseMapping(text) {
  if (!text) return false;
  const hashIndex = text.indexOf("#");
  const mappingPart = (hashIndex >= 0 ? text.slice(0, hashIndex) : text).trim();
  if (!mappingPart) return false;
  const tokens = mappingPart.split(/\s+/);
  if (tokens.length < 2) return false;
  const [ip, ...hosts] = tokens;
  if (!isValidIp(ip)) return false;
  return hosts.every(isValidHostname);
}

/** Produce highlighted HTML for a single line based on its classification. */
function highlightLine(raw) {
  const info = classifyLine(raw);
  if (info.kind === "blank") return "\u200b";
  if (info.kind === "comment") {
    return `<span class="tok-comment">${escapeHtml(raw)}</span>`;
  }
  if (info.kind === "invalid") {
    return `<span class="line-invalid">${escapeHtml(raw)}</span>`;
  }
  // mapping (enabled or disabled)
  return highlightMapping(raw, info.disabled);
}

function highlightMapping(raw, disabled) {
  // Preserve leading whitespace and the comment/hash structure visually.
  const leadingWs = raw.match(/^\s*/)[0];
  let rest = raw.slice(leadingWs.length);
  let hashPrefix = "";
  if (disabled) {
    const m = rest.match(/^#+\s*/);
    if (m) {
      hashPrefix = m[0];
      rest = rest.slice(hashPrefix.length);
    }
  }
  const hashIndex = rest.indexOf("#");
  const mappingPart = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const comment = hashIndex >= 0 ? rest.slice(hashIndex) : "";

  // Tokenize mappingPart keeping the whitespace separators.
  const pieces = mappingPart.split(/(\s+)/);
  let seenIp = false;
  const html = pieces
    .map((piece) => {
      if (/^\s+$/.test(piece) || piece === "") return escapeHtml(piece);
      if (!seenIp) {
        seenIp = true;
        return `<span class="tok-ip">${escapeHtml(piece)}</span>`;
      }
      return `<span class="tok-host">${escapeHtml(piece)}</span>`;
    })
    .join("");

  const commentHtml = comment
    ? `<span class="tok-comment">${escapeHtml(comment)}</span>`
    : "";
  const inner = `${escapeHtml(leadingWs)}${escapeHtml(hashPrefix)}${html}${commentHtml}`;
  return disabled ? `<span class="tok-disabled">${inner}</span>` : inner;
}

function renderHighlight(text) {
  const lines = text.split("\n");
  els.highlight.innerHTML = lines.map(highlightLine).join("\n");
  els.gutter.textContent = lines.map((_, i) => i + 1).join("\n");
}

function renderValidation(text) {
  const lines = text.split("\n");
  const issues = [];
  lines.forEach((raw, index) => {
    const info = classifyLine(raw);
    if (info.kind === "invalid") {
      issues.push({ line: index + 1, message: info.error });
    }
  });
  if (issues.length === 0) {
    els.validation.classList.remove("has-error");
    els.validation.classList.add("clean");
    els.validation.textContent = text.trim() === "" ? "—" : "语法检查通过";
  } else {
    els.validation.classList.add("has-error");
    els.validation.classList.remove("clean");
    const preview = issues
      .slice(0, 3)
      .map((i) => `第 ${i.line} 行 (${i.message})`)
      .join("，");
    const more = issues.length > 3 ? ` 等 ${issues.length} 处` : "";
    els.validation.textContent = `发现无效行：${preview}${more}`;
  }
}

function syncScroll() {
  els.highlight.scrollTop = els.editor.scrollTop;
  els.highlight.scrollLeft = els.editor.scrollLeft;
}

function autoGrow() {
  els.editor.style.height = "auto";
  const next = Math.max(els.editor.scrollHeight, els.codeScroll.clientHeight);
  els.editor.style.height = `${next}px`;
}

// ---------- editor binding ----------

function loadIntoEditor() {
  const profile = selectedProfile();
  const isSystem = selectedId === SYSTEM_ID;
  const text = isSystem ? state.systemContent : profile ? profile.content : "";

  els.editor.value = text;
  els.editor.readOnly = isSystem;
  els.readonlyBadge.hidden = !isSystem;

  if (isSystem) {
    els.editorTitle.textContent = "系统 hosts";
    els.editorSubtitle.textContent = state.systemPath || "";
  } else if (profile) {
    els.editorTitle.textContent = profile.name;
    if (profile.type === "remote") {
      const when = profile.fetchedAt ? `更新于 ${formatTime(profile.fetchedAt)}` : "尚未刷新";
      els.editorSubtitle.textContent = `远程方案 · ${profile.url || ""} · ${when}`;
    } else {
      els.editorSubtitle.textContent = profile.enabled ? "已启用" : "未启用";
    }
  }

  els.refreshRemote.hidden = !(profile && profile.type === "remote");
  els.renameProfile.hidden = isSystem;
  els.deleteProfile.hidden = isSystem;

  renderHighlight(text);
  renderValidation(text);
  autoGrow();
  syncScroll();
}

function scheduleSave() {
  const profile = selectedProfile();
  if (!profile) return;
  const value = els.editor.value;
  clearTimeout(saveTimer);
  els.savedHint.textContent = "编辑中…";
  saveTimer = setTimeout(async () => {
    try {
      const result = await api.updateContent(profile.id, value);
      if (result && result.ok) {
        applyState(result.state);
        els.savedHint.textContent = "已保存";
      } else {
        els.savedHint.textContent = "";
        if (result && result.message) showToast(result.message, true);
      }
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  }, 350);
}

// ---------- sidebar rendering ----------

function makeSwitch(checked, onChange) {
  const label = document.createElement("label");
  label.className = "switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span");
  track.className = "switch-track";
  const thumb = document.createElement("span");
  thumb.className = "switch-thumb";
  track.append(thumb);
  label.append(input, track);
  return label;
}

function renderSidebar() {
  els.exclusiveToggle.checked = state.exclusive;
  els.profileList.replaceChildren();

  // System (read-only) entry first.
  const systemItem = document.createElement("li");
  systemItem.className = "profile-item system";
  if (selectedId === SYSTEM_ID) systemItem.classList.add("active");
  const systemMain = document.createElement("div");
  systemMain.className = "profile-main";
  const systemName = document.createElement("div");
  systemName.className = "profile-name";
  systemName.textContent = "系统 hosts";
  const systemSub = document.createElement("div");
  systemSub.className = "profile-sub";
  systemSub.textContent = "只读 · 当前文件";
  systemMain.append(systemName, systemSub);
  systemItem.append(systemMain);
  systemItem.addEventListener("click", () => selectProfile(SYSTEM_ID));
  els.profileList.append(systemItem);

  for (const profile of state.profiles) {
    const item = document.createElement("li");
    item.className = "profile-item";
    if (profile.id === selectedId) item.classList.add("active");

    const toggle = makeSwitch(profile.enabled, (checked) => {
      void setEnabled(profile.id, checked);
    });
    item.append(toggle);

    const main = document.createElement("div");
    main.className = "profile-main";
    const name = document.createElement("div");
    name.className = "profile-name";
    name.textContent = profile.name;
    const sub = document.createElement("div");
    sub.className = "profile-sub";
    sub.textContent =
      profile.type === "remote"
        ? `远程 · ${profile.fetchedAt ? formatTime(profile.fetchedAt) : "未刷新"}`
        : profile.enabled
        ? "已启用"
        : "未启用";
    main.append(name, sub);
    item.append(main);

    if (profile.type === "remote") {
      const tag = document.createElement("span");
      tag.className = "profile-tag remote";
      tag.textContent = "远程";
      item.append(tag);
    }

    item.addEventListener("click", () => selectProfile(profile.id));
    els.profileList.append(item);
  }

  const count = enabledCount();
  els.applyButton.textContent = count > 0 ? `应用到系统 (${count})` : "应用到系统";
}

function selectProfile(id) {
  selectedId = id;
  renderSidebar();
  loadIntoEditor();
}

// ---------- state sync ----------

function applyState(next) {
  if (!next) return;
  state = next;
  document.documentElement.dataset.theme = state.theme === "dark" ? "dark" : "light";
  document.documentElement.style.colorScheme = state.theme === "dark" ? "dark" : "light";
  // Keep selection valid.
  if (selectedId !== SYSTEM_ID && !state.profiles.some((p) => p.id === selectedId)) {
    selectedId = SYSTEM_ID;
  }
  renderSidebar();
  loadIntoEditor();
}

// ---------- actions ----------

async function setEnabled(id, enabled) {
  try {
    const result = await api.setEnabled(id, enabled);
    if (result && result.ok) applyState(result.state);
    else if (result && result.message) showToast(result.message, true);
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

async function toggleExclusive() {
  try {
    const result = await api.setExclusive(els.exclusiveToggle.checked);
    if (result && result.ok) applyState(result.state);
    else {
      els.exclusiveToggle.checked = state.exclusive;
      if (result && result.message) showToast(result.message, true);
    }
  } catch (error) {
    els.exclusiveToggle.checked = state.exclusive;
    showToast(error.message || String(error), true);
  }
}

async function refreshRemote() {
  const profile = selectedProfile();
  if (!profile || profile.type !== "remote") return;
  els.refreshRemote.disabled = true;
  els.refreshRemote.textContent = "刷新中…";
  try {
    const result = await api.refreshRemote(profile.id);
    if (result && result.ok) {
      applyState(result.state);
      showToast("已刷新远程方案");
    } else if (result && result.message) {
      showToast(result.message, true);
    }
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    els.refreshRemote.disabled = false;
    els.refreshRemote.textContent = "刷新";
  }
}

async function deleteCurrent() {
  const profile = selectedProfile();
  if (!profile) return;
  const confirmed = window.confirm(`确定删除方案“${profile.name}”？此操作不可撤销。`);
  if (!confirmed) return;
  try {
    const result = await api.deleteProfile(profile.id);
    if (result && result.ok) {
      selectedId = SYSTEM_ID;
      applyState(result.state);
      showToast("已删除方案");
    } else if (result && result.message) {
      showToast(result.message, true);
    }
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

async function applyToSystem() {
  const original = els.applyButton.textContent;
  els.applyButton.disabled = true;
  els.applyButton.textContent = "应用中…";
  try {
    const result = await api.apply();
    if (result && result.ok) {
      if (typeof result.systemContent === "string") {
        state.systemContent = result.systemContent;
        if (selectedId === SYSTEM_ID) loadIntoEditor();
      }
      showToast(result.method === "elevated" ? "已通过管理员授权写入系统 hosts" : "已写入系统 hosts");
    } else if (result && result.cancelled) {
      showToast(result.message || "已取消管理员授权。", true);
    } else {
      showToast((result && result.message) || "写入失败", true);
    }
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    els.applyButton.disabled = false;
    els.applyButton.textContent = original;
  }
}

// ---------- modal ----------

function openModal(options) {
  els.modalTitle.textContent = options.title;
  els.modalNameLabel.textContent = options.nameLabel || "名称";
  els.modalName.value = options.name || "";
  els.modalUrlField.hidden = !options.withUrl;
  els.modalUrl.value = "";
  els.modalError.hidden = true;
  els.modalError.textContent = "";
  els.modal.hidden = false;
  modalHandler = options.onConfirm;
  setTimeout(() => els.modalName.focus(), 0);
}

function closeModal() {
  els.modal.hidden = true;
  modalHandler = null;
}

function modalError(message) {
  els.modalError.hidden = false;
  els.modalError.textContent = message;
}

async function confirmModal() {
  if (!modalHandler) return;
  const name = els.modalName.value.trim();
  const url = els.modalUrl.value.trim();
  els.modalConfirm.disabled = true;
  try {
    const ok = await modalHandler({ name, url, setError: modalError });
    if (ok) closeModal();
  } finally {
    els.modalConfirm.disabled = false;
  }
}

function promptCreate() {
  openModal({
    title: "新建方案",
    name: "新方案",
    onConfirm: async ({ name, setError }) => {
      if (!name) {
        setError("名称不能为空。");
        return false;
      }
      const result = await api.createProfile(name);
      if (result && result.ok) {
        applyState(result.state);
        // Select the newly created (last) profile.
        const created = state.profiles[state.profiles.length - 1];
        if (created) selectProfile(created.id);
        return true;
      }
      setError((result && result.message) || "创建失败。");
      return false;
    },
  });
}

function promptRename() {
  const profile = selectedProfile();
  if (!profile) return;
  openModal({
    title: "重命名方案",
    name: profile.name,
    onConfirm: async ({ name, setError }) => {
      if (!name) {
        setError("名称不能为空。");
        return false;
      }
      const result = await api.renameProfile(profile.id, name);
      if (result && result.ok) {
        applyState(result.state);
        return true;
      }
      setError((result && result.message) || "重命名失败。");
      return false;
    },
  });
}

function promptImport() {
  openModal({
    title: "导入远程方案",
    nameLabel: "名称",
    name: "远程方案",
    withUrl: true,
    onConfirm: async ({ name, url, setError }) => {
      if (!url) {
        setError("请填写远程地址。");
        return false;
      }
      els.modalConfirm.textContent = "拉取中…";
      try {
        const result = await api.importRemote(name, url);
        if (result && result.ok) {
          applyState(result.state);
          const created = state.profiles[state.profiles.length - 1];
          if (created) selectProfile(created.id);
          return true;
        }
        setError((result && result.message) || "导入失败。");
        return false;
      } finally {
        els.modalConfirm.textContent = "确定";
      }
    },
  });
}

// ---------- events ----------

els.editor.addEventListener("input", () => {
  const text = els.editor.value;
  renderHighlight(text);
  renderValidation(text);
  autoGrow();
  syncScroll();
  scheduleSave();
});
els.editor.addEventListener("scroll", syncScroll);
els.editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !els.editor.readOnly) {
    event.preventDefault();
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    const value = els.editor.value;
    els.editor.value = `${value.slice(0, start)}\t${value.slice(end)}`;
    els.editor.selectionStart = els.editor.selectionEnd = start + 1;
    renderHighlight(els.editor.value);
    renderValidation(els.editor.value);
    autoGrow();
    scheduleSave();
  }
});

els.addProfile.addEventListener("click", promptCreate);
els.importRemote.addEventListener("click", promptImport);
els.exclusiveToggle.addEventListener("change", () => void toggleExclusive());
els.refreshRemote.addEventListener("click", () => void refreshRemote());
els.renameProfile.addEventListener("click", promptRename);
els.deleteProfile.addEventListener("click", () => void deleteCurrent());
els.applyButton.addEventListener("click", () => void applyToSystem());

els.modalCancel.addEventListener("click", closeModal);
els.modalConfirm.addEventListener("click", () => void confirmModal());
els.modal.addEventListener("click", (event) => {
  if (event.target === els.modal) closeModal();
});
els.modalName.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && els.modalUrlField.hidden) {
    event.preventDefault();
    void confirmModal();
  }
});
els.modalUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void confirmModal();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!els.modal.hidden) {
      closeModal();
      return;
    }
    api.close();
  }
});

api.onState(applyState);
void (async () => {
  try {
    const initial = await api.requestState();
    if (initial) applyState(initial);
  } catch {
    // The push from did-finish-load will populate state instead.
  }
})();
