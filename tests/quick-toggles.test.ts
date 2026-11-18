import assert from "node:assert/strict";
import test from "node:test";
import {
  buildElevatedScript,
  buildElevationLauncher,
  commandFor,
  encodePowerShell,
  findToggleDef,
  isToggleSupported,
  mouseParamsScript,
  opsFor,
  parseRegQuery,
  parseWindowsBuild,
  psQuote,
  QUICK_TOGGLE_DEFS,
  QUICK_TOGGLE_IDS,
  type RegSnapshot,
  stickyHotkeyScript,
  type ToggleOp,
} from "../src/main/quick-toggles";

const ADVANCED = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced";
const CDM = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager";

function def(id: string) {
  const found = findToggleDef(id);
  assert.ok(found, `missing definition for ${id}`);
  return found;
}

function regArgs(id: string, enabled: boolean): string[][] {
  return opsFor(def(id), enabled).map((op) => {
    const command = commandFor(op);
    return [command.file, ...command.args];
  });
}

function snapshotOf(entries: Record<string, string | null>): RegSnapshot {
  const snapshot: RegSnapshot = new Map();
  for (const [key, stdout] of Object.entries(entries)) {
    snapshot.set(key.toLowerCase(), stdout === null ? null : parseRegQuery(stdout));
  }
  return snapshot;
}

const ADVANCED_OUTPUT = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
  "    HideFileExt    REG_DWORD    0x0",
  "    Hidden    REG_DWORD    0x1",
  "    Start_IrisRecommendations    REG_DWORD    0x0",
  "    Some Name With Spaces    REG_SZ    hello world",
  "    EmptyString    REG_SZ    ",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\\Sub",
  "    Inner    REG_DWORD    0x5",
  "",
].join("\r\n");

test("parseRegQuery reads DWORD and REG_SZ values of the first key only", () => {
  const values = parseRegQuery(ADVANCED_OUTPUT);
  assert.deepEqual(values.get("hidefileext"), { type: "REG_DWORD", data: "0x0" });
  assert.deepEqual(values.get("hidden"), { type: "REG_DWORD", data: "0x1" });
  assert.deepEqual(values.get("some name with spaces"), { type: "REG_SZ", data: "hello world" });
  assert.deepEqual(values.get("emptystring"), { type: "REG_SZ", data: "" });
  assert.equal(values.has("inner"), false);
  assert.equal(values.has("launchto"), false);
});

test("parseRegQuery handles default values and sub-key-only output", () => {
  const values = parseRegQuery(
    "\r\nHKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32\r\n    (Default)    REG_SZ    \r\n",
  );
  assert.deepEqual(values.get("(default)"), { type: "REG_SZ", data: "" });
  assert.equal(parseRegQuery("\r\nHKEY_CURRENT_USER\\X\r\n\r\nHKEY_CURRENT_USER\\X\\Y\r\n").size, 0);
  assert.equal(parseRegQuery("").size, 0);
});

test("toggle readers interpret snapshots, including missing values and keys", () => {
  const snapshot = snapshotOf({
    [ADVANCED]: ADVANCED_OUTPUT,
    "HKCU\\Control Panel\\Mouse": "\r\nHKEY_CURRENT_USER\\Control Panel\\Mouse\r\n    MouseSpeed    REG_SZ    0\r\n",
    "HKCU\\Control Panel\\Accessibility\\StickyKeys":
      "\r\nHKEY_CURRENT_USER\\Control Panel\\Accessibility\\StickyKeys\r\n    Flags    REG_SZ    506\r\n",
    "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32": null,
  });
  assert.equal(def("show-file-extensions").read(snapshot), true);
  assert.equal(def("show-hidden-files").read(snapshot), true);
  assert.equal(def("start-no-recommendations").read(snapshot), true);
  assert.equal(def("explorer-open-this-pc").read(snapshot), false);
  assert.equal(def("clock-seconds").read(snapshot), false);
  assert.equal(def("disable-mouse-acceleration").read(snapshot), true);
  assert.equal(def("disable-sticky-keys-shortcut").read(snapshot), true);
  assert.equal(def("classic-context-menu").read(snapshot), false);
  assert.equal(def("block-auto-update").read(snapshot), false);

  const sticky510 = snapshotOf({
    "HKCU\\Control Panel\\Accessibility\\StickyKeys":
      "\r\nHKEY_CURRENT_USER\\Control Panel\\Accessibility\\StickyKeys\r\n    Flags    REG_SZ    510\r\n",
    "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32":
      "\r\nHKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32\r\n    (Default)    REG_SZ    \r\n",
  });
  assert.equal(def("disable-sticky-keys-shortcut").read(sticky510), false);
  assert.equal(def("classic-context-menu").read(sticky510), true);
});

