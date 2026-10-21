/**
 * Pure conversion logic for the built-in "file convert" tool. This module never
 * imports electron, sharp, or touches the filesystem: it owns the format table,
 * target enumeration, output naming, the text/data converters (YAML / CSV /
 * Markdown / XML) and the hand-rolled BMP / ICO encoders and decoders.
 * Everything here is unit-tested.
 */

export type ConvertCategory =
  | "image"
  | "data"
  | "document"
  | "spreadsheet"
  | "presentation";

/**
 * Runtime capabilities the controller injects when listing targets. The only
 * external engine now is LibreOffice (downloaded on first use); `office` is
 * true once it is installed under userData.
 */
export interface Capabilities {
  /** LibreOffice is downloaded and ready. */
  office: boolean;
}

export const EMPTY_CAPABILITIES: Capabilities = {
  office: false,
};

/** How a conversion is carried out, so the controller can route each request. */
export type ConvertEngine =
  | "image" // decoded / encoded with sharp (+ BMP/ICO helpers) in main
  | "data" // pure text transform in this module
  | "pdf" // rendered with a hidden BrowserWindow + printToPDF
  | "office"; // LibreOffice (downloaded on first use)

/**
 * A conversion target offered for a file. This is the shape the launcher and
 * the convert window consume.
 */
export interface TargetFormat {
  /** Target extension, e.g. "pdf" / "docx" / "jpg". */
  id: string;
  /** Display label, e.g. "PDF" / "Word 文档 (DOCX)". */
  label: string;
  engine: ConvertEngine;
  /** Whether the target can be produced right now. */
  available: boolean;
  /** True for an office target when LibreOffice is not yet downloaded. */
  needsDownload?: boolean;
  /** Extra hint shown in the UI, e.g. fidelity caveats. */
  note?: string;
  /** True for formats that accept a quality slider (jpg / webp / avif). */
  quality?: boolean;
}

// Image inputs sharp can decode directly, plus bmp/ico/gif handled specially.
const IMAGE_INPUTS = new Set([
  "png", "jpg", "jpeg", "webp", "avif", "tiff", "tif", "gif", "bmp", "svg", "ico",
]);
// Image outputs we can produce. jpg/webp/avif take a quality value.
const IMAGE_OUTPUTS: Array<{ ext: string; label: string; quality?: boolean }> = [
  { ext: "png", label: "PNG" },
  { ext: "jpg", label: "JPG", quality: true },
  { ext: "webp", label: "WebP", quality: true },
  { ext: "avif", label: "AVIF", quality: true },
  { ext: "tiff", label: "TIFF" },
  { ext: "gif", label: "GIF" },
  { ext: "bmp", label: "BMP" },
  { ext: "ico", label: "ICO" },
];

const DATA_INPUTS = new Set([
  "json", "yaml", "yml", "csv", "md", "markdown", "html", "htm", "txt",
]);

// Document / spreadsheet / presentation inputs handled by LibreOffice.
const DOCUMENT_INPUTS = new Set(["doc", "docx", "odt", "rtf", "pdf"]);
const SPREADSHEET_INPUTS = new Set(["xls", "xlsx", "ods"]);
const PRESENTATION_INPUTS = new Set(["ppt", "pptx", "odp"]);

const OFFICE_LABELS: Record<string, string> = {
  pdf: "PDF",
  docx: "Word 文档 (DOCX)",
  odt: "OpenDocument 文本 (ODT)",
  txt: "纯文本 (TXT)",
  html: "网页 (HTML)",
  xlsx: "Excel 表格 (XLSX)",
  ods: "OpenDocument 表格 (ODS)",
  csv: "CSV",
  pptx: "PowerPoint 演示 (PPTX)",
  odp: "OpenDocument 演示 (ODP)",
};

const OFFICE_NOTE_DOWNLOAD = "需下载文档转换组件（首次使用）";

