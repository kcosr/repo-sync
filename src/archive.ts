import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw, inflateRawSync } from "node:zlib";
import type { ArchiveLimits } from "./types.js";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;
const MAX_LINK_TARGET_BYTES = 4096;
const MAX_LINK_HOPS = 40;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_MASKED_HEADERS = 0x2000;
const HOST_MSDOS = 0;
const HOST_UNIX = 3;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export class ArchiveError extends Error {}

export type ArchiveEntryType = "file" | "directory" | "symlink";

export interface ArchiveEntry {
  /** Normalized relative path, starting with the archive's single top-level directory. */
  path: string;
  type: ArchiveEntryType;
  executable: boolean;
  size: number;
  compressedSize: number;
  method: number;
  crc32: number;
  localOffset: number;
  dataOffset: number;
  linkTarget?: string;
}

interface CentralDirectoryLocation {
  offset: number;
  size: number;
  entries: number;
  end: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset);
    if (count === 0) {
      throw new ArchiveError("Archive is truncated");
    }
    offset += count;
  }
  return buffer;
}

function toSafeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError(`Archive ${field} is too large`);
  }
  return Number(value);
}

function locateCentralDirectory(fd: number, fileSize: number): CentralDirectoryLocation {
  if (fileSize < EOCD_SIZE) {
    throw new ArchiveError("File is not a ZIP archive");
  }
  const tailLength = Math.min(fileSize, EOCD_SIZE + 0xffff);
  const tailStart = fileSize - tailLength;
  const tail = readAt(fd, tailStart, tailLength);

  let eocd = -1;
  for (let i = tailLength - EOCD_SIZE; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === EOCD_SIGNATURE &&
      i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tailLength
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ArchiveError("File is not a ZIP archive (end of central directory not found)");
  }

  const eocdOffset = tailStart + eocd;
  let disk = tail.readUInt16LE(eocd + 4);
  let directoryDisk = tail.readUInt16LE(eocd + 6);
  let diskEntries = tail.readUInt16LE(eocd + 8);
  let entries = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  let end = eocdOffset;

  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  const locator =
    locatorOffset >= 0 ? readAt(fd, locatorOffset, ZIP64_LOCATOR_SIZE) : Buffer.alloc(0);
  if (locator.length > 0 && locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) > 1) {
      throw new ArchiveError("Multi-disk ZIP archives are not supported");
    }
    const recordOffset = toSafeNumber(locator.readBigUInt64LE(8), "ZIP64 record offset");
    if (recordOffset + 56 > locatorOffset) {
      throw new ArchiveError("Archive has an invalid ZIP64 end of central directory");
    }
    const record = readAt(fd, recordOffset, 56);
    const recordSize = toSafeNumber(record.readBigUInt64LE(4), "ZIP64 record size");
    if (
      record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE ||
      recordOffset + 12 + recordSize !== locatorOffset
    ) {
      throw new ArchiveError("Archive has an invalid ZIP64 end of central directory");
    }
    disk = record.readUInt32LE(16);
    directoryDisk = record.readUInt32LE(20);
    diskEntries = toSafeNumber(record.readBigUInt64LE(24), "entry count");
    entries = toSafeNumber(record.readBigUInt64LE(32), "entry count");
    size = toSafeNumber(record.readBigUInt64LE(40), "central directory size");
    offset = toSafeNumber(record.readBigUInt64LE(48), "central directory offset");
    end = recordOffset;
  } else if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ArchiveError("Archive requires ZIP64 records that are missing");
  }

  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entries) {
    throw new ArchiveError("Multi-disk ZIP archives are not supported");
  }
  if (offset + size !== end) {
    throw new ArchiveError("Archive central directory is not where the archive says it is");
  }
  return { offset, size, entries, end };
}

