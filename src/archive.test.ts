import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArchiveError, extractGitArchive } from "./archive.js";
import { makeTempDir } from "./testing/fixtures.js";
import { type ZipEntrySpec, buildZip, writeZip } from "./testing/zip-writer.js";
import type { ArchiveLimits } from "./types.js";

const limits: ArchiveLimits = { maxBytes: 1024 * 1024, maxEntries: 100 };
const head: ZipEntrySpec = { name: "repo/.git/HEAD", data: "ref: refs/heads/main\n" };

describe("archive Git intake", () => {
  let testDir: string;
  let counter = 0;

  beforeAll(() => {
    testDir = makeTempDir("archive-test");
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function zip(entries: ZipEntrySpec[], options?: { zip64?: boolean }): string {
    return writeZip(join(testDir, `archive-${counter++}.zip`), entries, options);
  }

  function freshDir(): string {
    const dir = join(testDir, `extract-${counter++}`);
    mkdirSync(dir);
    return dir;
  }

  function extract(path: string, archiveLimits = limits): Promise<string> {
    return extractGitArchive(path, freshDir(), archiveLimits);
  }

  it("extracts only the Git data needed to build a trusted repository", async () => {
    const looseSha1 = `objects/ab/${"1".repeat(38)}`;
    const looseSha256 = `objects/cd/${"2".repeat(62)}`;
    const gitDir = await extract(
      zip([
        head,
        { name: "repo/.git/config", data: "[core]\nrepositoryformatversion = 0\n" },
        { name: "repo/.git/packed-refs", data: "" },
        { name: "repo/.git/refs/heads/main", data: "1".repeat(40) },
        { name: "repo/.git/refs/tags/v1", data: "2".repeat(40) },
        { name: `repo/.git/${looseSha1}`, data: "loose sha1", method: 0 },
        { name: `repo/.git/${looseSha256}`, data: "loose sha256" },
        { name: "repo/.git/objects/pack/pack-abcd.pack", data: "pack" },
        { name: "repo/.git/objects/pack/pack-abcd.idx", data: "unused index", crc: 1234 },
        { name: "repo/.git/objects/info/packs", data: "unused metadata" },
        { name: "repo/.git/hooks/pre-commit", data: "never execute", mode: 0o100755 },
        { name: "repo/.git/index", data: "untrusted index" },
        { name: "repo/.git/info/attributes", data: "untrusted attributes" },
        { name: "repo/.git/refs/remotes/origin/main", data: "3".repeat(40) },
        { name: "repo/dirty.txt", data: "not in the commit", crc: 1234 },
        { name: "repo/nested/.git/config", data: "ignored nested working-tree data" },
        { name: "repo/link", data: "/outside", mode: 0o120777 },
        { name: "repo/loop", data: "loop", mode: 0o120777 },
      ]),
    );

    expect(gitDir.endsWith("/repo/.git")).toBe(true);
    expect(readFileSync(join(gitDir, "HEAD"), "utf-8")).toBe(head.data);
    expect(readFileSync(join(gitDir, "config"), "utf-8")).toContain("repositoryformatversion");
    expect(readFileSync(join(gitDir, "packed-refs"), "utf-8")).toBe("");
    expect(readFileSync(join(gitDir, looseSha1), "utf-8")).toBe("loose sha1");
    expect(readFileSync(join(gitDir, looseSha256), "utf-8")).toBe("loose sha256");
    expect(readdirSync(join(gitDir, "objects/pack"))).toEqual(["pack-abcd.pack"]);
    expect(readdirSync(join(gitDir, "refs"))).toEqual(["heads", "tags"]);
    expect(readdirSync(gitDir).sort()).toEqual([
      "HEAD",
      "config",
      "objects",
      "packed-refs",
      "refs",
    ]);
    expect(readdirSync(join(gitDir, ".."))).toEqual([".git"]);
  });

  it("reads ZIP64 archives", async () => {
    const gitDir = await extract(zip([head], { zip64: true }));
    expect(readFileSync(join(gitDir, "HEAD"), "utf-8")).toBe(head.data);
  });

  it("reads an independent Python zipfile fixture with UTF-8 paths", async () => {
    // Produced with Python's zipfile.ZipFile(..., ZIP_DEFLATED), independently of buildZip.
    const fixture = Buffer.from(
      "UEsDBBQAAAAIAApbWF3MdWi/GAAAABYAAAAOAAAAcmVwby8uZ2l0L0hFQUQrSk2zUihKTSvWz0hNTCnWT05MO7ySCwBQSwMEFAAACAgACltYXdKMQXgHAAAAKQAAABoAAAByZXBvLy5naXQvcmVmcy9oZWFkcy9jYWbDqTM0JA5wAQBQSwMEFAAAAAgACltYXZdk8sYPAAAADQAAABAAAAByZXBvL2lnbm9yZWQudHh0y8svUcjMLcgvKklN4QIAUEsBAhQDFAAAAAgACltYXcx1aL8YAAAAFgAAAA4AAAAAAAAAAAAAAIABAAAAAHJlcG8vLmdpdC9IRUFEUEsBAhQDFAAACAgACltYXdKMQXgHAAAAKQAAABoAAAAAAAAAAAAAAIABRAAAAHJlcG8vLmdpdC9yZWZzL2hlYWRzL2NhZsOpUEsBAhQDFAAAAAgACltYXZdk8sYPAAAADQAAABAAAAAAAAAAAAAAAIABgwAAAHJlcG8vaWdub3JlZC50eHRQSwUGAAAAAAMAAwDCAAAAwAAAAAAA",
      "base64",
    );
    const path = join(testDir, "python.zip");
    writeFileSync(path, fixture);
    const gitDir = await extract(path);
    expect(readFileSync(join(gitDir, "HEAD"), "utf-8")).toBe("ref: refs/heads/café\n");
    expect(readFileSync(join(gitDir, "refs/heads/café"), "utf-8")).toBe(`${"1".repeat(40)}\n`);
    expect(existsSync(join(gitDir, "../ignored.txt"))).toBe(false);
  });

  it.each([
    "repo/../../outside",
    "/tmp/outside",
    "C:/outside",
    "repo\\..\\outside",
    "repo/./outside",
    "repo//outside",
    "repo/a\0b",
    `repo/${"x".repeat(256)}`,
  ])("rejects unsafe names even in ignored working-tree data: %s", async (name) => {
    await expect(extract(zip([head, { name, data: "x" }]))).rejects.toThrow(ArchiveError);
    expect(existsSync(join(testDir, "outside"))).toBe(false);
  });

  it("rejects duplicate entries", async () => {
    await expect(extract(zip([head, head]))).rejects.toThrow(/duplicate/);
  });

  it("rejects more than one top-level directory", async () => {
    await expect(extract(zip([head, { name: "other/file", data: "x" }]))).rejects.toThrow(
      /exactly one top-level directory/,
    );
  });

  it("rejects files at the archive root", async () => {
    await expect(extract(zip([{ name: "README", data: "x" }]))).rejects.toThrow(
      /top-level entry must be a directory/,
    );
  });

  it.each([false, true])(
    "rejects ancestor collisions in either order (reverse=%s)",
    async (reverse) => {
      const collision = [
        { name: "repo/file", data: "x" },
        { name: "repo/file/child", data: "y" },
      ];
      if (reverse) collision.reverse();
      await expect(extract(zip([head, ...collision]))).rejects.toThrow(/nested beneath/);
    },
  );

  it("rejects entries nested beneath working-tree symlinks", async () => {
    await expect(
      extract(
        zip([head, { name: "repo/link", data: ".", mode: 0o120777 }, { name: "repo/link/a" }]),
      ),
    ).rejects.toThrow(/nested beneath a symlink/);
  });

  it.each([0o100644, 0o120777])("requires a real .git directory (mode %s)", async (mode) => {
    await expect(extract(zip([{ name: "repo/.git", data: "elsewhere", mode }]))).rejects.toThrow(
      /real .git directory/,
    );
  });

  it("requires a HEAD file", async () => {
    await expect(extract(zip([{ name: "repo/README", data: "x" }]))).rejects.toThrow(/HEAD/);
  });

  it.each(["HEAD", "objects/link", "hooks/ignored-link"])(
    "rejects symlinks anywhere beneath .git: %s",
    async (path) => {
      const entries = path === "HEAD" ? [] : [head];
      await expect(
        extract(zip([...entries, { name: `repo/.git/${path}`, data: "/outside", mode: 0o120777 }])),
      ).rejects.toThrow(/Git directory contains a symlink/);
    },
  );

  it.each([0o010644, 0o020644, 0o060644, 0o140644])(
    "rejects special Git files (mode %s)",
    async (mode) => {
      await expect(extract(zip([head, { name: "repo/.git/special", mode }]))).rejects.toThrow(
        /special/,
      );
    },
  );

  it.each([
    "shallow",
    "commondir",
    "info/grafts",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "reftable",
  ])("rejects unsupported history metadata and its descendants: %s", async (path) => {
    for (const suffix of ["", "/child"]) {
      await expect(
        extract(zip([head, { name: `repo/.git/${path}${suffix}`, data: "x" }])),
      ).rejects.toThrow(/unsupported history metadata/);
    }
  });

  it("bounds total declared bytes including ignored working-tree data", async () => {
    const path = zip([head, { name: "repo/big", data: Buffer.alloc(2048) }]);
    await expect(extract(path, { maxBytes: 1024, maxEntries: 100 })).rejects.toThrow(
      /beyond the limit of 1024 bytes/,
    );
  });

  it("bounds the entry count including ignored working-tree data", async () => {
    const path = zip([head, ...Array.from({ length: 5 }, (_, i) => ({ name: `repo/f${i}` }))]);
    await expect(extract(path, { maxBytes: 1024, maxEntries: 3 })).rejects.toThrow(/limit of 3/);
  });

  it("stops extracting entries that inflate beyond their declared size", async () => {
    const path = zip([{ ...head, data: Buffer.alloc(512 * 1024), method: 8, size: 10 }]);
    await expect(extract(path)).rejects.toThrow(/too many bytes/);
  });

  it("rejects truncated inflated data", async () => {
    const path = zip([{ ...head, data: "small", method: 8, size: 100 }]);
    await expect(extract(path)).rejects.toThrow(/not enough bytes/);
  });

  it.each(["hello", ""])(
    "checks CRC for selected files, including empty files (%j)",
    async (data) => {
      await expect(extract(zip([{ ...head, data, crc: 1234 }]))).rejects.toThrow(/CRC/);
    },
  );

  it("rejects encrypted selected entries", async () => {
    await expect(extract(zip([{ ...head, flags: 0x0801 }]))).rejects.toThrow(/encrypted/);
  });

  it("rejects unsupported compression for selected entries", async () => {
    const buffer = buildZip([{ ...head, method: 0 }]);
    buffer.writeUInt16LE(12, buffer.indexOf(head.name) - 22);
    buffer.writeUInt16LE(12, buffer.lastIndexOf(head.name) - 36);
    const path = join(testDir, "method.zip");
    writeFileSync(path, buffer);
    await expect(extract(path)).rejects.toThrow(/unsupported compression method/);
  });

  it("rejects files that are not ZIP archives", async () => {
    const path = join(testDir, "not-zip.zip");
    writeFileSync(path, "definitely not a ZIP archive");
    await expect(extract(path)).rejects.toThrow(ArchiveError);
  });

  it("rejects truncated archives", async () => {
    const full = buildZip([head]);
    const path = join(testDir, "truncated.zip");
    writeFileSync(path, full.subarray(10));
    await expect(extract(path)).rejects.toThrow(ArchiveError);
  });

  it("refuses to extract into a non-empty directory", async () => {
    const dest = freshDir();
    writeFileSync(join(dest, "existing"), "keep");
    await expect(extractGitArchive(zip([head]), dest, limits)).rejects.toThrow(/not empty/);
    expect(readdirSync(dest)).toEqual(["existing"]);
  });
});
