import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  contentDisposition,
  crc32Update,
  isAllowedRemote,
  parseRange,
  rankLanAddresses,
  sanitizeFileName,
  tokenMatches,
  uniqueFilePath,
  uniqueZipNames,
  zipArchiveSize,
  ZipWriter,
} from "../src/core/lan-transfer";
import { matchBuiltinFeatures } from "../src/core/builtin-features";
import { LanTransferServer, ReceivedFile } from "../src/main/lan-transfer-server";

test("ranks real adapters ahead of virtual ones", () => {
  const ranked = rankLanAddresses({
    "vEthernet (WSL)": [{ address: "172.20.16.1", family: "IPv4", internal: false }],
    "VMware Network Adapter VMnet8": [{ address: "192.168.80.1", family: "IPv4", internal: false }],
    "WLAN": [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.1.23", family: "IPv4", internal: false },
    ],
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "Public": [{ address: "8.8.8.8", family: 4, internal: false }],
  });
  assert.deepEqual(
    ranked.map((item) => item.address),
    ["192.168.1.23", "192.168.80.1", "172.20.16.1"],
  );
});

test("accepts only loopback and private peers", () => {
  assert.equal(isAllowedRemote("::ffff:192.168.1.5"), true);
  assert.equal(isAllowedRemote("10.0.0.2"), true);
  assert.equal(isAllowedRemote("127.0.0.1"), true);
  assert.equal(isAllowedRemote("172.32.0.1"), false);
  assert.equal(isAllowedRemote("8.8.8.8"), false);
  assert.equal(isAllowedRemote(undefined), false);
});

test("compares tokens strictly", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "ab"), false);
  assert.equal(tokenMatches("abc", ["abc"]), false);
});

test("sanitizes untrusted file names", () => {
  assert.equal(sanitizeFileName("../../evil.exe"), "evil.exe");
  assert.equal(sanitizeFileName("..\\..\\Windows\\a.txt"), "a.txt");
  assert.equal(sanitizeFileName("a<b>:c?.txt"), "a_b__c_.txt");
  assert.equal(sanitizeFileName("CON.txt"), "_CON.txt");
  assert.equal(sanitizeFileName("name. . "), "name");
  assert.equal(sanitizeFileName(".."), "file");
  assert.equal(sanitizeFileName(undefined), "file");
  assert.equal(sanitizeFileName("照片 1.jpg"), "照片 1.jpg");
  assert.ok(sanitizeFileName(`${"x".repeat(300)}.jpeg`).endsWith(".jpeg"));
});

test("picks a free file name", () => {
  const taken = new Set([path.join("d", "a.txt"), path.join("d", "a (1).txt")]);
  assert.equal(uniqueFilePath("d", "a.txt", (c) => taken.has(c)), path.join("d", "a (2).txt"));
  assert.deepEqual(uniqueZipNames(["a.txt", "A.txt", "b"]), ["a.txt", "A (1).txt", "b"]);
});

test("parses byte ranges", () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.deepEqual(parseRange("bytes=0-", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=2-4", 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=5-100", 10), { start: 5, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "invalid");
  assert.equal(parseRange("bytes=0-1,3-4", 10), null);
});

test("encodes non-ASCII download names", () => {
  const header = contentDisposition("报告 1.pdf");
  assert.match(header, /^attachment; filename="__ 1\.pdf"; filename\*=UTF-8''%E6%8A%A5%E5%91%8A%201\.pdf$/);
});

test("computes standard crc32", () => {
  assert.equal(crc32Update(0, Buffer.from("123456789")), 0xcbf43926);
});