function decodeName(raw: Buffer, unicodePath: Buffer | undefined): string {
  try {
    if (unicodePath && unicodePath.length > 5 && unicodePath[0] === 1) {
      if (unicodePath.readUInt32LE(1) === crc32(raw)) {
        return utf8.decode(unicodePath.subarray(5));
      }
    }
    return utf8.decode(raw);
  } catch {
    throw new ArchiveError(`Archive entry name is not valid UTF-8: ${raw.toString("latin1")}`);
  }
}

function normalizePath(name: string): string[] {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (trimmed.length === 0) {
    throw new ArchiveError("Archive contains an entry with an empty name");
  }
  if (trimmed.includes("\0")) {
    throw new ArchiveError(`Archive entry name contains a NUL byte: ${JSON.stringify(name)}`);
  }
  if (trimmed.includes("\\")) {
    throw new ArchiveError(`Archive entry uses backslash separators: ${name}`);
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new ArchiveError(`Archive entry has an absolute path: ${name}`);
  }
  if (Buffer.byteLength(trimmed) > MAX_PATH_BYTES) {
    throw new ArchiveError(`Archive entry path is too long: ${name.slice(0, 80)}...`);
  }
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ArchiveError(`Archive entry has an unsafe path: ${name}`);
    }
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) {
      throw new ArchiveError(`Archive entry path component is too long: ${name}`);
    }
  }
  return segments;
}

function entryType(name: string, madeBy: number, externalAttributes: number): ArchiveEntryType {
  const host = madeBy >> 8;
  const mode = host === HOST_UNIX ? externalAttributes >>> 16 : 0;
  const format = mode & S_IFMT;
  const named = name.endsWith("/");
  let type: ArchiveEntryType;
  if (format === 0) {
    const dosDirectory =
      host === HOST_MSDOS && (externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0;
    type = named || dosDirectory ? "directory" : "file";
  } else if (format === S_IFDIR) {
    type = "directory";
  } else if (format === S_IFREG) {
    type = "file";
  } else if (format === S_IFLNK) {
    type = "symlink";
  } else {
    throw new ArchiveError(
      `Archive entry is a special file (mode ${mode.toString(8).padStart(6, "0")}): ${name}`,
    );
  }
  if (named && type !== "directory") {
    throw new ArchiveError(`Archive entry has a directory name but a ${type} type: ${name}`);
  }
  return type;
}

function readExtraFields(extra: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let position = 0;
  while (position + 4 <= extra.length) {
    const id = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    const start = position + 4;
    if (start + length > extra.length) {
      throw new ArchiveError("Archive entry has a malformed extra field");
    }
    fields.set(id, extra.subarray(start, start + length));
    position = start + length;
  }
  return fields;
}

/**
 * Resolves an archived symlink the way the filesystem will once everything is extracted,
 * following other archived symlinks, and reports whether it stays inside the top-level directory.
 */
function resolveLink(
  linkPath: string,
  target: string,
  entries: Map<string, ArchiveEntry>,
): "inside" | "escapes" | "loop" {
  const current = linkPath.split("/").slice(0, -1);
  const pending = target.split("/").reverse();
  let hops = 0;
  if (target.startsWith("/")) {
    return "escapes";
  }
  while (pending.length > 0) {
    const segment = pending.pop() as string;
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (current.length <= 1) {
        return "escapes";
      }
      current.pop();
      continue;
    }
    current.push(segment);
    const entry = entries.get(current.join("/"));
    if (entry?.type === "symlink") {
      hops++;
      if (hops > MAX_LINK_HOPS) {
        return "loop";
      }
      const next = entry.linkTarget as string;
      if (next.startsWith("/")) {
        return "escapes";
      }
      current.pop();
      pending.push(...next.split("/").reverse());
    }
  }
  return "inside";
}

class EntryVerifier extends Transform {
  private written = 0;
  private checksum = 0;

