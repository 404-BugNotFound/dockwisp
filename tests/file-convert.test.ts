import assert from "node:assert/strict";
import test from "node:test";
import {
  baseName,
  categoryForExtension,
  csvToJson,
  decodeBmp,
  decodeIcoDib,
  EMPTY_CAPABILITIES,
  encodeBmp,
  encodeIco,
  extensionOf,
  isConvertibleFile,
  jsonToCsv,
  jsonToXml,
  jsonToYaml,
  listTargetFormats,
  markdownToHtml,
  parseYaml,
  readIco,
  renderMarkdownBody,
  resolveOutputPath,
  sharpCanDecode,
  stemOf,
  type Capabilities,
} from "../src/core/file-convert";

const OFFICE_READY: Capabilities = { office: true };

// --- Extension / category -------------------------------------------------

test("extensionOf extracts lowercase extension", () => {
  assert.equal(extensionOf("C:/a/b/Photo.PNG"), "png");
  assert.equal(extensionOf("D:\\x\\report.final.DOCX"), "docx");
  assert.equal(extensionOf("/tmp/noext"), "");
  assert.equal(extensionOf("/tmp/.hidden"), "");
});

test("baseName and stemOf handle both separators", () => {
  assert.equal(baseName("C:/a/b/Photo.png"), "Photo.png");
  assert.equal(baseName("D:\\a\\b\\Photo.png"), "Photo.png");
  assert.equal(stemOf("D:\\a\\b\\report.final.docx"), "report.final");
});

test("categoryForExtension classifies supported inputs", () => {
  assert.equal(categoryForExtension("png"), "image");
  assert.equal(categoryForExtension("tiff"), "image");
  assert.equal(categoryForExtension("avif"), "image");
  assert.equal(categoryForExtension("json"), "data");
  assert.equal(categoryForExtension("docx"), "document");
  assert.equal(categoryForExtension("pdf"), "document");
  assert.equal(categoryForExtension("xlsx"), "spreadsheet");
  assert.equal(categoryForExtension("pptx"), "presentation");
  assert.equal(categoryForExtension("odp"), "presentation");
  // Audio/video are no longer supported.
  assert.equal(categoryForExtension("mp4"), null);
  assert.equal(categoryForExtension("mp3"), null);
  assert.equal(categoryForExtension("exe"), null);
});

test("isConvertibleFile only accepts supported files", () => {
  assert.equal(isConvertibleFile("a/b/c.png"), true);
  assert.equal(isConvertibleFile("a/b/c.json"), true);
  assert.equal(isConvertibleFile("a/b/c.docx"), true);
  assert.equal(isConvertibleFile("a/b/c.mp4"), false);
  assert.equal(isConvertibleFile("a/b/c.exe"), false);
});

test("sharpCanDecode excludes bmp and ico", () => {
  assert.equal(sharpCanDecode("png"), true);
  assert.equal(sharpCanDecode("tiff"), true);
  assert.equal(sharpCanDecode("svg"), true);
  assert.equal(sharpCanDecode("bmp"), false);
  assert.equal(sharpCanDecode("ico"), false);
  assert.equal(sharpCanDecode("mp4"), false);
});

// --- Target enumeration ---------------------------------------------------

test("image targets exclude the source and offer pdf", () => {
  const png = listTargetFormats("png", EMPTY_CAPABILITIES).map((t) => t.id);
  assert.ok(!png.includes("png"));
  for (const want of ["jpg", "webp", "avif", "tiff", "gif", "bmp", "ico", "pdf"]) {
    assert.ok(png.includes(want), `missing ${want}`);
  }
  // jpeg source is not offered jpg (same format).
  assert.ok(!listTargetFormats("jpeg", EMPTY_CAPABILITIES).map((t) => t.id).includes("jpg"));
  // tif source is not offered tiff.
  assert.ok(!listTargetFormats("tif", EMPTY_CAPABILITIES).map((t) => t.id).includes("tiff"));
});

test("image targets are always available (no download needed)", () => {
  const targets = listTargetFormats("png", EMPTY_CAPABILITIES);
  assert.ok(targets.every((t) => t.available));
});

test("quality flag is set on jpg/webp/avif only", () => {
  const targets = listTargetFormats("png", EMPTY_CAPABILITIES);
  assert.equal(targets.find((t) => t.id === "jpg")?.quality, true);
  assert.equal(targets.find((t) => t.id === "webp")?.quality, true);
  assert.equal(targets.find((t) => t.id === "avif")?.quality, true);
  assert.notEqual(targets.find((t) => t.id === "png" || t.id === "tiff")?.quality, true);
});

