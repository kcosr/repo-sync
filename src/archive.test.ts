import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ArchiveError, ZipArchive, sha256File } from "./archive.js";
import { makeTempDir } from "./testing/fixtures.js";
import { type ZipEntrySpec, buildZip, writeZip } from "./testing/zip-writer.js";
import type { ArchiveLimits } from "./types.js";

const limits: ArchiveLimits = { maxBytes: 1024 * 1024, maxEntries: 100 };

describe("archive", () => {
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

  async function extract(path: string, archiveLimits = limits): Promise<string> {
    const archive = ZipArchive.open(path, archiveLimits);
    try {
      const dest = freshDir();
      await archive.extractTo(dest);
      return dest;
    } finally {
      archive.close();
    }
  }

  function expectRejected(entries: ZipEntrySpec[], message: RegExp | typeof ArchiveError): void {
    const path = zip(entries);
    expect(() => ZipArchive.open(path, limits)).toThrow(ArchiveError);
    expect(() => ZipArchive.open(path, limits)).toThrow(message);
  }

  describe("valid archives", () => {
    it("extracts stored and deflated files, modes, directories and contained symlinks", async () => {
      const dest = await extract(
        zip([
          { name: "repo/" },
          { name: "repo/src/" },
          { name: "repo/src/main.ts", data: "console.log(1);\n", method: 8 },
          { name: "repo/run.sh", data: "#!/bin/sh\n", mode: 0o100755, method: 0 },
          { name: "repo/empty.txt", data: "" },
          { name: "repo/docs/guide.md", data: "nested without a directory entry" },
          { name: "repo/link.ts", data: "src/main.ts", mode: 0o120777, method: 0 },
          { name: "repo/src/up.md", data: "../docs/guide.md", mode: 0o120777, method: 8 },
        ]),
      );

      expect(readFileSync(join(dest, "repo/src/main.ts"), "utf-8")).toBe("console.log(1);\n");
      expect(statSync(join(dest, "repo/run.sh")).mode & 0o100).toBe(0o100);
      expect(statSync(join(dest, "repo/src/main.ts")).mode & 0o111).toBe(0);
      expect(readFileSync(join(dest, "repo/empty.txt"), "utf-8")).toBe("");
      expect(readFileSync(join(dest, "repo/docs/guide.md"), "utf-8")).toContain("nested");
      expect(readlinkSync(join(dest, "repo/link.ts"))).toBe("src/main.ts");
      expect(readlinkSync(join(dest, "repo/src/up.md"))).toBe("../docs/guide.md");
    });

    it("reads ZIP64 archives", async () => {
      const dest = await extract(
        zip([{ name: "repo/" }, { name: "repo/a.txt", data: "zip64" }], { zip64: true }),
      );

      expect(readFileSync(join(dest, "repo/a.txt"), "utf-8")).toBe("zip64");
    });

    it("decodes UTF-8 names", async () => {
      const dest = await extract(
        zip([{ name: "repo/" }, { name: "repo/naïve-文件.txt", data: "x" }]),
      );

      expect(readdirSync(join(dest, "repo"))).toEqual(["naïve-文件.txt"]);
    });

    it("reports the root, entry count and total bytes", () => {
      const archive = ZipArchive.open(
        zip([{ name: "top/" }, { name: "top/a", data: "abc" }, { name: "top/b", data: "de" }]),
        limits,
      );
      try {
        expect(archive.root).toBe("top");
        expect(archive.entries).toHaveLength(3);
        expect(archive.totalBytes).toBe(5);
      } finally {
        archive.close();
      }
    });

    it("computes the archive SHA-256 without modifying the file", async () => {
      const path = zip([{ name: "repo/" }, { name: "repo/a", data: "a" }]);
      const before = readFileSync(path);
      const expected = createHash("sha256").update(before).digest("hex");

      const digest = await sha256File(path);

      expect(digest.sha256).toBe(expected);
      expect(digest.size).toBe(before.length);
      expect(readFileSync(path).equals(before)).toBe(true);
    });
  });

  describe("unsafe paths", () => {
    it.each([
      ["parent traversal", "repo/../../evil.txt"],
      ["absolute path", "/tmp/evil.txt"],
      ["drive letter", "C:/evil.txt"],
      ["backslash separators", "repo\\..\\evil.txt"],
      ["dot segment", "repo/./evil.txt"],
      ["empty segment", "repo//evil.txt"],
    ])("rejects %s", (_label, name) => {
      expectRejected([{ name: "repo/" }, { name, data: "x" }], ArchiveError);
    });

    it("rejects NUL bytes in names", () => {
      expectRejected([{ name: "repo/" }, { name: "repo/a\0b", data: "x" }], /NUL/);
    });

    it("rejects duplicate entries", () => {
      expectRejected(
        [{ name: "repo/" }, { name: "repo/a", data: "1" }, { name: "repo/a", data: "2" }],
        /duplicate/,
      );
    });

    it("rejects more than one top-level directory", () => {
      expectRejected(
        [{ name: "one/" }, { name: "one/a", data: "1" }, { name: "two/b", data: "2" }],
        /exactly one top-level directory/,
      );
    });

    it("rejects files at the archive root", () => {
      expectRejected([{ name: "README", data: "x" }], /top-level entry must be a directory/);
    });

    it("rejects entries nested beneath a symlink", () => {
      expectRejected(
        [
          { name: "repo/" },
          { name: "repo/sub/" },
          { name: "repo/link", data: "sub", mode: 0o120777, method: 0 },
          { name: "repo/link/payload", data: "x" },
        ],
        /nested beneath a symlink/,
      );
    });

    it("rejects entries nested beneath a file", () => {
      expectRejected(
        [
          { name: "repo/" },
          { name: "repo/file", data: "x" },
          { name: "repo/file/child", data: "y" },
        ],
        /nested beneath a file/,
      );
    });
  });

  describe("links and special files", () => {
    it.each([
      ["an absolute target", "/etc/passwd"],
      ["a parent traversal", "../../outside"],
      ["a traversal past the repository root", "../outside"],
    ])("rejects a symlink with %s", (_label, target) => {
      expectRejected(
        [{ name: "repo/" }, { name: "repo/link", data: target, mode: 0o120777, method: 0 }],
        /escapes the archive directory/,
      );
    });

    it("rejects symlinks that escape through another symlink", () => {
      // Lexically repo/self/.. is repo, but self resolves to repo, so self/.. is outside it.
      expectRejected(
        [
          { name: "repo/" },
          { name: "repo/self", data: ".", mode: 0o120777, method: 0 },
          { name: "repo/escape", data: "self/..", mode: 0o120777, method: 0 },
        ],
        /escapes the archive directory/,
      );
    });

    it("rejects symlink loops", () => {
      expectRejected(
        [
          { name: "repo/" },
          { name: "repo/a", data: "b/x", mode: 0o120777, method: 0 },
          { name: "repo/b", data: "a", mode: 0o120777, method: 0 },
        ],
        /forms a loop/,
      );
    });

    it.each([
      ["FIFO", 0o010644],
      ["character device", 0o020644],
      ["block device", 0o060644],
      ["socket", 0o140644],
    ])("rejects a %s entry", (_label, mode) => {
      expectRejected([{ name: "repo/" }, { name: "repo/special", mode }], /special file/);
    });
  });

  describe("bounds and integrity", () => {
    it("rejects archives whose declared size exceeds the limit", () => {
      const path = zip([{ name: "repo/" }, { name: "repo/big", data: Buffer.alloc(2048) }]);

      expect(() => ZipArchive.open(path, { maxBytes: 1024, maxEntries: 100 })).toThrow(
        /beyond the limit of 1024 bytes/,
      );
    });

    it("rejects archives with too many entries", () => {
      const entries: ZipEntrySpec[] = [{ name: "repo/" }];
      for (let i = 0; i < 5; i++) {
        entries.push({ name: `repo/f${i}`, data: "x" });
      }

      expect(() => ZipArchive.open(zip(entries), { maxBytes: 1024, maxEntries: 3 })).toThrow(
        /exceeding the limit of 3/,
      );
    });

    it("stops extracting an entry that inflates beyond its declared size", async () => {
      const path = zip([
        { name: "repo/" },
        { name: "repo/bomb", data: Buffer.alloc(512 * 1024), method: 8, size: 10 },
      ]);

      await expect(extract(path)).rejects.toThrow(/expands beyond its declared size/);
    });

    it("rejects entries that fail their CRC check", async () => {
      const path = zip([{ name: "repo/" }, { name: "repo/a", data: "hello", crc: 1234 }]);

      await expect(extract(path)).rejects.toThrow(/CRC/);
    });

    it("rejects overlapping entries", () => {
      // A complete local header for repo/b hidden inside repo/a's stored data, as used by
      // overlapping-entry ZIP bombs.
      const hidden = buildZip([{ name: "repo/b", data: "bbbb", method: 0 }]).subarray(0, 40);
      expectRejected(
        [
          { name: "repo/" },
          { name: "repo/a", data: hidden, method: 0 },
          { name: "repo/b", data: "bbbb", method: 0, sharesDataWith: 1, sharedOffset: 36 },
        ],
        /entries overlap/,
      );
    });

    it("rejects local headers that disagree with the central directory", () => {
      expectRejected(
        [{ name: "repo/" }, { name: "repo/safe", localName: "repo/../x", data: "x" }],
        /local header/,
      );
    });

    it("rejects encrypted entries", () => {
      expectRejected(
        [{ name: "repo/" }, { name: "repo/a", data: "x", flags: 0x0801 }],
        /encrypted/,
      );
    });

    it("rejects unsupported compression methods", () => {
      const buffer = buildZip([{ name: "repo/" }, { name: "repo/a", data: "x", method: 0 }]);
      // Rewrite the method in both the local header and central directory record to bzip2 (12).
      buffer.writeUInt16LE(12, buffer.indexOf("repo/a") - 22);
      buffer.writeUInt16LE(12, buffer.lastIndexOf("repo/a") - 36);
      const path = join(testDir, `method-${counter++}.zip`);
      writeFileSync(path, buffer);

      expect(() => ZipArchive.open(path, limits)).toThrow(/unsupported compression method 12/);
    });

    it("rejects files that are not ZIP archives", () => {
      const path = join(testDir, `not-zip-${counter++}.zip`);
      writeFileSync(path, "definitely not a zip file, just some text that is long enough");

      expect(() => ZipArchive.open(path, limits)).toThrow(/not a ZIP archive/);
    });

    it("rejects truncated archives", () => {
      const full = buildZip([{ name: "repo/" }, { name: "repo/a", data: "hello world" }]);
      const path = join(testDir, `truncated-${counter++}.zip`);
      writeFileSync(path, full.subarray(10));

      expect(() => ZipArchive.open(path, limits)).toThrow(ArchiveError);
    });

    it("refuses to extract into a non-empty directory", async () => {
      const archive = ZipArchive.open(
        zip([{ name: "repo/" }, { name: "repo/a", data: "x" }]),
        limits,
      );
      const dest = freshDir();
      writeFileSync(join(dest, "existing"), "keep");
      try {
        await expect(archive.extractTo(dest)).rejects.toThrow(/not empty/);
      } finally {
        archive.close();
      }
      expect(readdirSync(dest)).toEqual(["existing"]);
    });

    it("writes nothing outside the extraction directory for rejected archives", () => {
      const outside = join(testDir, "outside-marker");
      expectRejected(
        [{ name: "repo/" }, { name: "repo/../../outside-marker", data: "x" }],
        ArchiveError,
      );

      expect(existsSync(outside)).toBe(false);
      expect(lstatSync(testDir).isDirectory()).toBe(true);
    });
  });
});
