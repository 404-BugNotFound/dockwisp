"use strict";

const timeLabel = document.getElementById("time");
const pauseButton = document.getElementById("pause");
const stopButton = document.getElementById("stop");
const bar = document.getElementById("bar");

let paused = false;
let baseElapsed = 0;
let baseAt = performance.now();

function format(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function render() {
  const elapsed = paused ? baseElapsed : baseElapsed + (performance.now() - baseAt);
  timeLabel.textContent = format(elapsed);
}

window.recordBar.onState((state) => {
  paused = state.paused;
  baseElapsed = state.elapsedMs;
  baseAt = performance.now();
  pauseButton.textContent = paused ? "继续" : "暂停";
  bar.classList.toggle("paused", paused);
  pauseButton.disabled = state.stopping;
  stopButton.disabled = state.stopping;
  render();
});

setInterval(render, 250);

pauseButton.addEventListener("click", () => window.recordBar.togglePause());
stopButton.addEventListener("click", () => {
  pauseButton.disabled = true;
  stopButton.disabled = true;
  window.recordBar.stop();
});