test("data targets cover json/yaml/csv/md conversions (pure, always available)", () => {
  assert.deepEqual(
    listTargetFormats("json", EMPTY_CAPABILITIES).map((t) => t.id).sort(),
    ["csv", "xml", "yaml"],
  );
  assert.deepEqual(listTargetFormats("yaml", EMPTY_CAPABILITIES).map((t) => t.id), ["json"]);
  const md = listTargetFormats("md", EMPTY_CAPABILITIES);
  assert.ok(md.find((t) => t.id === "html")?.available);
  assert.ok(md.find((t) => t.id === "pdf")?.available);
});

test("office targets flag needsDownload when office missing and available when ready", () => {
  const docMissing = listTargetFormats("docx", EMPTY_CAPABILITIES);
  assert.ok(docMissing.length > 0);
  assert.ok(docMissing.every((t) => t.engine === "office"));
  assert.ok(docMissing.every((t) => !t.available && t.needsDownload));

  const docReady = listTargetFormats("docx", OFFICE_READY);
  assert.ok(docReady.find((t) => t.id === "pdf")?.available);
  assert.ok(docReady.every((t) => !t.needsDownload));
});

test("pdf source offers docx with a fidelity note", () => {
  const pdf = listTargetFormats("pdf", OFFICE_READY);
  assert.deepEqual(pdf.map((t) => t.id), ["docx"]);
  assert.ok(pdf[0].available);
  assert.ok(pdf[0].note && pdf[0].note.includes("版式"));
});

test("spreadsheet and presentation targets", () => {
  const xlsx = listTargetFormats("xlsx", OFFICE_READY).map((t) => t.id).sort();
  assert.deepEqual(xlsx, ["csv", "ods", "pdf"]);
  const pptx = listTargetFormats("pptx", OFFICE_READY).map((t) => t.id).sort();
  assert.deepEqual(pptx, ["odp", "pdf"]);
});

test("csv offers pure json plus office-gated xlsx/pdf", () => {
  const csv = listTargetFormats("csv", EMPTY_CAPABILITIES);
  assert.ok(csv.find((t) => t.id === "json")?.available); // pure
  assert.ok(csv.find((t) => t.id === "xlsx")?.needsDownload);
  assert.ok(csv.find((t) => t.id === "pdf")?.needsDownload);
  const csvReady = listTargetFormats("csv", OFFICE_READY);
  assert.ok(csvReady.find((t) => t.id === "xlsx")?.available);
});

// --- Output naming --------------------------------------------------------

test("resolveOutputPath avoids collisions with numeric suffix", () => {
  const taken = new Set(["C:/out/a.png", "C:/out/a (1).png"]);
  assert.equal(resolveOutputPath("C:/out", "a", "png", (c) => taken.has(c)), "C:/out/a (2).png");
  assert.equal(resolveOutputPath("C:/out", "b", "jpg", () => false), "C:/out/b.jpg");
});

test("resolveOutputPath keeps backslash separator", () => {
  assert.equal(resolveOutputPath("D:\\docs", "report", "pdf", () => false), "D:\\docs\\report.pdf");
});

// --- YAML -----------------------------------------------------------------

test("jsonToYaml renders nested structures", () => {
  const yaml = jsonToYaml({ name: "demo", count: 3, nested: { a: true, b: null }, list: [1, "two"] });
  assert.ok(yaml.includes("name: demo"));
  assert.ok(yaml.includes("count: 3"));
  assert.ok(yaml.includes("  a: true"));
  assert.ok(yaml.includes("  b: null"));
  assert.ok(yaml.includes("- 1"));
});

test("parseYaml round-trips the common subset", () => {
  const original = {
    title: "Hello: World",
    enabled: true,
    retries: 5,
    tags: ["a", "b", "c"],
    server: { host: "localhost", port: 8080 },
    items: [{ id: 1, name: "one" }, { id: 2, name: "two" }],
  };
  assert.deepEqual(parseYaml(jsonToYaml(original)), original);
});

test("parseYaml handles scalars, flow collections and comments", () => {
  const parsed = parseYaml(
    ["# c", "name: test  # inline", "ports: [80, 443]", "meta: {a: 1, b: two}", "empty:", "flag: false"].join("\n"),
  ) as Record<string, unknown>;
  assert.equal(parsed.name, "test");
  assert.deepEqual(parsed.ports, [80, 443]);
  assert.deepEqual(parsed.meta, { a: 1, b: "two" });
  assert.equal(parsed.empty, null);
  assert.equal(parsed.flag, false);
});

test("parseYaml throws on malformed input", () => {
  assert.throws(() => parseYaml('key: "unterminated'));
});

// --- CSV ------------------------------------------------------------------

test("jsonToCsv builds a header from object keys", () => {
  const lines = jsonToCsv([{ a: 1, b: "x" }, { a: 2, b: "y,z", c: true }]).trim().split("\r\n");
  assert.equal(lines[0], "a,b,c");
  assert.equal(lines[1], "1,x,");
  assert.equal(lines[2], '2,"y,z",true');
});