/** Lower-case extension without the leading dot ("" when none). */
export function extensionOf(filePath: string): string {
  const name = filePath.replace(/[\\/]+$/, "");
  const base = name.slice(name.replace(/\\/g, "/").lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The high-level category for an extension, or null when unsupported. */
export function categoryForExtension(ext: string): ConvertCategory | null {
  const e = ext.toLowerCase();
  if (IMAGE_INPUTS.has(e)) return "image";
  if (DATA_INPUTS.has(e)) return "data";
  if (DOCUMENT_INPUTS.has(e)) return "document";
  if (SPREADSHEET_INPUTS.has(e)) return "spreadsheet";
  if (PRESENTATION_INPUTS.has(e)) return "presentation";
  return null;
}

/**
 * Whether the launcher should surface the "file convert" feature for a dropped
 * file. True for any extension we know at least one target for.
 */
export function isConvertibleFile(filePath: string): boolean {
  return categoryForExtension(extensionOf(filePath)) !== null;
}

/** True when sharp can decode the extension directly (not bmp/ico). */
export function sharpCanDecode(ext: string): boolean {
  const e = ext.toLowerCase();
  return e !== "bmp" && e !== "ico" && IMAGE_INPUTS.has(e);
}

/**
 * List the possible targets for a file, marking each available/needsDownload
 * according to the injected capabilities. The source's own format is excluded.
 */
export function listTargetFormats(ext: string, caps: Capabilities): TargetFormat[] {
  const e = ext.toLowerCase();
  const category = categoryForExtension(e);
  if (!category) return [];
  const targets: TargetFormat[] = [];
  const seen = new Set<string>();
  const push = (target: TargetFormat): void => {
    if (seen.has(target.id)) return;
    // Never offer converting a format to itself (jpg/jpeg treated the same).
    if (target.id === e) return;
    if (target.id === "jpg" && e === "jpeg") return;
    if (target.id === "tiff" && e === "tif") return;
    seen.add(target.id);
    targets.push(target);
  };

  if (category === "image") {
    for (const out of IMAGE_OUTPUTS) {
      push({
        id: out.ext,
        label: out.label,
        engine: "image",
        available: true,
        quality: out.quality,
      });
    }
    // Any raster/vector image can be wrapped into a PDF via printToPDF.
    push({ id: "pdf", label: "PDF", engine: "pdf", available: true });
    return targets;
  }

  if (category === "data") {
    if (e === "json") {
      push({ id: "yaml", label: "YAML", engine: "data", available: true });
      push({ id: "csv", label: "CSV", engine: "data", available: true });
      push({ id: "xml", label: "XML", engine: "data", available: true });
    } else if (e === "yaml" || e === "yml") {
      push({ id: "json", label: "JSON", engine: "data", available: true });
    } else if (e === "csv") {
      push({ id: "json", label: "JSON", engine: "data", available: true });
      push(officeTarget("xlsx", caps));
      push(officeTarget("pdf", caps));
    } else if (e === "md" || e === "markdown") {
      push({ id: "html", label: "HTML", engine: "data", available: true });
      push({ id: "pdf", label: "PDF", engine: "pdf", available: true });
    } else if (e === "html" || e === "htm") {
      push({ id: "pdf", label: "PDF", engine: "pdf", available: true });
    } else if (e === "txt") {
      push({ id: "pdf", label: "PDF", engine: "pdf", available: true });
    }
    return targets;
  }

  if (category === "document") {
    // pdf -> docx uses LibreOffice's PDF import filter; fidelity is limited.
    if (e === "pdf") {
      push(officeTarget("docx", caps, "版式还原度一般"));
      return targets;
    }
    for (const out of ["pdf", "docx", "odt", "txt", "html"]) {
      push(officeTarget(out, caps));
    }
    return targets;
  }

  if (category === "spreadsheet") {
    for (const out of ["pdf", "xlsx", "ods", "csv"]) {
      push(officeTarget(out, caps));
    }
    return targets;
  }

  // presentation
  for (const out of ["pdf", "pptx", "odp"]) {
    push(officeTarget(out, caps));
  }
  return targets;
}

function officeTarget(ext: string, caps: Capabilities, note?: string): TargetFormat {
  const label = OFFICE_LABELS[ext] ?? ext.toUpperCase();
  return {
    id: ext,
    label,
    engine: "office",
    available: caps.office,
    needsDownload: !caps.office,
    note: note ?? (!caps.office ? OFFICE_NOTE_DOWNLOAD : undefined),
  };
}


// --- Output naming --------------------------------------------------------

/** Join a directory and file name with the platform-neutral separator kept. */
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

/** The file name without its directory. */
export function baseName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return normalized.slice(slash + 1);
}

/** The file name without directory and without its final extension. */
export function stemOf(filePath: string): string {
  const base = baseName(filePath);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/**
 * Pick a non-colliding output path in `dir` for `stem.targetExt`. `exists` is a
 * predicate (so the caller injects filesystem access); when the plain name is
 * taken, " (1)", " (2)", … are appended before the extension.
 */
export function resolveOutputPath(
  dir: string,
  stem: string,
  targetExt: string,
  exists: (candidate: string) => boolean,
): string {
  const ext = targetExt.replace(/^\./, "").toLowerCase();
  const first = joinPath(dir, `${stem}.${ext}`);
  if (!exists(first)) return first;
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = joinPath(dir, `${stem} (${n}).${ext}`);
    if (!exists(candidate)) return candidate;
  }
  // Extremely unlikely; fall back to a timestamped name.
  return joinPath(dir, `${stem} (${Date.now()}).${ext}`);
}

// --- YAML (common subset) -------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Serialise a JSON value into a compact, readable YAML subset. */
export function jsonToYaml(value: unknown): string {
  const lines: string[] = [];
  writeYaml(value as Json, 0, lines, false);
  const body = lines.join("\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

function writeYaml(value: Json, indent: number, lines: string[], inline: boolean): void {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isContainer(item) && !isEmptyContainer(item)) {
        lines.push(`${pad}-`);
        writeYaml(item, indent + 1, lines, false);
      } else {
        lines.push(`${pad}- ${scalarYaml(item)}`);
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(`${pad}{}`);
      return;
    }
    for (const key of keys) {
      const child = value[key];
      const keyText = yamlKey(key);
      if (isContainer(child) && !isEmptyContainer(child)) {
        lines.push(`${pad}${keyText}:`);
        writeYaml(child, indent + 1, lines, false);
      } else {
        lines.push(`${pad}${keyText}: ${scalarYaml(child)}`);
      }
    }
    return;
  }
  // Bare scalar document.
  lines.push(`${pad}${scalarYaml(value)}`);
}

function isContainer(value: Json): value is Json[] | { [key: string]: Json } {
  return Array.isArray(value) || isPlainObject(value);
}
function isEmptyContainer(value: Json): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}
function isPlainObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_\- ]*$/.test(key) && !/^\s|\s$/.test(key)
    ? key
    : JSON.stringify(key);
}

