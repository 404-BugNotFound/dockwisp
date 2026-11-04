"use strict";

const image = document.getElementById("pinned");
const zoomTag = document.getElementById("zoom");
const controls = document.getElementById("controls");
const btnMin = document.getElementById("btn-min");
const btnClose = document.getElementById("btn-close");

let scale = 1;
let zoomTimer = null;

window.pin.onImage((payload) => {
  image.src = payload.dataUrl;
  if (typeof payload.scale === "number" && payload.scale > 0) scale = payload.scale;
});

// Dragging moves the window. Pointer events are used instead of
// -webkit-app-region so double-click and the context menu keep working.
let dragging = false;
let startX = 0;
let startY = 0;

window.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  dragging = true;
  startX = event.screenX;
  startY = event.screenY;
  window.pin.dragStart();
  document.body.setPointerCapture?.(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  window.pin.dragMove(event.screenX - startX, event.screenY - startY);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  window.pin.dragEnd();
}

window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

// Wheel zoom (10%–500%), anchored at the window's top-left corner.
window.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const step = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(5, Math.max(0.1, scale * step));
    if (next === scale) return;
    window.pin.zoom(next).then((applied) => {
      scale = applied;
      showZoom(applied);
    });
  },
  { passive: false },
);

function showZoom(value) {
  zoomTag.textContent = `${Math.round(value * 100)}%`;
  zoomTag.hidden = false;
  if (zoomTimer) clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    zoomTag.hidden = true;
  }, 900);
}

window.addEventListener("dblclick", () => window.pin.close());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.pin.close();
});

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.pin.menu();
});

// Window controls. Stop pointerdown and dblclick from reaching the window so
// clicking a button never starts a drag or triggers the double-click close.
controls.addEventListener("pointerdown", (event) => event.stopPropagation());
controls.addEventListener("dblclick", (event) => event.stopPropagation());

btnMin.addEventListener("click", () => window.pin.minimize());
btnClose.addEventListener("click", () => window.pin.close());
