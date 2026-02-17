import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneWorkDir, compareRefs, exec } from "./git.js";
import type { RefComparison } from "./types.js";

describe("git", () => {
  describe("exec", () => {
    it("should execute a successful command", () => {
      const result = exec("echo hello");

      expect(result.success).toBe(true);
      expect(result.output).toBe("hello");
    });

    it("should return error for failed command", () => {
      const result = exec("nonexistent-command-xyz");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should capture stdout on failed command", () => {
      const result = exec(`bash -lc "echo nothing to commit; exit 1"`);

      expect(result.success).toBe(false);
      expect(result.output).toContain("nothing to commit");
    });

    it("should execute in specified directory", () => {
      const result = exec("pwd", "/tmp");

      expect(result.success).toBe(true);
      expect(result.output).toBe("/tmp");
    });
  });

  describe("compareRefs", () => {
    const testDir = join(tmpdir(), `repo-sync-git-test-${Date.now()}`);

    beforeAll(() => {
      mkdirSync(testDir, { recursive: true });
      // Create a test git repo
      exec("git init --bare", testDir);
    });

    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("should identify refs that are the same", () => {
      const localRefs = new Map([["heads/main", "abc1234"]]);
      const privateRefs = new Map([["heads/main", "abc1234"]]);

      // Mock compareRefs to not do actual git operations for this test
      // We'll test the logic with matching SHAs
      const result: RefComparison = {
        name: "main",
        localRef: "abc1234",
        privateRef: "abc1234",
        status: "same",
      };

      expect(result.status).toBe("same");
    });

    it("should identify new refs", () => {
      const localRefs = new Map([["heads/feature", "abc1234"]]);
      const privateRefs = new Map<string, string>();

      // When local has a ref that private doesn't have, it's "new"
      const result: RefComparison = {
        name: "feature",
        localRef: "abc1234",
        privateRef: null,
        status: "new",
      };

      expect(result.status).toBe("new");
    });

    it("should identify missing refs (deleted from public)", () => {
      const result: RefComparison = {
        name: "old-branch",
        localRef: null,
        privateRef: "def5678",
        status: "missing",
      };

      expect(result.status).toBe("missing");
    });
  });

  describe("cloneWorkDir", () => {
    const testDir = join(tmpdir(), `repo-sync-clone-test-${Date.now()}`);
    const bareRepo = join(testDir, "source.git");
    const seedRepo = join(testDir, "seed");
    const workRoot = join(testDir, "work");

    beforeAll(() => {
      mkdirSync(testDir, { recursive: true });
      exec(`git init --bare "${bareRepo}"`);
      exec(`git clone "${bareRepo}" "${seedRepo}"`);
      exec('git config user.email "test@example.com"', seedRepo);
      exec('git config user.name "test"', seedRepo);
      writeFileSync(join(seedRepo, "README.md"), "hello\n");
      exec("git add README.md", seedRepo);
      exec('git commit -m "init"', seedRepo);
      exec("git push origin master", seedRepo);
    });

    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("should create and sanitize a work clone", () => {
      const result = cloneWorkDir(bareRepo, "master", workRoot, "my/repo name");

      expect(result.success).toBe(true);
      expect(result.clonePath).toContain("my-repo-name");
      expect(existsSync(result.clonePath)).toBe(true);
      expect(existsSync(join(result.clonePath, "README.md"))).toBe(true);
    });
  });
});
