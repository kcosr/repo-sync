import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ARCHIVE_LIMITS,
  findRepo,
  getArchiveLimits,
  getCacheDir,
  getRepoTempPath,
  getStagingDir,
  getWorkDir,
  isArchiveRepo,
  loadConfig,
} from "./config.js";
import type { RemoteRepoConfig } from "./types.js";

describe("config", () => {
  const testDir = join(tmpdir(), `repo-sync-test-${Date.now()}`);
  const testConfigPath = join(testDir, "config.yaml");

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    it("should load a valid config file", () => {
      writeFileSync(
        testConfigPath,
        `repos:
  - name: test-repo
    public: https://github.com/org/test-repo.git
    private: git@private.com:vendor/test-repo.git
  - name: another-repo
    public: https://github.com/org/another.git
    private: git@private.com:vendor/another.git
`,
      );

      const config = loadConfig(testConfigPath);

      expect(config.repos).toHaveLength(2);
      const repo = config.repos[0] as RemoteRepoConfig;
      expect(repo.name).toBe("test-repo");
      expect(repo.public).toBe("https://github.com/org/test-repo.git");
      expect(repo.private).toBe("git@private.com:vendor/test-repo.git");
      expect(repo.sourceNotice).toBe("none");
      expect(isArchiveRepo(repo)).toBe(false);
    });

    it("should throw if config file does not exist", () => {
      expect(() => loadConfig("/nonexistent/path.yaml")).toThrow("Config file not found");
    });

    it("should throw if repos array is missing", () => {
      writeFileSync(testConfigPath, "something: else\n");

      expect(() => loadConfig(testConfigPath)).toThrow("Config must have a 'repos' array");
    });

    it("should throw if repo is missing name", () => {
      writeFileSync(
        testConfigPath,
        `repos:
  - public: https://github.com/org/test.git
    private: git@private.com:vendor/test.git
`,
      );

      expect(() => loadConfig(testConfigPath)).toThrow("must have a 'name' string");
    });

    it("should throw if repo is missing public URL", () => {
      writeFileSync(
        testConfigPath,
        `repos:
  - name: test-repo
    private: git@private.com:vendor/test.git
`,
      );

      expect(() => loadConfig(testConfigPath)).toThrow("must have a 'public' URL");
    });

    it("should throw if repo is missing private URL", () => {
      writeFileSync(
        testConfigPath,
        `repos:
  - name: test-repo
    public: https://github.com/org/test.git
`,
      );

      expect(() => loadConfig(testConfigPath)).toThrow("must have a 'private' URL");
    });

    it("should load cacheDir and normalize legacy markSource options", () => {
      writeFileSync(
        testConfigPath,
        `cacheDir: /tmp/repo-sync-cache
repos:
  - name: test-repo
    public: https://github.com/org/test.git
    private: git@private.com:vendor/test.git
    markSource: true
`,
      );

      const config = loadConfig(testConfigPath);

      expect(config.cacheDir).toBe("/tmp/repo-sync-cache");
      expect(config.repos[0].sourceNotice).toBe("linked");
      expect(config.repos[0]).not.toHaveProperty("markSource");
    });

    it("should throw if cacheDir is not a string", () => {
      writeFileSync(testConfigPath, "cacheDir: 123\nrepos: []\n");

      expect(() => loadConfig(testConfigPath)).toThrow("Config 'cacheDir' must be a string");
    });

    it("should throw if cacheDir is empty", () => {
      writeFileSync(testConfigPath, "cacheDir: ''\nrepos: []\n");

      expect(() => loadConfig(testConfigPath)).toThrow("Config 'cacheDir' cannot be empty");
    });

    it.each(["remote", "archive"])("rejects obsolete clone options for %s repos", (source) => {
      writeFileSync(
        testConfigPath,
        `repos:\n  - name: test-repo\n    source: ${source}\n    private: git@private.com:vendor/test.git\n${source === "remote" ? "    public: https://github.com/org/test.git\n" : ""}    markSourceDeleteClone: false\n`,
      );

      expect(() => loadConfig(testConfigPath)).toThrow(
        "cannot set 'markSourceDeleteClone': sourceNotice no longer creates work clones; use 'repo-sync clone'",
      );
    });

    it("should load archive-managed repos without a public URL", () => {
      writeFileSync(
        testConfigPath,
        `repos:
  - name: local-tool
    source: archive
    private: git@private.com:vendor/destination-name.git
  - name: remote-tool
    source: remote
    public: https://github.com/org/tool.git
    private: git@private.com:vendor/tool.git
`,
      );

      const config = loadConfig(testConfigPath);

      expect(isArchiveRepo(config.repos[0])).toBe(true);
      expect(config.repos[0].private).toBe("git@private.com:vendor/destination-name.git");
      expect(config.repos[0].sourceNotice).toBe("none");
      expect(isArchiveRepo(config.repos[1])).toBe(false);
    });

    it("should reject archive-managed repos that set public", () => {
      writeFileSync(
        testConfigPath,
        `repos:
  - name: tool
    source: archive
    private: git@private.com:vendor/tool.git
    public: https://github.com/org/tool.git
`,
      );

      expect(() => loadConfig(testConfigPath)).toThrow("is archive-managed and cannot set");
    });

    describe("sourceNotice", () => {
      function writeRepo(source: "remote" | "archive", settings: string): void {
        writeFileSync(
          testConfigPath,
          `repos:\n  - name: tool\n    source: ${source}\n    private: git@private.com:vendor/tool.git\n${source === "remote" ? "    public: https://github.com/org/tool.git\n" : ""}${settings}`,
        );
      }

      it.each(["linked", "generic", "none"])("loads remote mode %s", (mode) => {
        writeRepo("remote", `    sourceNotice: ${mode}\n`);

        expect(loadConfig(testConfigPath).repos[0].sourceNotice).toBe(mode);
      });

      it.each(["generic", "none"])("loads archive mode %s", (mode) => {
        writeRepo("archive", `    sourceNotice: ${mode}\n`);

        expect(loadConfig(testConfigPath).repos[0].sourceNotice).toBe(mode);
      });

      it.each([
        [true, "linked"],
        [false, "none"],
      ])("normalizes legacy markSource: %s to %s", (legacy, mode) => {
        writeRepo("remote", `    markSource: ${legacy}\n`);

        const repo = loadConfig(testConfigPath).repos[0];
        expect(repo.sourceNotice).toBe(mode);
        expect(repo).not.toHaveProperty("markSource");
      });

      it("accepts legacy markSource: false for archives", () => {
        writeRepo("archive", "    markSource: false\n");

        const repo = loadConfig(testConfigPath).repos[0];
        expect(repo.sourceNotice).toBe("none");
        expect(repo).not.toHaveProperty("markSource");
      });

      it.each(["sourceNotice: linked", "markSource: true"])(
        "rejects archive %s with generic guidance",
        (setting) => {
          writeRepo("archive", `    ${setting}\n`);

          expect(() => loadConfig(testConfigPath)).toThrow(
            "cannot use sourceNotice: linked; use sourceNotice: generic",
          );
        },
      );

      it.each([
        ["linked", true],
        ["none", false],
        ["generic", false],
      ])("rejects sourceNotice: %s with markSource: %s", (mode, legacy) => {
        writeRepo("remote", `    sourceNotice: ${mode}\n    markSource: ${legacy}\n`);

        expect(() => loadConfig(testConfigPath)).toThrow(
          "cannot set both 'sourceNotice' and 'markSource'",
        );
      });

      it.each(["custom", "true", "null", "''"])("rejects invalid mode %s", (mode) => {
        writeRepo("remote", `    sourceNotice: ${mode}\n`);

        expect(() => loadConfig(testConfigPath)).toThrow("invalid 'sourceNotice'");
      });

      it.each(["'true'", "1", "null"])("rejects nonboolean legacy value %s", (value) => {
        writeRepo("remote", `    markSource: ${value}\n`);

        expect(() => loadConfig(testConfigPath)).toThrow("invalid 'markSource': expected boolean");
      });
    });

    it("should require a private URL for archive-managed repos", () => {
      writeFileSync(testConfigPath, "repos:\n  - name: tool\n    source: archive\n");

      expect(() => loadConfig(testConfigPath)).toThrow("must have a 'private' URL");
    });

    it("should reject unknown sources", () => {
      writeFileSync(
        testConfigPath,
        "repos:\n  - name: tool\n    source: tarball\n    private: git@private.com:vendor/tool.git\n",
      );

      expect(() => loadConfig(testConfigPath)).toThrow("invalid 'source'");
    });

    it("should load archive limits and fill in defaults", () => {
      writeFileSync(testConfigPath, "archiveLimits:\n  maxBytes: 1048576\nrepos: []\n");

      const config = loadConfig(testConfigPath);

      expect(getArchiveLimits(config)).toEqual({
        maxBytes: 1048576,
        maxEntries: DEFAULT_ARCHIVE_LIMITS.maxEntries,
      });
      expect(getArchiveLimits({ repos: [] })).toEqual(DEFAULT_ARCHIVE_LIMITS);
    });

    it.each([
      ["archiveLimits: 5", "must be a mapping"],
      ["archiveLimits:\n  maxBytes: -1", "must be a positive integer"],
      ["archiveLimits:\n  maxEntries: 1.5", "must be a positive integer"],
      ["archiveLimits:\n  maxSize: 10", "unknown key 'maxSize'"],
    ])("should reject invalid archive limits (%s)", (yaml, message) => {
      writeFileSync(testConfigPath, `${yaml}\nrepos: []\n`);

      expect(() => loadConfig(testConfigPath)).toThrow(message);
    });
  });

  describe("findRepo", () => {
    it("should find a repo by name", () => {
      const config = {
        repos: [
          { name: "repo-a", public: "https://a.git", private: "git@a.git" },
          { name: "repo-b", public: "https://b.git", private: "git@b.git" },
        ],
      };

      const repo = findRepo(config, "repo-b");

      expect(repo).toBeDefined();
      expect(repo?.name).toBe("repo-b");
    });

    it("should return undefined for unknown repo", () => {
      const config = {
        repos: [{ name: "repo-a", public: "https://a.git", private: "git@a.git" }],
      };

      const repo = findRepo(config, "unknown");

      expect(repo).toBeUndefined();
    });
  });

  describe("getRepoTempPath", () => {
    it("should return path with .git suffix", () => {
      const path = getRepoTempPath("my-repo");

      expect(path).toContain("my-repo.git");
      expect(path).toContain(".repo-sync");
    });

    it("should use custom cacheDir when provided", () => {
      const path = getRepoTempPath("my-repo", "/tmp/custom-cache");

      expect(path).toBe("/tmp/custom-cache/repos/my-repo.git");
    });
  });

  describe("getCacheDir", () => {
    it("should use default cache dir when not configured", () => {
      const path = getCacheDir({ repos: [] });

      expect(path).toContain(".repo-sync");
    });

    it("should resolve ~/ paths", () => {
      const path = getCacheDir({ cacheDir: "~/repo-sync-cache", repos: [] });

      expect(path).toContain("repo-sync-cache");
      expect(path.includes("~/")).toBe(false);
    });
  });

  describe("getWorkDir", () => {
    it("should place work clones under cacheDir/work", () => {
      const path = getWorkDir("/tmp/custom-cache");

      expect(path).toBe("/tmp/custom-cache/work");
    });
  });

  describe("getStagingDir", () => {
    it("should keep staging under cacheDir, outside repos and work", () => {
      expect(getStagingDir("/tmp/custom-cache")).toBe("/tmp/custom-cache/staging");
    });
  });
});
