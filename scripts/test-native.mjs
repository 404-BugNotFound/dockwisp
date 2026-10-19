import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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
}, 5_000);

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
    child.stdin.write("hotkey 5 0\n");
  } else if (message.id === "5" && message.ok) {
    seen.add("hotkey-off");
    child.stdin.write("quit 6\n");
  } else if (message.id === "6" && message.ok) {
    seen.add("quit");
  }
});

child.on("exit", (code) => {
  clearTimeout(timeout);
  const expected = ["ready", "hotkey-on", "selection", "ping", "sequence", "hotkey-off", "quit"];
  const missing = expected.filter((item) => !seen.has(item));
  if (code !== 0 || missing.length) {
    console.error(`native helper failed (exit=${code}, missing=${missing.join(",")})`);
    process.exitCode = 1;
    return;
  }
  console.log("native helper smoke test passed");
});
