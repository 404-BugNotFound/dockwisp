/**
 * Pure helpers for the LAN file transfer feature: interface ranking, request
 * validation, safe file naming, HTTP range parsing and a streaming "store"
 * (uncompressed) ZIP writer. Nothing here imports electron so it can be tested
 * with plain node.
 */

import { timingSafeEqual } from "node:crypto";
import path from "node:path";

export interface NetworkInterfaceInfo {
  address: string;
  family: string | number;
  internal: boolean;
}

export interface LanAddress {
  name: string;
  address: string;
}

const VIRTUAL_ADAPTER =
  /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tap|tun|vpn|zerotier|tailscale|wireguard|clash|npcap|hamachi|radmin/i;
const PREFERRED_ADAPTER = /wi-?fi|wlan|无线|以太网|ethernet|本地连接/i;

function isIpv4(info: NetworkInterfaceInfo): boolean {
  return info.family === "IPv4" || info.family === 4;
}

/** True for RFC 1918 private ranges (the addresses a phone on the same Wi-Fi gets). */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Strip the IPv4-mapped IPv6 prefix node reports for remote addresses. */
export function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** Requests are accepted only from loopback or a private LAN address. */
export function isAllowedRemote(address: string | undefined): boolean {
  const ip = normalizeRemoteAddress(address);
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (isPrivateIpv4(ip)) return true;
  // Link-local, used when two devices connect without DHCP.
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip);
}

function adapterScore(name: string, address: string): number {
  let score = 0;
  if (VIRTUAL_ADAPTER.test(name)) score -= 40;
  else if (PREFERRED_ADAPTER.test(name)) score += 20;
  if (address.startsWith("192.168.")) score += 10;
  else if (address.startsWith("10.")) score += 6;
  else if (address.startsWith("172.")) score += 3;
  // Hyper-V / WSL default switches commonly sit on 172.x.x.1.
  if (address.endsWith(".1")) score -= 5;
  return score;
}

/**
 * Private IPv4 addresses ordered so the real Wi-Fi / Ethernet adapter comes
 * first and virtual adapters (VMware, Hyper-V, VPN clients) sink to the end.
 */
export function rankLanAddresses(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
): LanAddress[] {
  const found: Array<LanAddress & { score: number }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const info of entries ?? []) {
      if (info.internal || !isIpv4(info) || !isPrivateIpv4(info.address)) continue;
      found.push({ name, address: info.address, score: adapterScore(name, info.address) });
    }
  }
  found.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
  return found.map(({ name, address }) => ({ name, address }));
}

/** Constant-time token comparison. */
export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string" || !expected) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  return left.length === right.length && timingSafeEqual(left, right);
}

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Reduce an untrusted, client-supplied file name to a single safe Windows file
 * name: no directories, no reserved device names, no control or illegal
 * characters, bounded length.
 */
export function sanitizeFileName(raw: unknown): string {
  let name = typeof raw === "string" ? raw : "";
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  name = name.replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") name = "file";
  if (RESERVED_NAME.test(name)) name = `_${name}`;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

/** First "name (n).ext" that does not exist in `directory`. */
export function uniqueFilePath(
  directory: string,
  name: string,
  exists: (candidate: string) => boolean,
): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || "file";
  let candidate = path.join(directory, name);
  for (let index = 1; exists(candidate); index += 1) {
    candidate = path.join(directory, `${stem} (${index})${ext}`);
  }
  return candidate;
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(name: string, inline = false): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=` header. Returns null when absent or
 * unsupported (serve the whole file) and "invalid" when unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

// --- ZIP (store, data descriptors, UTF-8 names) ------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, chunk: Uint8Array): number {
  let value = ~crc >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
  }
  return ~value >>> 0;
}

/** Largest archive the 32-bit (non-ZIP64) format can describe. */
export const ZIP_MAX_BYTES = 0xffffffff;

export interface ZipEntryInput {
  name: string;
  size: number;
  mtime?: Date;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Byte size of the archive `ZipWriter` produces for these entries. */
export function zipArchiveSize(entries: ZipEntryInput[]): number {
  let total = 22;
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, "utf8");
    total += 30 + nameBytes + entry.size + 16 + 46 + nameBytes;
  }
  return total;
}

/** Give each entry a unique name inside the archive ("a.txt", "a (1).txt"). */
export function uniqueZipNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((original) => {
    const ext = path.extname(original);
    const stem = original.slice(0, original.length - ext.length);
    let candidate = original;
    for (let index = 1; used.has(candidate.toLowerCase()); index += 1) {
      candidate = `${stem} (${index})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/**
 * Builds an uncompressed ZIP piece by piece so files can be streamed straight
 * into an HTTP response. Usage: for each entry call `begin`, feed `data` for
 * every chunk, then `end`; finally `finish`. Each method returns the bytes to
 * write next.
 */
export class ZipWriter {
  private offset = 0;
  private records: CentralRecord[] = [];
  private current: CentralRecord | null = null;

  begin(entry: ZipEntryInput): Buffer {
    const name = Buffer.from(entry.name, "utf8");
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(0, 8); // store
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(name.length, 26);
    this.current = { name, crc: 0, size: 0, offset: this.offset, time, date };
    const out = Buffer.concat([header, name]);
    this.offset += out.length;
    return out;
  }

  data(chunk: Buffer): Buffer {
    if (!this.current) throw new Error("zip entry not started");
    this.current.crc = crc32Update(this.current.crc, chunk);
    this.current.size += chunk.length;
    this.offset += chunk.length;
    return chunk;
  }

  end(): Buffer {
    const record = this.current;
    if (!record) throw new Error("zip entry not started");
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(record.crc, 4);
    descriptor.writeUInt32LE(record.size, 8);
    descriptor.writeUInt32LE(record.size, 12);
    this.records.push(record);
    this.current = null;
    this.offset += descriptor.length;
    return descriptor;
  }

  finish(): Buffer {
    const parts: Buffer[] = [];
    const start = this.offset;
    for (const record of this.records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(record.time, 12);
      header.writeUInt16LE(record.date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.size, 20);
      header.writeUInt32LE(record.size, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt32LE(record.offset, 42);
      parts.push(header, record.name);
    }
    const central = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(start, 16);
    this.offset += central.length + end.length;
    return Buffer.concat([central, end]);
  }
}