  constructor(private readonly entry: ArchiveEntry) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.written += chunk.length;
    if (this.written > this.entry.size) {
      callback(
        new ArchiveError(`Archive entry expands beyond its declared size: ${this.entry.path}`),
      );
      return;
    }
    this.checksum = crc32(chunk, this.checksum);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.written !== this.entry.size) {
      callback(
        new ArchiveError(`Archive entry is shorter than its declared size: ${this.entry.path}`),
      );
    } else if (this.checksum !== this.entry.crc32) {
      callback(new ArchiveError(`Archive entry failed its CRC check: ${this.entry.path}`));
    } else {
      callback();
    }
  }
}

/**
 * A ZIP archive whose central directory has been fully validated: one top-level directory,
 * relative paths without traversal, only regular files, directories and contained symlinks,
 * non-overlapping entry data and bounded total size. Nothing is written until `extractTo`.
 */
export class ZipArchive {
  private constructor(
    readonly path: string,
    private readonly fd: number,
    readonly size: number,
    readonly mtimeMs: number,
    readonly root: string,
    readonly entries: ArchiveEntry[],
    readonly totalBytes: number,
  ) {}

  static open(path: string, limits: ArchiveLimits): ZipArchive {
    const fd = openSync(path, "r");
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) {
        throw new ArchiveError(`Archive is not a regular file: ${path}`);
      }
      const { root, entries, totalBytes } = readEntries(fd, stats.size, limits);
      return new ZipArchive(path, fd, stats.size, stats.mtimeMs, root, entries, totalBytes);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  /** Extracts into `destination`, which must be an existing empty directory. */
  async extractTo(destination: string): Promise<void> {
    if (readdirSync(destination).length > 0) {
      throw new ArchiveError(`Extraction directory is not empty: ${destination}`);
    }
    for (const entry of this.entries) {
      const target = join(destination, entry.path);
      if (entry.type === "directory") {
        mkdirSync(target, { recursive: true, mode: 0o755 });
      } else if (entry.type === "file") {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        await this.extractFile(entry, target);
      }
    }
    // Symlinks are created last so no extracted path is ever written through one.
    for (const entry of this.entries) {
      if (entry.type === "symlink") {
        const target = join(destination, entry.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        symlinkSync(entry.linkTarget as string, target);
      }
    }
    this.assertUnchanged();
  }

  private read(start: number, length: number) {
    return createReadStream(this.path, {
      fd: this.fd,
      start,
      end: start + length - 1,
      autoClose: false,
    });
  }

  private async extractFile(entry: ArchiveEntry, target: string): Promise<void> {
    const mode = entry.executable ? 0o755 : 0o644;
    if (entry.compressedSize === 0) {
      if (entry.size !== 0) {
        throw new ArchiveError(`Archive entry has no data: ${entry.path}`);
      }
      writeFileSync(target, "", { flag: "wx", mode });
      return;
    }
    const output = createWriteStream(target, { flags: "wx", mode });
    const input = this.read(entry.dataOffset, entry.compressedSize);
    try {
      if (entry.method === METHOD_DEFLATE) {
        await pipeline(input, createInflateRaw(), new EntryVerifier(entry), output);
      } else {
        await pipeline(input, new EntryVerifier(entry), output);
      }
    } catch (err) {
      if (err instanceof ArchiveError) {
        throw err;
      }
      throw new ArchiveError(`Failed to extract ${entry.path}: ${(err as Error).message}`);
    }
  }

  private assertUnchanged(): void {
    const stats = fstatSync(this.fd);
    if (stats.size !== this.size || stats.mtimeMs !== this.mtimeMs) {
      throw new ArchiveError("Archive changed while it was being imported");
    }
  }
}

/** Hashes a file through one descriptor, returning the size and mtime that were hashed. */
export async function sha256File(
  path: string,
): Promise<{ sha256: string; size: number; mtimeMs: number }> {
  const fd = openSync(path, "r");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new ArchiveError(`Archive is not a regular file: ${path}`);
    }
    const hash = createHash("sha256");
    if (stats.size > 0) {
      for await (const chunk of createReadStream(path, { fd, start: 0, autoClose: false })) {
        hash.update(chunk as Buffer);
      }
    }
    return { sha256: hash.digest("hex"), size: stats.size, mtimeMs: stats.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function readEntries(
  fd: number,
  fileSize: number,
  limits: ArchiveLimits,
): { root: string; entries: ArchiveEntry[]; totalBytes: number } {
  const directory = locateCentralDirectory(fd, fileSize);
  if (directory.entries === 0) {
    throw new ArchiveError("Archive is empty");
  }
  if (directory.entries > limits.maxEntries) {
    throw new ArchiveError(
      `Archive has ${directory.entries} entries, exceeding the limit of ${limits.maxEntries}`,
    );
  }
  if (directory.size > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ArchiveError("Archive central directory is too large");
  }

  const central = readAt(fd, directory.offset, directory.size);
  const entries: ArchiveEntry[] = [];
  const byPath = new Map<string, ArchiveEntry>();
  let totalBytes = 0;
  let position = 0;

  for (let i = 0; i < directory.entries; i++) {
    if (
      position + CENTRAL_HEADER_SIZE > central.length ||
      central.readUInt32LE(position) !== CENTRAL_SIGNATURE
    ) {
      throw new ArchiveError("Archive central directory is corrupt");
    }
    const madeBy = central.readUInt16LE(position + 4);
    const flags = central.readUInt16LE(position + 8);
    const method = central.readUInt16LE(position + 10);
    const checksum = central.readUInt32LE(position + 16);
    let compressedSize = central.readUInt32LE(position + 20);
    let size = central.readUInt32LE(position + 24);
    const nameLength = central.readUInt16LE(position + 28);
    const extraLength = central.readUInt16LE(position + 30);
    const commentLength = central.readUInt16LE(position + 32);
    let diskStart = central.readUInt16LE(position + 34);
    const externalAttributes = central.readUInt32LE(position + 38);
    let localOffset = central.readUInt32LE(position + 42);
    const nameStart = position + CENTRAL_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > central.length) {
      throw new ArchiveError("Archive central directory is corrupt");
    }
    position = next;

    const rawName = central.subarray(nameStart, extraStart);
    const extra = readExtraFields(central.subarray(extraStart, extraStart + extraLength));
    const zip64 = extra.get(0x0001);
    if (zip64) {
      let cursor = 0;
      const take = (): number => {
        if (cursor + 8 > zip64.length) {
          throw new ArchiveError("Archive entry has a malformed ZIP64 extra field");
        }
        const value = toSafeNumber(zip64.readBigUInt64LE(cursor), "entry size");
        cursor += 8;
        return value;
      };
      if (size === 0xffffffff) size = take();
      if (compressedSize === 0xffffffff) compressedSize = take();
      if (localOffset === 0xffffffff) localOffset = take();
      if (diskStart === 0xffff) {
        diskStart = cursor + 4 <= zip64.length ? zip64.readUInt32LE(cursor) : -1;
      }
    }

    const name = decodeName(rawName, extra.get(0x7075));
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) {
      throw new ArchiveError(`Archive entry is encrypted: ${name}`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ArchiveError(
        `Archive entry uses unsupported compression method ${method}: ${name}`,
      );
    }
    if (diskStart !== 0) {
      throw new ArchiveError("Multi-disk ZIP archives are not supported");
    }
    if (method === METHOD_STORED && compressedSize !== size) {
      throw new ArchiveError(`Archive entry has inconsistent sizes: ${name}`);
    }

    const segments = normalizePath(name);
    const type = entryType(name, madeBy, externalAttributes);
    if (type === "directory" && size !== 0) {
      throw new ArchiveError(`Archive directory entry has data: ${name}`);
    }
    const path = segments.join("/");
    if (byPath.has(path)) {
      throw new ArchiveError(`Archive contains duplicate entries for ${path}`);
    }

    const local = readAt(fd, localOffset, LOCAL_HEADER_SIZE);
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE || local.readUInt16LE(8) !== method) {
      throw new ArchiveError(`Archive local header does not match central directory: ${name}`);
    }
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    if (!readAt(fd, localOffset + LOCAL_HEADER_SIZE, localNameLength).equals(rawName)) {
      throw new ArchiveError(`Archive local header name does not match central directory: ${name}`);
    }
    const dataOffset = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > directory.offset) {
      throw new ArchiveError(`Archive entry data overlaps the central directory: ${name}`);
    }