function scalarYaml(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (Array.isArray(value)) return "[]";
  if (isPlainObject(value)) return "{}";
  const text = String(value);
  if (text === "") return '""';
  // Quote when the value could be mistaken for another type or contains YAML
  // punctuation that would break parsing.
  if (
    /^(null|true|false|~|yes|no|on|off)$/i.test(text) ||
    /^[-+]?[\d.][\d.eE+-]*$/.test(text) ||
    /[:#\[\]{}>,&*!|%@`"']/.test(text) ||
    /^[\s-]/.test(text) ||
    /\s$/.test(text) ||
    text.includes("\n")
  ) {
    return JSON.stringify(text);
  }
  return text;
}

/** Parse a YAML subset into JSON. Throws on constructs it does not support. */
export function parseYaml(text: string): unknown {
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const lines: Array<{ indent: number; content: string }> = [];
  for (const raw of rawLines) {
    const noComment = stripComment(raw);
    if (noComment.trim() === "" || noComment.trim() === "---") continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ indent, content: noComment.trim() });
  }
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new Error("YAML 结构无法解析（缩进不一致）");
  }
  return value;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseBlock(
  lines: Array<{ indent: number; content: string }>,
  start: number,
  indent: number,
): [unknown, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (first.content.startsWith("- ") || first.content === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseSequence(
  lines: Array<{ indent: number; content: string }>,
  start: number,
  indent: number,
): [unknown[], number] {
  const result: unknown[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (!(line.content === "-" || line.content.startsWith("- "))) break;
    const rest = line.content === "-" ? "" : line.content.slice(2).trim();
    if (rest === "") {
      // Nested block on the following deeper lines.
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        result.push(value);
        i = next;
      } else {
        result.push(null);
        i += 1;
      }
    } else if (looksLikeInlineMapping(rest)) {
      // "- key: value" starts a mapping whose first key sits on the dash line.
      const synthetic = [{ indent: indent + 2, content: rest }, ...lines.slice(i + 1)];
      const [value, consumed] = parseMapping(synthetic, 0, indent + 2);
      result.push(value);
      // consumed counts entries in `synthetic`; the first was the inline one.
      i = i + consumed;
    } else {
      result.push(parseScalar(rest));
      i += 1;
    }
  }
  return [result, i];
}

function looksLikeInlineMapping(content: string): boolean {
  const colon = findKeyColon(content);
  return colon !== -1;
}

function parseMapping(
  lines: Array<{ indent: number; content: string }>,
  start: number,
  indent: number,
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.content.startsWith("- ") || line.content === "-") break;
    const colon = findKeyColon(line.content);
    if (colon === -1) {
      throw new Error(`YAML 无法解析该行：${line.content}`);
    }
    const key = unquoteKey(line.content.slice(0, colon).trim());
    const valuePart = line.content.slice(colon + 1).trim();
    if (valuePart === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        result[key] = value;
        i = next;
      } else {
        result[key] = null;
        i += 1;
      }
    } else {
      result[key] = parseScalar(valuePart);
      i += 1;
    }
  }
  return [result, i];
}