test("every toggle id has exactly one definition", () => {
  assert.equal(QUICK_TOGGLE_IDS.length, 18);
  assert.deepEqual(
    QUICK_TOGGLE_DEFS.map((d) => d.id).sort(),
    [...QUICK_TOGGLE_IDS].sort(),
  );
  for (const d of QUICK_TOGGLE_DEFS) {
    assert.ok(d.on.length > 0 && d.off.length > 0, d.id);
    assert.ok(d.keys.length > 0, d.id);
  }
  assert.equal(findToggleDef("nope"), undefined);
  assert.equal(findToggleDef(42), undefined);
});

test("admin flags, after-actions and Win11 gating match the table", () => {
  const admin = QUICK_TOGGLE_DEFS.filter((d) => d.admin).map((d) => d.id).sort();
  assert.deepEqual(admin, [
    "block-auto-update",
    "disable-fast-startup",
    "disable-hibernation",
    "disable-web-search",
    "enable-long-paths",
    "exclude-driver-updates",
  ]);
  const restart = QUICK_TOGGLE_DEFS.filter((d) => d.after === "restartExplorer").map((d) => d.id).sort();
  assert.deepEqual(restart, ["classic-context-menu", "clock-seconds", "disable-web-search", "start-no-recommendations"]);
  assert.equal(def("show-file-extensions").after, "broadcast");
  assert.equal(def("show-hidden-files").after, "broadcast");
  const win11 = QUICK_TOGGLE_DEFS.filter((d) => !isToggleSupported(d, 19045)).map((d) => d.id).sort();
  assert.deepEqual(win11, ["classic-context-menu", "clock-seconds", "start-no-recommendations"]);
  assert.ok(QUICK_TOGGLE_DEFS.every((d) => isToggleSupported(d, 22631)));
  assert.equal(parseWindowsBuild("10.0.22631"), 22631);
  assert.equal(parseWindowsBuild("weird"), 0);
});

test("explorer toggles generate the expected reg commands", () => {
  const clsid = "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}";
  assert.deepEqual(regArgs("classic-context-menu", true), [
    ["reg.exe", "add", `${clsid}\\InprocServer32`, "/ve", "/t", "REG_SZ", "/d", "", "/f"],
  ]);
  assert.deepEqual(regArgs("classic-context-menu", false), [["reg.exe", "delete", clsid, "/f"]]);
  assert.deepEqual(regArgs("show-file-extensions", true), [
    ["reg.exe", "add", ADVANCED, "/v", "HideFileExt", "/t", "REG_DWORD", "/d", "0", "/f"],
  ]);
  assert.deepEqual(regArgs("show-file-extensions", false), [
    ["reg.exe", "add", ADVANCED, "/v", "HideFileExt", "/t", "REG_DWORD", "/d", "1", "/f"],
  ]);
  assert.deepEqual(regArgs("show-hidden-files", false), [
    ["reg.exe", "add", ADVANCED, "/v", "Hidden", "/t", "REG_DWORD", "/d", "2", "/f"],
  ]);
  assert.deepEqual(regArgs("explorer-open-this-pc", false), [["reg.exe", "delete", ADVANCED, "/v", "LaunchTo", "/f"]]);
  const explorer = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
  assert.deepEqual(regArgs("quick-access-no-recent", false), [
    ["reg.exe", "delete", explorer, "/v", "ShowRecent", "/f"],
    ["reg.exe", "delete", explorer, "/v", "ShowFrequent", "/f"],
  ]);
});

