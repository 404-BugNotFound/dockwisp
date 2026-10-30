import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:net";

let pipeServer = null;
let pipeBytes = -1;

const child = spawn("native/bin/mouse-hook.exe", [], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout });
const seen = new Set();
const timeout = setTimeout(() => {
  child.kill();
  console.error("native helper smoke test timed out");
  process.exitCode = 1;
}, 8_000);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "ready") {
    seen.add("ready");
    child.stdin.write("hotkey 1 1\n");
    return;
  }
  if (message.type !== "response") return;
  if (message.id === "1" && message.ok) {
    seen.add("hotkey-on");
    child.stdin.write("selection 2\n");
  } else if (message.id === "2" && message.ok && typeof message.text === "string") {
    seen.add("selection");
    child.stdin.write("ping 3\n");
  } else if (message.id === "3" && message.ok) {
    seen.add("ping");
    child.stdin.write("seq 4\n");
  } else if (message.id === "4" && message.ok && Number.isInteger(message.sequence)) {
    seen.add("sequence");
    // GDI capture of a small top-left rectangle streamed over a named pipe;
    // verify the helper delivers exactly 64*64 RGBA bytes.
    const pipeName = `dockwisp-test-${process.pid}`;
    const server = createServer((socket) => {
      let received = 0;
      socket.on("data", (chunk) => {
        received += chunk.length;
      });
      socket.on("end", () => {
        pipeBytes = received;
      });
    });
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => {
      child.stdin.write(`capture 5 0 0 64 64 ${pipeName}\n`);
    });
    pipeServer = server;
  } else if (message.id === "5") {
    setTimeout(() => {
      if (message.ok && pipeBytes === 64 * 64 * 4) seen.add("capture");
      pipeServer?.close();
      child.stdin.write("hotkey 6 0\n");
    }, 200);
  } else if (message.id === "6" && message.ok) {
    seen.add("hotkey-off");
    child.stdin.write("quit 7\n");
  } else if (message.id === "7" && message.ok) {
    seen.add("quit");
  }
});

child.on("exit", (code) => {
  clearTimeout(timeout);
  const expected = ["ready", "hotkey-on", "selection", "ping", "sequence", "capture", "hotkey-off", "quit"];
  const missing = expected.filter((item) => !seen.has(item));
  if (code !== 0 || missing.length) {
    console.error(`native helper failed (exit=${code}, missing=${missing.join(",")})`);
    process.exitCode = 1;
    return;
  }
  console.log("native helper smoke test passed");
});