    totalBytes += size;
    if (totalBytes > limits.maxBytes) {
      throw new ArchiveError(
        `Archive expands beyond the limit of ${limits.maxBytes} bytes (archiveLimits.maxBytes)`,
      );
    }

    const entry: ArchiveEntry = {
      path,
      type,
      executable: type === "file" && ((externalAttributes >>> 16) & 0o111) !== 0,
      size,
      compressedSize,
      method,
      crc32: checksum,
      localOffset,
      dataOffset,
    };
    if (type === "symlink") {
      entry.linkTarget = readLinkTarget(fd, entry);
    }
    entries.push(entry);
    byPath.set(path, entry);
  }
  if (position !== central.length) {
    throw new ArchiveError("Archive central directory has trailing data");
  }

  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    if (previous.dataOffset + previous.compressedSize > ordered[i].localOffset) {
      throw new ArchiveError(`Archive entries overlap: ${previous.path} and ${ordered[i].path}`);
    }
  }

  const root = entries[0].path.split("/")[0];
  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (segments[0] !== root) {
      throw new ArchiveError(
        `Archive must contain exactly one top-level directory (found '${root}' and '${segments[0]}')`,
      );
    }
    if (segments.length === 1 && entry.type !== "directory") {
      throw new ArchiveError(`Archive top-level entry must be a directory: ${entry.path}`);
    }
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = byPath.get(segments.slice(0, depth).join("/"));
      if (ancestor && ancestor.type !== "directory") {
        throw new ArchiveError(`Archive entry is nested beneath a ${ancestor.type}: ${entry.path}`);
      }
    }
  }
  for (const entry of entries) {
    if (entry.type !== "symlink") {
      continue;
    }
    const resolution = resolveLink(entry.path, entry.linkTarget as string, byPath);
    if (resolution !== "inside") {
      const problem = resolution === "loop" ? "forms a loop" : "escapes the archive directory";
      throw new ArchiveError(`Archive symlink ${problem}: ${entry.path} -> ${entry.linkTarget}`);
    }
  }

  return { root, entries, totalBytes };
}

function readLinkTarget(fd: number, entry: ArchiveEntry): string {
  if (
    entry.size === 0 ||
    entry.size > MAX_LINK_TARGET_BYTES ||
    entry.compressedSize > MAX_LINK_TARGET_BYTES * 2
  ) {
    throw new ArchiveError(`Archive symlink target has an invalid length: ${entry.path}`);
  }
  const raw = readAt(fd, entry.dataOffset, entry.compressedSize);
  let data: Buffer;
  try {
    data =
      entry.method === METHOD_DEFLATE
        ? inflateRawSync(raw, { maxOutputLength: MAX_LINK_TARGET_BYTES })
        : raw;
  } catch {
    throw new ArchiveError(`Archive symlink target could not be decompressed: ${entry.path}`);
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc32) {
    throw new ArchiveError(`Archive symlink target failed its CRC check: ${entry.path}`);
  }
  let target: string;
  try {
    target = utf8.decode(data);
  } catch {
    throw new ArchiveError(`Archive symlink target is not valid UTF-8: ${entry.path}`);
  }
  if (target.includes("\0")) {
    throw new ArchiveError(`Archive symlink target contains a NUL byte: ${entry.path}`);
  }
  return target;
}
