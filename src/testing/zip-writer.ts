import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/** One ZIP entry; the overrides let tests build archives a well-behaved writer never would. */
export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  /** Unix mode including file-type bits. Defaults to a regular file or directory. */
  mode?: number;
  method?: 0 | 8;
  madeBy?: number;
  flags?: number;
  /** Declared uncompressed size, if different from the real data. */
  size?: number;
  /** Declared CRC-32, if different from the real data. */
  crc?: number;
  /** Name written to the local header, if different from the central directory. */
  localName?: string;
  /** Point this central directory record at an earlier entry's local header... */
  sharesDataWith?: number;
  /** ...plus this many bytes, e.g. at a local header hidden inside that entry's data. */
  sharedOffset?: number;
}

export interface ZipOptions {
  zip64?: boolean;
}

const MAX32 = 0xffffffff;

export function buildZip(entries: ZipEntrySpec[], options: ZipOptions = {}): Buffer {
  const zip64 = options.zip64 ?? false;
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  entries.forEach((spec, index) => {
    const name = Buffer.from(spec.name, "utf-8");
    const isDirectory = spec.name.endsWith("/");
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? "", "utf-8");
    const method = spec.method ?? (data.length > 0 ? 8 : 0);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = spec.crc ?? crc32(data);
    const size = spec.size ?? data.length;
    const mode = spec.mode ?? (isDirectory ? 0o040755 : 0o100644);
    const flags = spec.flags ?? 0x0800;
    const version = zip64 ? 45 : 20;

    let localOffset = offset;
    if (spec.sharesDataWith === undefined) {
      const localName = Buffer.from(spec.localName ?? spec.name, "utf-8");
      const extra = Buffer.alloc(zip64 ? 20 : 0);
      if (zip64) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(16, 2);
        extra.writeBigUInt64LE(BigInt(size), 4);
        extra.writeBigUInt64LE(BigInt(compressed.length), 12);
      }
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(version, 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(zip64 ? MAX32 : compressed.length, 18);
      header.writeUInt32LE(zip64 ? MAX32 : size, 22);
      header.writeUInt16LE(localName.length, 26);
      header.writeUInt16LE(extra.length, 28);
      parts.push(header, localName, extra, compressed);
      offsets[index] = offset;
      offset += header.length + localName.length + extra.length + compressed.length;
    } else {
      localOffset = offsets[spec.sharesDataWith] + (spec.sharedOffset ?? 0);
    }

    const extra = Buffer.alloc(zip64 ? 28 : 0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(compressed.length), 12);
      extra.writeBigUInt64LE(BigInt(localOffset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(spec.madeBy ?? 0x031e, 4);
    central.writeUInt16LE(version, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(zip64 ? MAX32 : compressed.length, 20);
    central.writeUInt32LE(zip64 ? MAX32 : size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((mode * 0x10000 + (isDirectory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(zip64 ? MAX32 : localOffset, 42);
    centrals.push(central, name, extra);
  });

  const directory = Buffer.concat(centrals);
  const directoryOffset = offset;
  parts.push(directory);
  offset += directory.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(MAX32, 12);
    eocd.writeUInt32LE(MAX32, 16);
  } else {
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(directoryOffset, 16);
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}

/** Lists a directory tree as ZIP entries under `prefix`, preserving modes and symlinks. */
export function zipEntriesFromDirectory(root: string, prefix: string): ZipEntrySpec[] {
  const entries: ZipEntrySpec[] = [{ name: `${prefix}/` }];
  const walk = (dir: string, relative: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const entryName = `${prefix}/${relative}${name}`;
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        entries.push({ name: entryName, data: readlinkSync(path), mode: 0o120777, method: 0 });
      } else if (stats.isDirectory()) {
        entries.push({ name: `${entryName}/` });
        walk(path, `${relative}${name}/`);
      } else {
        entries.push({
          name: entryName,
          data: readFileSync(path),
          mode: 0o100000 | (stats.mode & 0o777),
        });
      }
    }
  };
  walk(root, "");
  return entries;
}

export function writeZip(path: string, entries: ZipEntrySpec[], options?: ZipOptions): string {
  writeFileSync(path, buildZip(entries, options));
  return path;
}