test("csvToJson parses quoted cells and newlines", () => {
  assert.deepEqual(csvToJson('a,b\r\n1,"hello, world"\r\n2,"line\nbreak"\r\n'), [
    { a: "1", b: "hello, world" },
    { a: "2", b: "line\nbreak" },
  ]);
});

test("jsonToCsv rejects non-array input", () => {
  assert.throws(() => jsonToCsv({ a: 1 }));
});

// --- XML ------------------------------------------------------------------

test("jsonToXml serialises and escapes", () => {
  const xml = jsonToXml({ users: [{ name: "a" }, { name: "b" }] });
  assert.ok(xml.startsWith("<?xml"));
  assert.ok(xml.includes("<name>a</name>"));
  assert.ok(jsonToXml({ note: "a < b & c" }).includes("a &lt; b &amp; c"));
});

// --- Markdown -------------------------------------------------------------

test("renderMarkdownBody handles headings, lists, code and inline", () => {
  const html = renderMarkdownBody(
    ["# Title", "", "Some **bold** and *italic* and `code`.", "", "- one", "- two", "", "```", "let x = 1;", "```", "", "> a quote"].join("\n"),
  );
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<pre><code>"));
  assert.ok(html.includes("<blockquote>"));
});

test("markdownToHtml wraps the body in a document", () => {
  const html = markdownToHtml("# Hi", "T");
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("<title>T</title>"));
  assert.ok(html.includes("<h1>Hi</h1>"));
});

// --- BMP encode / decode --------------------------------------------------

test("encodeBmp writes a valid 32-bit header", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
  const bmp = encodeBmp(rgba, 2, 2);
  assert.equal(bmp[0], 0x42);
  assert.equal(bmp[1], 0x4d);
  const view = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  assert.equal(view.getUint32(10, true), 54);
  assert.equal(view.getInt32(18, true), 2);
  assert.equal(view.getInt32(22, true), 2);
  assert.equal(view.getUint16(28, true), 32);
});

test("encodeBmp then decodeBmp round-trips pixels", () => {
  const rgba = new Uint8Array([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]);
  const bmp = encodeBmp(rgba, 2, 2);
  const decoded = decodeBmp(bmp);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data], [...rgba]);
});

test("encodeBmp validates inputs", () => {
  assert.throws(() => encodeBmp(new Uint8Array(4), 0, 1));
  assert.throws(() => encodeBmp(new Uint8Array(3), 2, 2));
});

test("decodeBmp rejects non-bmp", () => {
  assert.throws(() => decodeBmp(new Uint8Array([1, 2, 3, 4])));
});

// --- ICO encode / read ----------------------------------------------------

test("encodeIco embeds PNG entries with a directory", () => {
  const png16 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
  const png256 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7]);
  const ico = encodeIco([
    { width: 16, height: 16, png: png16 },
    { width: 256, height: 256, png: png256 },
  ]);
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  assert.equal(view.getUint16(2, true), 1);
  assert.equal(view.getUint16(4, true), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 0); // 256 stored as 0
});

test("encodeIco then readIco recovers png entries largest-first", () => {
  const png16 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const png48 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3, 4, 5, 6, 7, 8]);
  const ico = encodeIco([
    { width: 16, height: 16, png: png16 },
    { width: 48, height: 48, png: png48 },
  ]);
  const images = readIco(ico);
  assert.equal(images.length, 2);
  assert.equal(images[0].width, 48); // largest first
  assert.ok(images[0].isPng);
  assert.deepEqual([...images[0].bytes], [...png48]);
});

test("encodeIco rejects empty input", () => {
  assert.throws(() => encodeIco([]));
});

test("decodeIcoDib decodes a 32-bit icon entry", () => {
  // Build a minimal 2x2 32-bit DIB: 40-byte header, height doubled to 4,
  // bottom-up BGRA rows, no AND mask needed for 32-bit with alpha.
  const width = 2;
  const height = 2;
  const header = new Uint8Array(40);
  const view = new DataView(header.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  // Bottom-up rows: row0 = bottom. Pixel BGRA.
  const pixels = new Uint8Array([
    // bottom row (y=1 in image): two pixels
    30, 20, 10, 255, 60, 50, 40, 255,
    // top row (y=0 in image)
    90, 80, 70, 255, 120, 110, 100, 255,
  ]);
  const entry = new Uint8Array(header.length + pixels.length);
  entry.set(header, 0);
  entry.set(pixels, header.length);
  const raw = decodeIcoDib(entry);
  assert.equal(raw.width, 2);
  assert.equal(raw.height, 2);
  // Top-left pixel (image y=0,x=0) should be RGBA 70,80,90,255.
  assert.deepEqual([...raw.data.slice(0, 4)], [70, 80, 90, 255]);
});
