/**
 * Pure conversion logic for the built-in "file convert" tool. This module never
 * imports electron, sharp, or touches the filesystem: it owns the format table,
 * target enumeration, output naming, text decoding, the text/data converters
 * (YAML / CSV / Markdown / XML) and the hand-rolled BMP / ICO encoders and
 * decoders. Everything here is unit-tested.
 */

import iconv from "iconv-lite";
import YAML from "yaml";

export type ConvertCategory =
  | "image"
  | "data"
  | "document"
  | "spreadsheet"
  | "presentation";

/**
 * Runtime capabilities the controller injects when listing targets. Both
 * external engines are downloaded on first use into userData.
 */
export interface Capabilities {
  /** LibreOffice is downloaded and ready. */
  office: boolean;
  /** The pdf2docx (PDF -> Word) runtime is downloaded and ready. */
  pdfword: boolean;
}

export const EMPTY_CAPABILITIES: Capabilities = {
  office: false,
  pdfword: false,
};

/** A downloadable engine a target depends on. */
export type ConvertComponent = "office" | "pdfword";

/** How a conversion is carried out, so the controller can route each request. */
export type ConvertEngine =
  | "image" // decoded / encoded with sharp (+ BMP/ICO helpers) in main
  | "data" // pure text transform in this module
  | "pdf" // rendered with a hidden BrowserWindow + printToPDF
  | "office" // LibreOffice (downloaded on first use)
  | "pdfword"; // pdf2docx + PaddleOCR for scanned pages (downloaded on first use)

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
  /** True when the target's engine is not yet downloaded. */
  needsDownload?: boolean;
  /** The downloadable engine this target needs, if any. */
  component?: ConvertComponent;
  /** Extra hint shown in the UI, e.g. fidelity caveats. */
  note?: string;
  /** True for formats that accept a quality slider (jpg / webp / avif). */
  quality?: boolean;
  /** True for spreadsheet -> PDF, which can scale each sheet onto one page. */
  fitSheets?: boolean;
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
const PDFWORD_NOTE_DOWNLOAD = "需下载 PDF 转换组件（首次使用）";
const PDFWORD_NOTE = "扫描页自动识别文字";
const PDF_IMAGES_NOTE = "输出到同名文件夹";

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
    // pdf -> docx uses pdf2docx, with OCR for scanned pages. pdf -> png/jpg
    // renders every page with PyMuPDF from the same component.
    if (e === "pdf") {
      const pdfword = (id: string, label: string, note: string): TargetFormat => ({
        id,
        label,
        engine: "pdfword",
        available: caps.pdfword,
        needsDownload: !caps.pdfword,
        component: "pdfword",
        note: caps.pdfword ? note : PDFWORD_NOTE_DOWNLOAD,
      });
      push(pdfword("docx", OFFICE_LABELS.docx, PDFWORD_NOTE));
      push(pdfword("png", "PNG 图片（每页一张）", PDF_IMAGES_NOTE));
      push(pdfword("jpg", "JPG 图片（每页一张）", PDF_IMAGES_NOTE));
      return targets;
    }
    for (const out of ["pdf", "docx", "odt", "txt", "html"]) {
      push(officeTarget(out, caps));
    }
    return targets;
  }

  if (category === "spreadsheet") {
    for (const out of ["pdf", "xlsx", "ods", "csv"]) {
      push(out === "pdf" ? { ...officeTarget(out, caps), fitSheets: true } : officeTarget(out, caps));
    }
    return targets;
  }

  // presentation
  for (const out of ["pdf", "pptx", "odp"]) {
    push(officeTarget(out, caps));
  }
  return targets;
}