test("writes a valid store zip", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "子目录名.txt", data: Buffer.from("世界".repeat(100)) },
    { name: "empty.bin", data: Buffer.alloc(0) },
  ];
  const zip = new ZipWriter();
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(zip.begin({ name: entry.name, size: entry.data.length }));
    if (entry.data.length) parts.push(zip.data(entry.data));
    parts.push(zip.end());
  }
  parts.push(zip.finish());
  const archive = Buffer.concat(parts);
  assert.equal(
    archive.length,
    zipArchiveSize(entries.map((entry) => ({ name: entry.name, size: entry.data.length }))),
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "dockwisp-zip-"));
  const zipPath = path.join(dir, "out.zip");
  writeFileSync(zipPath, archive);
  if (process.platform !== "win32") return;
  const out = path.join(dir, "out");
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}'`,
  ]);
  for (const entry of entries) {
    assert.deepEqual(readFileSync(path.join(out, entry.name)), entry.data);
  }
});

test("matches the lan transfer feature by keyword", () => {
  assert.equal(matchBuiltinFeatures("互传")[0]?.id, "builtin:lan-transfer");
  assert.equal(matchBuiltinFeatures("传文件")[0]?.id, "builtin:lan-transfer");
});

function request(
  port: number,
  pathname: string,
  options: { method?: string; body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

test("serves, zips and receives files over http", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dockwisp-lan-"));
  const inbox = path.join(root, "inbox");
  const source = path.join(root, "源文件.txt");
  writeFileSync(source, "0123456789");
  const received: ReceivedFile[] = [];
  const server = new LanTransferServer({
    host: "127.0.0.1",
    receiveDir: () => inbox,
    mobileHtml: async () => "<html>phone</html>",
    onReceived: (file) => received.push(file),
    maxUploadBytes: 1024,
  });
  const port = await server.start();
  server.setFiles([{ id: "f1", path: source, name: "源文件.txt", size: 10, mtime: Date.now() }]);
  const t = server.token;
  try {
    assert.equal((await request(port, "/api/files")).status, 403);
    assert.equal((await request(port, "/api/files?t=wrong")).status, 403);

    const page = await request(port, `/?t=${t}`);
    assert.equal(page.body.toString(), "<html>phone</html>");

    const list = JSON.parse((await request(port, `/api/files?t=${t}`)).body.toString());
    assert.deepEqual(list.files.map((file: { id: string }) => file.id), ["f1"]);
    assert.equal(list.files[0].path, undefined);

    const whole = await request(port, `/api/file/f1?t=${t}`);
    assert.equal(whole.body.toString(), "0123456789");
    const part = await request(port, `/api/file/f1?t=${t}`, { headers: { range: "bytes=3-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.body.toString(), "345");
    assert.equal((await request(port, `/api/file/missing?t=${t}`)).status, 404);

    const zip = await request(port, `/api/zip?t=${t}`);
    assert.equal(zip.status, 200);
    assert.equal(Number(zip.headers["content-length"]), zip.body.length);
    assert.equal(zip.body.readUInt32LE(0), 0x04034b50);

    const upload = await request(port, `/api/upload?t=${t}&name=${encodeURIComponent("..\\..\\图.jpg")}`, {
      method: "POST",
      body: Buffer.from("image-bytes"),
    });
    assert.equal(upload.status, 200);
    const again = await request(port, `/api/upload?t=${t}&name=${encodeURIComponent("图.jpg")}`, {
      method: "POST",
      body: Buffer.from("second"),
    });
    assert.equal(JSON.parse(again.body.toString()).name, "图 (1).jpg");
    assert.equal(readFileSync(path.join(inbox, "图.jpg"), "utf8"), "image-bytes");
    assert.equal(received.length, 2);
    assert.ok(received.every((file) => path.dirname(file.path) === inbox));

    const tooBig = await request(port, `/api/upload?t=${t}&name=big.bin`, {
      method: "POST",
      body: Buffer.alloc(2048),
    });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(readdirSync(inbox).sort(), ["图 (1).jpg", "图.jpg"]);
    assert.equal(existsSync(path.join(root, "图.jpg")), false);
  } finally {
    await server.stop();
  }
});
