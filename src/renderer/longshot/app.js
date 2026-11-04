"use strict";

const thumb = document.getElementById("thumb");
const viewport = document.getElementById("viewport");
const heightLabel = document.getElementById("heightLabel");

window.longshot.onPreview((preview) => {
  thumb.src = preview.dataUrl;
  heightLabel.textContent = String(preview.height);
  // Keep the newest content in view.
  requestAnimationFrame(() => {
    viewport.scrollTop = viewport.scrollHeight;
  });
});

document.getElementById("done").addEventListener("click", () => window.longshot.done());
document.getElementById("cancel").addEventListener("click", () => window.longshot.cancel());
