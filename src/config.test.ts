import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, getRepoTempPath, loadConfig } from "./config.js";

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
      expect(config.repos[0].name).toBe("test-repo");
      expect(config.repos[0].public).toBe("https://github.com/org/test-repo.git");
      expect(config.repos[0].private).toBe("git@private.com:vendor/test-repo.git");
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
  });
});
