/**
 * Pure hosts-file logic for the built-in hosts switcher. No Electron or
 * filesystem imports so it stays unit-testable: line parsing, validation,
 * building the managed block, and replacing it idempotently inside an existing
 * system hosts file while preserving everything the user keeps outside the
 * markers.
 */

/** Opening marker of the Dockwisp-managed region inside the system hosts. */
export const MARKER_BEGIN = "# --- Dockwisp BEGIN ---";
/** Closing marker of the Dockwisp-managed region inside the system hosts. */
export const MARKER_END = "# --- Dockwisp END ---";

/** A single parsed hosts line, classified for highlighting and validation. */
export type HostsLineKind = "mapping" | "comment" | "blank" | "invalid";

export interface ParsedHostsLine {
  /** 1-based line number within the parsed text. */
  lineNumber: number;
  /** The original, untouched line text (without the line break). */
  raw: string;
  kind: HostsLineKind;
  /** A mapping line that is commented out (e.g. "# 127.0.0.1 foo"). */
  disabled?: boolean;
  ip?: string;
  hostnames?: string[];
  /** Any trailing "# ..." comment on a mapping line. */
  trailingComment?: string;
  /** Human-readable reason when kind === "invalid". */
  error?: string;
}

export interface HostsValidationIssue {
  lineNumber: number;
  raw: string;
  message: string;
}

/** A profile as far as the merge logic is concerned. */
export interface HostsProfileInput {
  name: string;
  content: string;
}

function isValidIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    // Reject leading zeros like "01" while allowing a plain "0".
    if (part.length > 1 && part[0] === "0") return false;
    return n >= 0 && n <= 255;
  });
}

function isValidIPv6(value: string): boolean {
  // Accept an optional zone id ("fe80::1%eth0") then validate the address part.
  const address = value.split("%")[0];
  if (!address.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(address)) return false;
  // At most one "::" compression.
  const doubleColons = address.match(/::/g);
  if (doubleColons && doubleColons.length > 1) return false;

  const hasCompression = address.includes("::");
  // Split on "::" to validate each side's groups.
  const [head, tail = ""] = hasCompression ? address.split("::") : [address, ""];
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");

  const groupOk = (group: string, allowEmbeddedV4: boolean): boolean => {
    if (group.includes(".")) {
      return allowEmbeddedV4 && isValidIPv4(group);
    }
    return /^[0-9a-fA-F]{1,4}$/.test(group);
  };

  const all = [...headGroups, ...tailGroups];
  for (let i = 0; i < all.length; i += 1) {
    const isLast = i === all.length - 1;
    if (!groupOk(all[i], isLast)) return false;
  }

  // An embedded IPv4 tail counts as two groups.
  const embeddedV4 = all.length > 0 && all[all.length - 1].includes(".");
  const groupCount = all.length + (embeddedV4 ? 1 : 0);

  if (hasCompression) return groupCount <= 7;
  return groupCount === 8;
}

function isValidIp(value: string): boolean {
  return isValidIPv4(value) || isValidIPv6(value);
}

/** Lenient hostname check: labels of letters, digits, hyphen and underscore. */
function isValidHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  if (value === "localhost") return true;
  const labels = value.split(".");
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[A-Za-z0-9_-]+$/.test(label);
  });
}