/** Index of the ":" that separates a mapping key from its value (or -1). */
function findKeyColon(content: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      if (i === content.length - 1 || content[i + 1] === " ") return i;
    }
  }
  return -1;
}

function unquoteKey(key: string): string {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return parseScalar(key) as string;
  }
  return key;
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "" || text === "~" || text.toLowerCase() === "null") return null;
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.toLowerCase() === "true") return true;
  if (text.toLowerCase() === "false") return false;
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Error(`YAML 字符串未闭合：${text}`);
    return JSON.parse(text);
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`YAML 字符串未闭合：${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    // Flow collections are converted to JSON-ish and parsed.
    return parseFlow(text);
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
    const num = Number(text);
    if (Number.isFinite(num)) return num;
  }
  return text;
}

/** Parse a YAML flow collection ([a, b] / {k: v}) by reusing JSON rules. */
function parseFlow(text: string): unknown {
  const jsonish = flowToJson(text);
  try {
    return JSON.parse(jsonish);
  } catch {
    throw new Error(`YAML 行内集合无法解析：${text}`);
  }
}

function flowToJson(text: string): string {
  // Wrap bare words / keys in quotes so JSON.parse accepts them.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let token = "";
      i += 1;
      while (i < text.length && text[i] !== quote) {
        token += text[i];
        i += 1;
      }
      i += 1;
      out += JSON.stringify(token);
      continue;
    }
    if (/[\[\]{}:,]/.test(ch)) {
      out += ch === ":" ? ":" : ch;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      out += "";
      i += 1;
      continue;
    }
    // Bare token up to the next structural char.
    let token = "";
    while (i < text.length && !/[\[\]{}:,]/.test(text[i])) {
      token += text[i];
      i += 1;
    }
    const trimmed = token.trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) out += trimmed;
    else if (trimmed === "true" || trimmed === "false" || trimmed === "null") out += trimmed;
    else out += JSON.stringify(trimmed);
  }
  return out;
}

// --- CSV ------------------------------------------------------------------

/** Serialise an array of flat objects (or arrays) into CSV with a header row. */
export function jsonToCsv(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("CSV 仅支持顶层为数组的 JSON");
  }
  if (value.length === 0) return "";
  const objects = value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
  if (objects) {
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const row of value as Array<Record<string, unknown>>) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
    const lines = [columns.map(csvCell).join(",")];
    for (const row of value as Array<Record<string, unknown>>) {
      lines.push(columns.map((col) => csvCell(row[col])).join(","));
    }
    return `${lines.join("\r\n")}\r\n`;
  }
  // Array-of-arrays or array-of-scalars.
  const lines = (value as unknown[]).map((row) =>
    Array.isArray(row) ? row.map(csvCell).join(",") : csvCell(row),
  );
  return `${lines.join("\r\n")}\r\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Parse CSV into an array of objects keyed by the header row. */
export function csvToJson(text: string): Array<Record<string, string>> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const result: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (row.length === 1 && row[0] === "") continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) {
      record[header[c] || `column${c + 1}`] = row[c] ?? "";
    }
    result.push(record);
  }
  return result;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// --- JSON -> XML ----------------------------------------------------------

