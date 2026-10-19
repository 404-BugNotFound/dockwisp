const api = window.translation;
const source = document.querySelector("#source");
const translated = document.querySelector("#translated");
const error = document.querySelector("#error");
const meta = document.querySelector("#meta");
const pin = document.querySelector("#pin");
const copy = document.querySelector("#copy");
let pinned = false;

api.onState((state) => {
  pinned = state.pinned === true;
  pin.textContent = pinned ? "取消固定" : "固定";
  source.textContent = state.sourceText || "";
  error.textContent = "";
  copy.disabled = state.status !== "success";
  if (state.status === "loading") {
    translated.textContent = "正在翻译…";
    meta.textContent = "翻译";
  } else if (state.status === "error") {
    translated.textContent = "";
    error.textContent = state.message || "翻译失败";
    meta.textContent = "翻译失败";
  } else {
    translated.textContent = state.translatedText || "";
    meta.textContent = `${state.sourceLanguage} → ${state.targetLanguage} · ${state.provider}`;
  }
});

document.querySelector("#close").addEventListener("click", () => api.close());
pin.addEventListener("click", () => api.pin(!pinned));
copy.addEventListener("click", () => api.copy());
