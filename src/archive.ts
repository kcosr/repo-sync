import { createWriteStream, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { type Entry, type ZipFile, openPromise } from "yauzl";
import type { ArchiveLimits } from "./types.js";

export class ArchiveError extends Error {}

type EntryType = "file" | "directory" | "symlink" | "special";

const DISALLOWED_GIT_PATHS = [
  "shallow",
  "commondir",
  "info/grafts",
  "objects/info/alternates",
  "objects/info/http-alternates",
  "reftable",
];

function entryPath(name: string): string {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    Buffer.byteLength(path) > 4096 ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)
  ) {
    throw new ArchiveError(`Archive entry has an unsafe path: ${JSON.stringify(name)}`);
  }
  return path;
}

function entryType(entry: Entry): EntryType {
  const host = entry.versionMadeBy >> 8;
  const format = host === 3 ? (entry.externalFileAttributes >>> 16) & 0o170000 : 0;
  const namedDirectory = entry.fileName.endsWith("/");
  let type: EntryType;
  if (format === 0) {
    type =
      namedDirectory || (host === 0 && (entry.externalFileAttributes & 0x10) !== 0)
        ? "directory"
        : "file";
  } else if (format === 0o040000) {
    type = "directory";
  } else if (format === 0o100000) {
    type = "file";
  } else if (format === 0o120000) {
    type = "symlink";
  } else {
    type = "special";
  }
  if (namedDirectory && type !== "directory") {
    throw new ArchiveError(
      `Archive entry has a directory name but a ${type} type: ${entry.fileName}`,
    );
  }
  return type;
}

function neededGitFile(path: string): boolean {
  return (
    path === "HEAD" ||
    path === "config" ||
    path === "packed-refs" ||
    /^refs\/(heads|tags)\/.+/.test(path) ||
    /^objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(path) ||
    /^objects\/pack\/pack-[0-9a-f]+\.pack$/.test(path)
  );
}

/** yauzl bounds decompression; this verifies the checksum, including for empty files. */
function verifyCrc(entry: Entry): Transform {
  let checksum = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      checksum = crc32(chunk, checksum);
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        checksum === entry.crc32
          ? undefined
          : new ArchiveError(`Archive entry failed its CRC check: ${entry.fileName}`),
      );
    },
  });
}

/**
 * Extracts only inert Git history data into an empty private staging directory.
 * Working-tree contents and executable Git metadata are never extracted. The caller
 * must build and verify a fresh trusted repository before activating imported data.
 */
export async function extractGitArchive(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits,
): Promise<string> {
  if (readdirSync(destination).length !== 0) {
    throw new ArchiveError(`Extraction directory is not empty: ${destination}`);
  }
  let archive: ZipFile | undefined;
  try {
    archive = await openPromise(archivePath, {
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    if (archive.entryCount === 0) {
      throw new ArchiveError("Archive is empty");
    }
    if (archive.entryCount > limits.maxEntries) {
      throw new ArchiveError(`Archive entry count exceeds the limit of ${limits.maxEntries}`);
    }

    const paths = new Map<string, EntryType>();
    let root: string | undefined;
    let totalBytes = 0;
    for await (const entry of archive.eachEntry()) {
      const path = entryPath(entry.fileName);
      const segments = path.split("/");
      root ??= segments[0];
      if (segments[0] !== root) {
        throw new ArchiveError("Archive must contain exactly one top-level directory");
      }
      const type = entryType(entry);
      if (segments.length === 1 && type !== "directory") {
        throw new ArchiveError(`Archive top-level entry must be a directory: ${path}`);
      }
      if (paths.has(path)) {
        throw new ArchiveError(`Archive contains duplicate entries for ${path}`);
      }
      paths.set(path, type);
      totalBytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) {
        throw new ArchiveError(`Archive expands beyond the limit of ${limits.maxBytes} bytes`);
      }
      if (type === "directory" && entry.uncompressedSize !== 0) {
        throw new ArchiveError(`Archive directory entry has data: ${path}`);
      }

      if (segments[1] !== ".git") continue;
      if (segments.length === 2 && type !== "directory") {
        throw new ArchiveError(
          "Archive must contain a real .git directory, not a pointer or symlink",
        );
      }
      if (type === "symlink" || type === "special") {
        throw new ArchiveError(`Archive Git directory contains a ${type} entry: ${path}`);
      }
      const gitPath = segments.slice(2).join("/");
      if (
        DISALLOWED_GIT_PATHS.some(
          (blocked) => gitPath === blocked || gitPath.startsWith(`${blocked}/`),
        )
      ) {
        throw new ArchiveError(
          `Archive Git directory contains unsupported history metadata: ${gitPath}`,
        );
      }
      if (type !== "file" || !neededGitFile(gitPath)) continue;
      if (entry.generalPurposeBitFlag & (0x0001 | 0x0040 | 0x2000)) {
        throw new ArchiveError(`Archive entry is encrypted: ${path}`);
      }
      const target = join(resolve(destination), path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const input = await archive.openReadStreamPromise(entry);
      await pipeline(
        input,
        verifyCrc(entry),
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
      );
    }
    // Check after enumeration so collisions are rejected regardless of entry order.
    for (const path of paths.keys()) {
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        const ancestor = paths.get(segments.slice(0, depth).join("/"));
        if (ancestor && ancestor !== "directory") {
          throw new ArchiveError(`Archive entry is nested beneath a ${ancestor}: ${path}`);
        }
      }
    }
    if (paths.get(`${root}/.git/HEAD`) !== "file") {
      throw new ArchiveError("Archive Git directory has no HEAD file");
    }
    return join(resolve(destination), root as string, ".git");
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(`Could not extract ZIP archive: ${(error as Error).message}`);
  } finally {
    archive?.close();
  }
}