/** Serialise a JSON value into an indented XML document. */
export function jsonToXml(value: unknown, rootName = "root"): string {
  const body = xmlNodes(value, rootName, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}

function xmlNodes(value: unknown, tag: string, depth: number): string {
  const pad = "  ".repeat(depth);
  const name = xmlName(tag);
  if (value === null || value === undefined) {
    return `${pad}<${name}/>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<${name}/>`;
    return value.map((item) => xmlNodes(item, singular(tag), depth)).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}<${name}/>`;
    const inner = entries
      .map(([key, child]) => xmlNodes(child, key, depth + 1))
      .join("\n");
    return `${pad}<${name}>\n${inner}\n${pad}</${name}>`;
  }
  return `${pad}<${name}>${xmlEscape(String(value))}</${name}>`;
}

function xmlName(tag: string): string {
  const cleaned = tag.replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function singular(tag: string): string {
  if (/ies$/i.test(tag)) return tag.replace(/ies$/i, "y");
  if (/s$/i.test(tag) && !/ss$/i.test(tag)) return tag.replace(/s$/i, "");
  return "item";
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Markdown -> HTML -----------------------------------------------------

/** Render a basic Markdown subset to a standalone HTML document. */
export function markdownToHtml(markdown: string, title = "Document"): string {
  const body = renderMarkdownBody(markdown);
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="UTF-8">',
    `<title>${xmlEscape(title)}</title>`,
    "<style>",
    "body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;line-height:1.7;max-width:820px;margin:40px auto;padding:0 24px;color:#1d1f27;}",
    "h1,h2,h3,h4{line-height:1.3;margin:1.4em 0 .6em;}",
    "code{background:#f1f2f6;padding:.15em .4em;border-radius:4px;font-family:Consolas,monospace;}",
    "pre{background:#1b1c23;color:#f1f2f6;padding:14px 16px;border-radius:8px;overflow:auto;}",
    "pre code{background:none;padding:0;color:inherit;}",
    "blockquote{margin:1em 0;padding:.4em 1em;border-left:4px solid #d0d3dc;color:#5b606c;}",
    "table{border-collapse:collapse;margin:1em 0;}th,td{border:1px solid #d0d3dc;padding:6px 12px;}",
    "img{max-width:100%;}a{color:#2563eb;}",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Render just the Markdown body fragment (no surrounding document). */
export function renderMarkdownBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inList = false;
  let listOrdered = false;
  const closeList = (): void => {
    if (inList) {
      out.push(listOrdered ? "</ol>" : "</ul>");
      inList = false;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    const fence = /^```(.*)$/.exec(line.trim());
    if (fence) {
      closeList();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      out.push(`<pre><code>${xmlEscape(codeLines.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      closeList();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])\1{0,}\s*$/.test(line) && line.replace(/\s/g, "").length >= 3) {
      closeList();
      out.push("<hr>");
      i += 1;
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ordered || unordered) {
      const wantOrdered = Boolean(ordered);
      if (!inList || listOrdered !== wantOrdered) {
        closeList();
        listOrdered = wantOrdered;
        inList = true;
        out.push(listOrdered ? "<ol>" : "<ul>");
      }
      const content = (ordered ? ordered[1] : unordered![1]).trim();
      out.push(`<li>${renderInline(content)}</li>`);
      i += 1;
      continue;
    }
    // Paragraph: gather consecutive text lines.
    closeList();
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^```/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

function renderInline(text: string): string {
  let result = xmlEscape(text);
  // Inline code first so its content is not touched by other rules.
  const codeStore: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, code) => {
    codeStore.push(code);
    return `\u0000${codeStore.length - 1}\u0000`;
  });
  // Images then links.
  result = result.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}">`);
  result = result.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  result = result.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  result = result.replace(/_([^_]+)_/g, "<em>$1</em>");
  result = result.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  result = result.replace(/\u0000(\d+)\u0000/g, (_m, idx) => `<code>${codeStore[Number(idx)]}</code>`);
  return result;
}

// --- BMP encoder ----------------------------------------------------------

/**
 * Encode top-to-bottom RGBA pixels as a 32-bit (BGRA) uncompressed BMP. Rows
 * are stored bottom-up per the BMP format; 32-bit rows need no padding.
 */
export function encodeBmp(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error("BMP 尺寸无效");
  if (rgba.length < width * height * 4) throw new Error("BMP 像素数据不足");
  const headerSize = 14 + 40;
  const pixelSize = width * height * 4;
  const out = new Uint8Array(headerSize + pixelSize);
  const view = new DataView(out.buffer);
  // BITMAPFILEHEADER
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, out.length, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, headerSize, true);
  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive => bottom-up
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 0, true); // BI_RGB
  view.setUint32(34, pixelSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);
  let offset = headerSize;
  for (let y = height - 1; y >= 0; y -= 1) {
    let src = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const r = rgba[src];
      const g = rgba[src + 1];
      const b = rgba[src + 2];
      const a = rgba[src + 3];
      out[offset] = b;
      out[offset + 1] = g;
      out[offset + 2] = r;
      out[offset + 3] = a;
      offset += 4;
      src += 4;
    }
  }
  return out;
}

