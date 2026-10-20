import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const OCR_TIMEOUT_MS = 45_000;
const OCR_MAX_BUFFER = 10 * 1024 * 1024;

// Matches a single CJK character (unified ideographs, common punctuation and
// full-width forms). Windows OCR inserts spaces between adjacent ideographs,
// which we strip while leaving spaces inside Latin words untouched.
const CJK = "\\u2e80-\\u2eff\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g");
const SPACE_BEFORE_CJK_PUNCT = new RegExp(`[ \\t]+(?=[\\u3000-\\u303f\\uff00-\\uffef])`, "g");

/**
 * Clean up raw Windows OCR text: drop the spaces the engine inserts between
 * CJK characters and before CJK punctuation, while preserving spaces between
 * Latin words and all line breaks.
 */
export function normalizeOcrText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      let cleaned = line;
      // Run twice: a single pass leaves a space when three ideographs meet
      // because the lookbehind character is consumed by the previous match.
      cleaned = cleaned.replace(SPACE_BETWEEN_CJK, "$1");
      cleaned = cleaned.replace(SPACE_BETWEEN_CJK, "$1");
      cleaned = cleaned.replace(SPACE_BEFORE_CJK_PUNCT, "");
      return cleaned.replace(/[ \t]+$/g, "");
    })
    .join("\n")
    .trim();
}

/** Absolute path to the bundled ocr.ps1 (packaged vs. development layout). */
function resolveScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "ocr.ps1")
    : path.join(process.cwd(), "native", "ocr.ps1");
}

/** Locate powershell.exe, falling back to the bare name on the PATH. */
function resolvePowerShell(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

/**
 * Run the WinRT OCR script against an image file and return the recognised
 * text (normalised). Resolves to "" when the image contains no text; rejects
 * with a Chinese error message (including any stderr) on failure.
 */
export function recognizeImageFile(imagePath: string): Promise<string> {
  const script = resolveScriptPath();
  if (!existsSync(script)) {
    return Promise.reject(new Error(`OCR 脚本缺失：${script}`));
  }
  const powershell = resolvePowerShell();
  return new Promise<string>((resolve, reject) => {
    execFile(
      powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", imagePath],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: OCR_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || "").trim() || error.message;
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error(`无法启动 PowerShell 进行文字识别：${detail}`));
            return;
          }
          reject(new Error(`文字识别失败：${detail}`));
          return;
        }
        resolve(normalizeOcrText(stdout ?? ""));
      },
    );
  });
}
