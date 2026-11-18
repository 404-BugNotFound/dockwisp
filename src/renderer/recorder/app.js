"use strict";

// Hidden recording page. The main process calls window.dockwispRecorderStart()
// (with user activation) after load; encoded chunks stream back over ipc.

const FRAME_RATE = 30;
const TIMESLICE_MS = 1000;
const AUDIO_BITRATE = 128000;

const api = window.recorder;
const video = document.getElementById("source");
const canvas = document.getElementById("crop");

let mediaRecorder = null;
let drawTimer = null;
let audioContext = null;
const ownedTracks = [];
// Chunks are converted asynchronously; the chain keeps them in order.
let sendChain = Promise.resolve();
let failed = false;

/** Pick the best supported container/codec, preferring MP4 (H.264/AAC). */
function pickMimeType(withAudio) {
  const candidates = withAudio
    ? [
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4;codecs=avc1,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]
    : [
        "video/mp4;codecs=avc1",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function videoBitrate(width, height) {
  // Roughly 0.12 bits per pixel per frame, clamped to 2-16 Mbps.
  const bits = width * height * FRAME_RATE * 0.12;
  return Math.round(Math.min(16e6, Math.max(2e6, bits)));
}

function fail(error) {
  if (failed) return;
  failed = true;
  cleanup();
  api.error(error && error.message ? error.message : String(error));
}

function cleanup() {
  if (drawTimer) {
    clearInterval(drawTimer);
    drawTimer = null;
  }
  for (const track of ownedTracks) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
  ownedTracks.length = 0;
  if (audioContext) {
    void audioContext.close().catch(() => undefined);
    audioContext = null;
  }
}

async function buildVideoTrack(displayStream, config) {
  const sourceTrack = displayStream.getVideoTracks()[0];
  if (!sourceTrack) throw new Error("未获取到屏幕画面");
  if (config.fullScreen) return sourceTrack;

  video.srcObject = new MediaStream([sourceTrack]);
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
  }
  // The captured frame may not be at physical resolution; scale the crop.
  const scaleX = video.videoWidth / config.displayWidth;
  const scaleY = video.videoHeight / config.displayHeight;
  const sx = config.crop.x * scaleX;
  const sy = config.crop.y * scaleY;
  const sw = config.crop.width * scaleX;
  const sh = config.crop.height * scaleY;
  // Even dimensions keep H.264 encoders happy.
  canvas.width = Math.max(2, Math.round(sw / 2) * 2);
  canvas.height = Math.max(2, Math.round(sh / 2) * 2);
  const context = canvas.getContext("2d", { alpha: false });
  const draw = () => context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  draw();
  // Timers keep running in this hidden window (backgroundThrottling: false),
  // unlike requestAnimationFrame.
  drawTimer = setInterval(draw, Math.round(1000 / FRAME_RATE));
  const track = canvas.captureStream(FRAME_RATE).getVideoTracks()[0];
  ownedTracks.push(track);
  return track;
}

async function buildAudioTrack(displayStream, config) {
  if (config.audio === "none") return null;
  const loopback = displayStream.getAudioTracks()[0] || null;
  if (config.audio === "system") return loopback;

  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  for (const track of micStream.getTracks()) ownedTracks.push(track);
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  if (loopback) {
    audioContext.createMediaStreamSource(new MediaStream([loopback])).connect(destination);
  }
  audioContext.createMediaStreamSource(micStream).connect(destination);
  const mixed = destination.stream.getAudioTracks()[0];
  ownedTracks.push(mixed);
  return mixed;
}

async function start() {
  const config = await api.getConfig();
  if (!config) throw new Error("录屏配置缺失");

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: config.displayWidth },
      height: { ideal: config.displayHeight },
      frameRate: { ideal: FRAME_RATE },
    },
    audio: config.audio !== "none",
  });
  for (const track of displayStream.getTracks()) ownedTracks.push(track);

  const videoTrack = await buildVideoTrack(displayStream, config);
  const audioTrack = await buildAudioTrack(displayStream, config);
  const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
  const stream = new MediaStream(tracks);

  const settings = videoTrack.getSettings();
  const width = settings.width || config.crop.width;
  const height = settings.height || config.crop.height;
  const mimeType = pickMimeType(Boolean(audioTrack));
  const options = { videoBitsPerSecond: videoBitrate(width, height) };
  if (mimeType) options.mimeType = mimeType;
  if (audioTrack) options.audioBitsPerSecond = AUDIO_BITRATE;

  mediaRecorder = new MediaRecorder(stream, options);
  mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const blob = event.data;
    sendChain = sendChain
      .then(() => blob.arrayBuffer())
      .then((buffer) => api.chunk(new Uint8Array(buffer)))
      .catch((error) => fail(error));
  };
  mediaRecorder.onpause = () => api.state(true);
  mediaRecorder.onresume = () => api.state(false);
  mediaRecorder.onerror = (event) => fail(event.error || new Error("编码器出错"));
  mediaRecorder.onstop = () => {
    // onstop fires after the final dataavailable, so the chain is complete.
    void sendChain.then(() => {
      cleanup();
      if (!failed) api.stopped();
    });
  };
  // The user ending the share (or the display disappearing) stops recording.
  videoTrack.addEventListener("ended", () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  });

  mediaRecorder.start(TIMESLICE_MS);
  api.started({ mimeType: mediaRecorder.mimeType || mimeType || "video/webm" });
}

api.onCommand((command) => {
  if (!mediaRecorder) {
    if (command === "stop") {
      cleanup();
      api.stopped();
    }
    return;
  }
  if (command === "pause" && mediaRecorder.state === "recording") {
    mediaRecorder.pause();
  } else if (command === "resume" && mediaRecorder.state === "paused") {
    mediaRecorder.resume();
  } else if (command === "stop" && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
});

window.dockwispRecorderStart = () => {
  start().catch((error) => fail(error));
};