/** Parse a single hosts line (no trailing newline) into a classified record. */
export function parseHostsLine(raw: string, lineNumber: number): ParsedHostsLine {
  const line: ParsedHostsLine = { lineNumber, raw, kind: "blank" };
  const trimmed = raw.trim();

  if (trimmed === "") return line;

  // A comment that is not a disabled mapping (e.g. "# just a note").
  if (trimmed.startsWith("#")) {
    const body = trimmed.replace(/^#+\s*/, "");
    const mapping = tryParseMapping(body);
    if (mapping) {
      return {
        lineNumber,
        raw,
        kind: "mapping",
        disabled: true,
        ip: mapping.ip,
        hostnames: mapping.hostnames,
        trailingComment: mapping.trailingComment,
      };
    }
    return { lineNumber, raw, kind: "comment" };
  }

  const mapping = tryParseMapping(trimmed);
  if (mapping) {
    return {
      lineNumber,
      raw,
      kind: "mapping",
      disabled: false,
      ip: mapping.ip,
      hostnames: mapping.hostnames,
      trailingComment: mapping.trailingComment,
    };
  }

  // Non-empty, non-comment, but not a valid mapping.
  const firstToken = trimmed.split(/\s+/)[0];
  const error = isValidIp(firstToken)
    ? "缺少主机名"
    : "无法识别的 IP 地址";
  return { lineNumber, raw, kind: "invalid", error };
}

interface MappingParts {
  ip: string;
  hostnames: string[];
  trailingComment?: string;
}

/** Try to read "IP host [host...] [# comment]" from already-trimmed text. */
function tryParseMapping(text: string): MappingParts | null {
  if (!text) return null;
  const hashIndex = text.indexOf("#");
  const mappingPart = (hashIndex >= 0 ? text.slice(0, hashIndex) : text).trim();
  const trailingComment =
    hashIndex >= 0 ? text.slice(hashIndex + 1).trim() || undefined : undefined;
  if (!mappingPart) return null;

  const tokens = mappingPart.split(/\s+/);
  if (tokens.length < 2) return null;
  const [ip, ...hostnames] = tokens;
  if (!isValidIp(ip)) return null;
  if (!hostnames.every(isValidHostname)) return null;
  return { ip, hostnames, trailingComment };
}

/** Parse a whole hosts document into classified lines. */
export function parseHosts(content: string): ParsedHostsLine[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline produces an empty final element; drop it so line counts
  // match what a user sees in the editor.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((raw, index) => parseHostsLine(raw, index + 1));
}

/** Collect only the lines that fail validation, with friendly messages. */
export function validateHosts(content: string): HostsValidationIssue[] {
  return parseHosts(content)
    .filter((line) => line.kind === "invalid")
    .map((line) => ({
      lineNumber: line.lineNumber,
      raw: line.raw,
      message: line.error ?? "无效的 hosts 行",
    }));
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Build the body that goes between the markers: each enabled profile gets a
 * "# [name]" header followed by its content. Blank-only profiles are skipped.
 */
export function buildManagedBlockBody(profiles: HostsProfileInput[]): string {
  const sections: string[] = [];
  for (const profile of profiles) {
    const body = normalizeNewlines(profile.content).replace(/\s+$/, "");
    if (body.trim() === "") continue;
    const name = profile.name.trim() || "未命名方案";
    sections.push(`# [${name}]\n${body}`);
  }
  return sections.join("\n\n");
}

/** Wrap a body in the Dockwisp markers. */
export function wrapManagedBlock(body: string): string {
  const inner = body.trim() === "" ? "" : `\n${body.replace(/\s+$/, "")}\n`;
  return `${MARKER_BEGIN}${inner}${MARKER_END}`;
}

const MARKER_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the managed block inside `currentContent` with a freshly built one,
 * leaving everything outside the markers untouched. When no block exists yet it
 * is appended after the user's content. Idempotent: merging the same profiles
 * again yields byte-identical output.
 */
export function mergeManagedBlock(
  currentContent: string,
  profiles: HostsProfileInput[],
): string {
  const normalized = normalizeNewlines(currentContent);
  const block = wrapManagedBlock(buildManagedBlockBody(profiles));

  if (MARKER_BLOCK_PATTERN.test(normalized)) {
    return normalized.replace(MARKER_BLOCK_PATTERN, block);
  }

  const base = normalized.replace(/\s+$/, "");
  if (base === "") return `${block}\n`;
  return `${base}\n\n${block}\n`;
}

/**
 * Remove the managed block from a hosts document, returning the "public"
 * portion the user maintains by hand (outside the markers).
 */
export function stripManagedBlock(content: string): string {
  const normalized = normalizeNewlines(content);
  if (!MARKER_BLOCK_PATTERN.test(normalized)) return normalized;
  return normalized
    .replace(MARKER_BLOCK_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")
    .concat("\n");
}

/** Extract the raw body currently inside the markers, or "" when absent. */
export function extractManagedBlockBody(content: string): string {
  const normalized = normalizeNewlines(content);
  const match = MARKER_BLOCK_PATTERN.exec(normalized);
  if (!match) return "";
  return match[0]
    .replace(new RegExp(`^${escapeRegExp(MARKER_BEGIN)}\\n?`), "")
    .replace(new RegExp(`\\n?${escapeRegExp(MARKER_END)}$`), "");
}
