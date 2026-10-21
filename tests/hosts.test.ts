import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKER_BEGIN,
  MARKER_END,
  buildManagedBlockBody,
  extractManagedBlockBody,
  mergeManagedBlock,
  parseHosts,
  parseHostsLine,
  stripManagedBlock,
  validateHosts,
  wrapManagedBlock,
} from "../src/core/hosts";

test("parses mapping lines with hostnames and trailing comments", () => {
  const line = parseHostsLine("127.0.0.1   example.com  www.example.com # local", 1);
  assert.equal(line.kind, "mapping");
  assert.equal(line.disabled, false);
  assert.equal(line.ip, "127.0.0.1");
  assert.deepEqual(line.hostnames, ["example.com", "www.example.com"]);
  assert.equal(line.trailingComment, "local");
});

test("classifies blank, comment and disabled-mapping lines", () => {
  assert.equal(parseHostsLine("", 1).kind, "blank");
  assert.equal(parseHostsLine("   ", 1).kind, "blank");
  assert.equal(parseHostsLine("# just a note", 1).kind, "comment");

  const disabled = parseHostsLine("# 10.0.0.1 staging.local", 1);
  assert.equal(disabled.kind, "mapping");
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.ip, "10.0.0.1");
  assert.deepEqual(disabled.hostnames, ["staging.local"]);
});

test("accepts IPv6 mappings including compressed and loopback forms", () => {
  assert.equal(parseHostsLine("::1 localhost", 1).kind, "mapping");
  assert.equal(parseHostsLine("fe80::1%eth0 router.local", 1).kind, "mapping");
  assert.equal(
    parseHostsLine("2001:0db8:85a3:0000:0000:8a2e:0370:7334 host", 1).kind,
    "mapping",
  );
});

test("flags invalid lines with reasons", () => {
  const noHost = parseHostsLine("127.0.0.1", 1);
  assert.equal(noHost.kind, "invalid");
  assert.match(noHost.error ?? "", /主机名/);

  const badIp = parseHostsLine("999.1.1.1 example.com", 1);
  assert.equal(badIp.kind, "invalid");

  const leadingZero = parseHostsLine("01.2.3.4 example.com", 1);
  assert.equal(leadingZero.kind, "invalid");
});

test("validateHosts returns only the offending lines", () => {
  const content = ["127.0.0.1 ok.local", "nonsense here", "# comment", "", "bad"].join(
    "\n",
  );
  const issues = validateHosts(content);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((issue) => issue.lineNumber),
    [2, 5],
  );
});

test("parseHosts numbers lines and ignores a single trailing newline", () => {
  const parsed = parseHosts("a.local\n127.0.0.1 b.local\n");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].lineNumber, 1);
  assert.equal(parsed[1].lineNumber, 2);
});

test("buildManagedBlockBody labels enabled profiles and skips empty ones", () => {
  const body = buildManagedBlockBody([
    { name: "Dev", content: "127.0.0.1 dev.local\n" },
    { name: "Empty", content: "   \n\n" },
    { name: "Staging", content: "10.0.0.1 staging.local" },
  ]);
  assert.equal(
    body,
    "# [Dev]\n127.0.0.1 dev.local\n\n# [Staging]\n10.0.0.1 staging.local",
  );
});

test("wrapManagedBlock wraps body in markers and handles empty body", () => {
  assert.equal(
    wrapManagedBlock("127.0.0.1 x.local"),
    `${MARKER_BEGIN}\n127.0.0.1 x.local\n${MARKER_END}`,
  );
  assert.equal(wrapManagedBlock("  "), `${MARKER_BEGIN}${MARKER_END}`);
});

test("mergeManagedBlock appends a block when none exists and keeps user content", () => {
  const original = "# system defaults\n127.0.0.1 localhost\n";
  const merged = mergeManagedBlock(original, [
    { name: "Dev", content: "127.0.0.1 dev.local" },
  ]);
  assert.match(merged, /# system defaults/);
  assert.match(merged, /127\.0\.0\.1 localhost/);
  assert.match(merged, new RegExp(escapeForTest(MARKER_BEGIN)));
  assert.match(merged, /# \[Dev\]\n127\.0\.0\.1 dev\.local/);
  assert.match(merged, new RegExp(escapeForTest(MARKER_END)));
});

test("mergeManagedBlock replaces only the managed block, preserving outside edits", () => {
  const withBlock = [
    "# keep me on top",
    "127.0.0.1 localhost",
    "",
    MARKER_BEGIN,
    "# [Old]",
    "1.1.1.1 old.local",
    MARKER_END,
    "",
    "# keep me at the bottom",
  ].join("\n");

  const merged = mergeManagedBlock(withBlock, [
    { name: "New", content: "2.2.2.2 new.local" },
  ]);

  assert.match(merged, /# keep me on top/);
  assert.match(merged, /# keep me at the bottom/);
  assert.doesNotMatch(merged, /old\.local/);
  assert.match(merged, /# \[New\]\n2\.2\.2\.2 new\.local/);
});

test("mergeManagedBlock is idempotent", () => {
  const original = "127.0.0.1 localhost\n";
  const profiles = [
    { name: "Dev", content: "127.0.0.1 dev.local\n" },
    { name: "Staging", content: "10.0.0.1 staging.local" },
  ];
  const once = mergeManagedBlock(original, profiles);
  const twice = mergeManagedBlock(once, profiles);
  assert.equal(once, twice);
});

test("mergeManagedBlock with no enabled profiles leaves empty markers", () => {
  const merged = mergeManagedBlock("127.0.0.1 localhost\n", []);
  assert.match(merged, new RegExp(`${escapeForTest(MARKER_BEGIN)}${escapeForTest(MARKER_END)}`));
  const again = mergeManagedBlock(merged, []);
  assert.equal(merged, again);
});

test("stripManagedBlock returns only the public portion", () => {
  const content = [
    "# top",
    "127.0.0.1 localhost",
    "",
    MARKER_BEGIN,
    "1.1.1.1 managed.local",
    MARKER_END,
    "",
    "# bottom",
  ].join("\n");
  const stripped = stripManagedBlock(content);
  assert.match(stripped, /# top/);
  assert.match(stripped, /# bottom/);
  assert.doesNotMatch(stripped, /managed\.local/);
  assert.doesNotMatch(stripped, new RegExp(escapeForTest(MARKER_BEGIN)));
});

test("extractManagedBlockBody reads the inner body only", () => {
  const content = mergeManagedBlock("127.0.0.1 localhost\n", [
    { name: "Dev", content: "127.0.0.1 dev.local" },
  ]);
  const body = extractManagedBlockBody(content);
  assert.equal(body, "# [Dev]\n127.0.0.1 dev.local");
  assert.equal(extractManagedBlockBody("no markers here"), "");
});

function escapeForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