// --- ICO encoder ----------------------------------------------------------

export interface IcoEntry {
  width: number;
  height: number;
  /** Already-encoded PNG bytes for this size. */
  png: Uint8Array;
}

/**
 * Wrap one or more PNG images into a single multi-resolution .ico file. Each
 * entry stores its PNG verbatim (Vista+ ICO allows embedded PNG); a dimension
 * of 256 is written as 0 per the format.
 */
export function encodeIco(entries: IcoEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error("ICO 至少需要一个尺寸");
  const count = entries.length;
  const headerSize = 6 + count * 16;
  let total = headerSize;
  for (const entry of entries) total += entry.png.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, count, true);
  let dirOffset = 6;
  let imageOffset = headerSize;
  for (const entry of entries) {
    out[dirOffset] = entry.width >= 256 ? 0 : entry.width;
    out[dirOffset + 1] = entry.height >= 256 ? 0 : entry.height;
    out[dirOffset + 2] = 0; // palette
    out[dirOffset + 3] = 0; // reserved
    view.setUint16(dirOffset + 4, 1, true); // color planes
    view.setUint16(dirOffset + 6, 32, true); // bit count
    view.setUint32(dirOffset + 8, entry.png.length, true);
    view.setUint32(dirOffset + 12, imageOffset, true);
    out.set(entry.png, imageOffset);
    imageOffset += entry.png.length;
    dirOffset += 16;
  }
  return out;
}

/** The icon sizes offered when exporting to .ico. */
export const ICO_SIZES = [16, 32, 48, 256] as const;

// --- Raw RGBA (for sharp) -------------------------------------------------

/** A decoded image as top-to-bottom RGBA pixels plus dimensions. */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

// --- BMP decoder ----------------------------------------------------------

/**
 * Decode an uncompressed BMP (24- or 32-bit BI_RGB, and simple 8/4/1-bit
 * palette images) into top-to-bottom RGBA. Throws on compressed or exotic
 * variants, which are rare for user files and better handled by failing
 * clearly than by producing garbage.
 */
export function decodeBmp(bytes: Uint8Array): RawImage {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error("不是有效的 BMP 文件");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (compression !== 0) {
    throw new Error("暂不支持压缩的 BMP");
  }
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (width <= 0 || height <= 0) throw new Error("BMP 尺寸无效");

  const out = new Uint8Array(width * height * 4);
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    const row = topDown ? y : height - 1 - y;
    const di = (row * width + x) * 4;
    out[di] = r;
    out[di + 1] = g;
    out[di + 2] = b;
    out[di + 3] = a;
  };

  if (bpp === 32 || bpp === 24) {
    const bytesPerPixel = bpp / 8;
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    for (let y = 0; y < height; y += 1) {
      let si = pixelOffset + y * rowSize;
      for (let x = 0; x < width; x += 1) {
        const b = bytes[si];
        const g = bytes[si + 1];
        const r = bytes[si + 2];
        const a = bpp === 32 ? bytes[si + 3] : 255;
        // Some 32-bit BMPs leave alpha as 0; treat an all-zero alpha plane as
        // opaque by detecting it per-pixel is unreliable, so keep raw alpha
        // only when any non-zero alpha exists (checked after the loop).
        setPixel(x, y, r, g, b, a);
        si += bytesPerPixel;
      }
    }
    if (bpp === 32 && !hasNonZeroAlpha(out)) forceOpaque(out);
    return { data: out, width, height };
  }

  if (bpp === 8 || bpp === 4 || bpp === 1) {
    const paletteOffset = 14 + dibSize;
    const colorsUsed = view.getUint32(46, true) || 1 << bpp;
    const palette: Array<[number, number, number]> = [];
    for (let i = 0; i < colorsUsed; i += 1) {
      const pi = paletteOffset + i * 4;
      palette.push([bytes[pi + 2], bytes[pi + 1], bytes[pi]]);
    }
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    for (let y = 0; y < height; y += 1) {
      const rowStart = pixelOffset + y * rowSize;
      for (let x = 0; x < width; x += 1) {
        let index: number;
        if (bpp === 8) {
          index = bytes[rowStart + x];
        } else if (bpp === 4) {
          const byte = bytes[rowStart + (x >> 1)];
          index = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
        } else {
          const byte = bytes[rowStart + (x >> 3)];
          index = (byte >> (7 - (x % 8))) & 1;
        }
        const color = palette[index] ?? [0, 0, 0];
        setPixel(x, y, color[0], color[1], color[2], 255);
      }
    }
    return { data: out, width, height };
  }

  throw new Error(`暂不支持 ${bpp} 位 BMP`);
}

function hasNonZeroAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return true;
  }
  return false;
}
function forceOpaque(rgba: Uint8Array): void {
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
}

// --- ICO reader -----------------------------------------------------------

/** One image entry extracted from an .ico container. */
export interface IcoImage {
  width: number;
  height: number;
  /** True when the payload is an embedded PNG; otherwise it is a BMP (DIB). */
  isPng: boolean;
  bytes: Uint8Array;
}

/**
 * Parse an .ico file's directory and return its images, largest first. The
 * caller decodes the chosen entry (PNG via sharp, BMP/DIB via decodeIcoDib).
 */
export function readIco(bytes: Uint8Array): IcoImage[] {
  if (bytes.length < 6) throw new Error("不是有效的 ICO 文件");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error("不是有效的 ICO 文件");
  }
  const count = view.getUint16(4, true);
  const images: IcoImage[] = [];
  for (let i = 0; i < count; i += 1) {
    const dir = 6 + i * 16;
    const width = bytes[dir] === 0 ? 256 : bytes[dir];
    const height = bytes[dir + 1] === 0 ? 256 : bytes[dir + 1];
    const size = view.getUint32(dir + 8, true);
    const offset = view.getUint32(dir + 12, true);
    if (offset + size > bytes.length) continue;
    const payload = bytes.subarray(offset, offset + size);
    const isPng =
      payload.length > 8 &&
      payload[0] === 0x89 &&
      payload[1] === 0x50 &&
      payload[2] === 0x4e &&
      payload[3] === 0x47;
    images.push({ width, height, isPng, bytes: payload });
  }
  if (images.length === 0) throw new Error("ICO 不含可用图像");
  images.sort((a, b) => b.width * b.height - a.width * a.height);
  return images;
}

/**
 * Decode an ICO BMP/DIB entry (no file header; height is doubled to include an
 * AND mask) into RGBA. Supports 32-bit (with alpha) and 24-bit entries, which
 * cover virtually all real icons; palette entries fall back to the AND mask for
 * transparency.
 */
export function decodeIcoDib(entry: Uint8Array): RawImage {
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  const dibSize = view.getUint32(0, true);
  const width = view.getInt32(4, true);
  const doubledHeight = view.getInt32(8, true);
  const bpp = view.getUint16(14, true);
  const height = Math.abs(doubledHeight) / 2;
  if (width <= 0 || height <= 0) throw new Error("ICO 位图尺寸无效");

  const out = new Uint8Array(width * height * 4);
  const set = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    const row = height - 1 - y; // DIB is bottom-up
    const di = (row * width + x) * 4;
    out[di] = r;
    out[di + 1] = g;
    out[di + 2] = b;
    out[di + 3] = a;
  };

  if (bpp === 32) {
    const rowSize = width * 4;
    let si = dibSize;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        set(x, y, entry[si + 2], entry[si + 1], entry[si], entry[si + 3]);
        si += 4;
      }
    }
    if (!hasNonZeroAlpha(out)) forceOpaque(out);
    return { data: out, width, height };
  }

  if (bpp === 24) {
    const rowSize = Math.floor((24 * width + 31) / 32) * 4;
    const xorStart = dibSize;
    const andStart = xorStart + rowSize * height;
    const andRowSize = Math.floor((width + 31) / 32) * 4;
    for (let y = 0; y < height; y += 1) {
      let si = xorStart + y * rowSize;
      const andRow = andStart + y * andRowSize;
      for (let x = 0; x < width; x += 1) {
        const b = entry[si];
        const g = entry[si + 1];
        const r = entry[si + 2];
        const andByte = entry[andRow + (x >> 3)];
        const masked = (andByte >> (7 - (x % 8))) & 1;
        set(x, y, r, g, b, masked ? 0 : 255);
        si += 3;
      }
    }
    return { data: out, width, height };
  }

  throw new Error(`暂不支持 ${bpp} 位 ICO 位图`);
}