function officeTarget(ext: string, caps: Capabilities): TargetFormat {
  const label = OFFICE_LABELS[ext] ?? ext.toUpperCase();
  return {
    id: ext,
    label,
    engine: "office",
    available: caps.office,
    needsDownload: !caps.office,
    component: "office",
    note: !caps.office ? OFFICE_NOTE_DOWNLOAD : undefined,
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

/** Like resolveOutputPath, for a folder named `stem` (" (1)", … on collision). */
export function resolveOutputDir(
  dir: string,
  stem: string,
  exists: (candidate: string) => boolean,
): string {
  const first = joinPath(dir, stem);
  if (!exists(first)) return first;
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = joinPath(dir, `${stem} (${n})`);
    if (!exists(candidate)) return candidate;
  }
  return joinPath(dir, `${stem} (${Date.now()})`);
}

// --- Text decoding --------------------------------------------------------

/**
 * Decode a text file's bytes. Honours UTF-8 / UTF-16 BOMs, accepts valid
 * UTF-8 without a BOM, and otherwise falls back to GB18030 (a superset of
 * GBK/GB2312), which is what Notepad and Excel write on Chinese Windows.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), "gb18030");
  }
}

/** UTF-8 with a BOM, so Excel on Chinese Windows opens CSV correctly. */
export function encodeCsvText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

// --- YAML -----------------------------------------------------------------

/** Serialise a JSON value into YAML. */
export function jsonToYaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

/**
 * Parse YAML (1.2, including block scalars, anchors and multiple documents)
 * into JSON. A multi-document stream becomes an array of documents.
 */
export function parseYaml(text: string): unknown {
  // `merge` enables the "<<" merge key that docker-compose files rely on.
  const docs = YAML.parseAllDocuments(text, { merge: true });
  const list = Array.isArray(docs) ? docs : [docs];
  for (const doc of list) {
    if (doc.errors.length > 0) {
      throw new Error(`YAML 解析失败：${doc.errors[0].message.split("\n")[0]}`);
    }
  }
  const values = list.map((doc) => doc.toJS({ maxAliasCount: 1_000 }));
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : values;
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

const MARKDOWN_STYLE = [
  "body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;line-height:1.7;max-width:820px;margin:40px auto;padding:0 24px;color:#1d1f27;}",
  "h1,h2,h3,h4{line-height:1.3;margin:1.4em 0 .6em;}",
  "code{background:#f1f2f6;padding:.15em .4em;border-radius:4px;font-family:Consolas,monospace;}",
  "pre{background:#f6f7f9;border:1px solid #e3e5ea;padding:14px 16px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;}",
  "pre code{background:none;padding:0;}",
  "blockquote{margin:1em 0;padding:.4em 1em;border-left:4px solid #d0d3dc;color:#5b606c;}",
  "table{border-collapse:collapse;margin:1em 0;}th,td{border:1px solid #d0d3dc;padding:6px 12px;}th{background:#f6f7f9;}",
  "img{max-width:100%;}a{color:#2563eb;}",
  "li>input[type=checkbox]{margin-right:.4em;}",
  "@media print{body{margin:0 auto;max-width:none;}pre,blockquote,table,img{break-inside:avoid;}img{max-height:240mm;object-fit:contain;}}",
].join("");

/**
 * Render GitHub-flavoured Markdown (tables, task lists, nested lists, fenced
 * code) to a standalone HTML document. `baseHref` lets relative image links
 * resolve against the source file's folder.
 */
export async function markdownToHtml(markdown: string, title = "Document", baseHref?: string): Promise<string> {
  const body = await renderMarkdownBody(markdown);
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="UTF-8">',
    ...(baseHref ? [`<base href="${xmlEscape(baseHref)}">`] : []),
    `<title>${xmlEscape(title)}</title>`,
    `<style>${MARKDOWN_STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Render just the Markdown body fragment (no surrounding document). */
export async function renderMarkdownBody(markdown: string): Promise<string> {
  // marked ships only as an ES module; this package compiles to CommonJS.
  const { marked } = await import("marked");
  const source = markdown.replace(/^\uFEFF/, "");
  return (marked.parse(source, { async: false, gfm: true }) as string).trim();
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
  // 0 = BI_RGB, 3 = BI_BITFIELDS, 6 = BI_ALPHABITFIELDS. Masks follow a 40-byte
  // header, or live inside V4/V5 headers at the same offset.
  const bitfields = compression === 3 || compression === 6;
  if (compression !== 0 && !bitfields) {
    throw new Error("暂不支持压缩的 BMP（RLE/JPEG/PNG）");
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

  if (bitfields || bpp === 16) {
    if (bpp !== 16 && bpp !== 32) throw new Error(`暂不支持 ${bpp} 位位域 BMP`);
    let masks: [number, number, number, number];
    if (bitfields) {
      const alpha = compression === 6 || dibSize >= 56 ? view.getUint32(14 + 52, true) : 0;
      masks = [view.getUint32(54, true), view.getUint32(58, true), view.getUint32(62, true), alpha];
    } else {
      masks = [0x7c00, 0x03e0, 0x001f, 0]; // 16-bit BI_RGB is 5-5-5
    }
    const channels = masks.map(maskShape);
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    for (let y = 0; y < height; y += 1) {
      let si = pixelOffset + y * rowSize;
      for (let x = 0; x < width; x += 1) {
        const value = bpp === 32 ? view.getUint32(si, true) : view.getUint16(si, true);
        const [r, g, b, a] = channels.map((shape) => (shape ? shape.read(value) : 255));
        setPixel(x, y, r, g, b, a);
        si += bpp / 8;
      }
    }
    if (channels[3] && !hasNonZeroAlpha(out)) forceOpaque(out);
    return { data: out, width, height };
  }

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

/** Shift/width of a BMP channel mask, scaling the channel to 0-255. */
function maskShape(mask: number): { read: (value: number) => number } | null {
  if (!mask) return null;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (((mask >>> (shift + bits)) & 1) === 1 && shift + bits < 32) bits += 1;
  const max = 2 ** bits - 1;
  return { read: (value) => Math.round((((value & mask) >>> shift) / max) * 255) };
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
