import { spawn } from "node:child_process";
import { electronExecutable } from "./electron-runtime.mjs";

const executable = await electronExecutable();
const child = spawn(executable, [".", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Electron exited via ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