test("start menu, tips and game bar toggles generate the expected commands", () => {
  assert.deepEqual(regArgs("disable-web-search", true), [
    ["reg.exe", "add", "HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer", "/v", "DisableSearchBoxSuggestions", "/t", "REG_DWORD", "/d", "1", "/f"],
    ["reg.exe", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search", "/v", "BingSearchEnabled", "/t", "REG_DWORD", "/d", "0", "/f"],
  ]);
  // BingSearchEnabled is best effort: its failure must not fail the toggle.
  assert.equal(commandFor(opsFor(def("disable-web-search"), true)[1]).ignoreFailure, true);
  assert.equal(commandFor(opsFor(def("disable-web-search"), true)[0]).ignoreFailure, false);
  assert.deepEqual(regArgs("start-no-recommendations", false), [
    ["reg.exe", "delete", ADVANCED, "/v", "Start_IrisRecommendations", "/f"],
    ["reg.exe", "delete", ADVANCED, "/v", "Start_AccountNotifications", "/f"],
    ["reg.exe", "add", CDM, "/v", "SubscribedContent-338388Enabled", "/t", "REG_DWORD", "/d", "1", "/f"],
  ]);
  const tipsOn = regArgs("disable-tips", true);
  assert.equal(tipsOn.length, 9);
  assert.ok(tipsOn.every((args) => args.at(-2) === "0"));
  assert.ok(regArgs("disable-tips", false).every((args) => args.at(-2) === "1"));
  assert.deepEqual(tipsOn.at(-1), [
    "reg.exe", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\UserProfileEngagement",
    "/v", "ScoobeSystemSettingEnabled", "/t", "REG_DWORD", "/d", "0", "/f",
  ]);
  assert.deepEqual(regArgs("disable-game-bar", true).map((args) => [args[4], args[8]]), [
    ["GameDVR_Enabled", "0"],
    ["AppCaptureEnabled", "0"],
    ["UseNexusForGameBarEnabled", "0"],
  ]);
});

test("SPI toggles use PowerShell with the right flags and values", () => {
  const stickyOn = opsFor(def("disable-sticky-keys-shortcut"), true);
  assert.deepEqual(stickyOn, [{ kind: "stickyHotkey", active: false }]);
  assert.match(stickyHotkeyScript(false), /-band 4294967291/);
  assert.match(stickyHotkeyScript(true), /-bor 4\)/);
  assert.match(stickyHotkeyScript(true), /SystemParametersInfo\(0x3A, 8, \[ref\]\$s, 0\)/);
  assert.match(stickyHotkeyScript(true), /SystemParametersInfo\(0x3B, 8, \[ref\]\$s, 3\)/);
  assert.equal(commandFor(stickyOn[0]).file, "powershell.exe");

  assert.deepEqual(opsFor(def("disable-mouse-acceleration"), true), [{ kind: "mouseParams", values: [0, 0, 0] }]);
  assert.deepEqual(opsFor(def("disable-mouse-acceleration"), false), [{ kind: "mouseParams", values: [6, 10, 1] }]);
  assert.match(mouseParamsScript([6, 10, 1]), /SystemParametersInfo\(0x4, 0, \[int\[\]\]@\(6,10,1\), 3\)/);
  assert.throws(() => mouseParamsScript([1, 2, -1]));
});

test("admin toggles generate the expected commands", () => {
  assert.deepEqual(regArgs("disable-fast-startup", true), [
    ["reg.exe", "add", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power", "/v", "HiberbootEnabled", "/t", "REG_DWORD", "/d", "0", "/f"],
  ]);
  assert.deepEqual(regArgs("disable-hibernation", true), [["powercfg.exe", "/h", "off"]]);
  assert.deepEqual(regArgs("disable-hibernation", false), [["powercfg.exe", "/h", "on"]]);
  assert.deepEqual(regArgs("enable-long-paths", false), [
    ["reg.exe", "add", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled", "/t", "REG_DWORD", "/d", "0", "/f"],
  ]);
  assert.deepEqual(regArgs("exclude-driver-updates", false), [
    ["reg.exe", "delete", "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate", "/v", "ExcludeWUDriversInQualityUpdate", "/f"],
  ]);
  assert.deepEqual(regArgs("block-auto-update", true), [
    ["reg.exe", "add", "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU", "/v", "NoAutoUpdate", "/t", "REG_DWORD", "/d", "1", "/f"],
  ]);
});

test("elevated scripts quote every argument and run all commands in one prompt", () => {
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote("a\u2019b"), "'a\u2019\u2019b'");

  const ops: ToggleOp[] = [
    { kind: "regAdd", key: "HKLM\\SYSTEM\\Session Manager\\O'Brien", name: "Va'l", type: "REG_DWORD", data: "1" },
    { kind: "regDelete", key: "HKLM\\SOFTWARE\\X", name: "Y" },
  ];
  const inner = buildElevatedScript(ops);
  assert.match(inner, /& 'reg\.exe' 'add' 'HKLM\\SYSTEM\\Session Manager\\O''Brien' '\/v' 'Va''l' '\/t' 'REG_DWORD' '\/d' '1' '\/f' \| Out-Null; if \(\$LASTEXITCODE -ne 0\) \{ \$failed = 1 \}/);
  assert.match(inner, /& 'reg\.exe' 'delete' 'HKLM\\SOFTWARE\\X' '\/v' 'Y' '\/f' \| Out-Null\r\n/);
  assert.match(inner, /exit \$failed$/);
  assert.throws(() =>
    buildElevatedScript([{ kind: "regAdd", key: "HKLM\\X", name: null, type: "REG_SZ", data: "" }]),
  );

  const launcher = buildElevationLauncher(inner);
  assert.equal((launcher.match(/Start-Process/g) ?? []).length, 1);
  assert.match(launcher, /-Verb RunAs -WindowStyle Hidden -Wait -PassThru/);
  assert.match(launcher, /catch \{ exit 1223 \}/);
  const encoded = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(launcher);
  assert.ok(encoded);
  assert.equal(encoded[1], encodePowerShell(inner));
  assert.equal(Buffer.from(encoded[1], "base64").toString("utf16le"), inner);

  for (const d of QUICK_TOGGLE_DEFS.filter((x) => x.admin)) {
    for (const enabled of [true, false]) assert.doesNotThrow(() => buildElevatedScript(opsFor(d, enabled)), d.id);
  }
});
