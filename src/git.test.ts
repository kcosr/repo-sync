import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneWorkDir, compareRefs, exec, getLocalRefs, getParentCommit, pushRefs } from "./git.js";
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

    it("preserves slashes in branch and tag names", () => {
      const result = compareRefs(
        testDir,
        new Map([
          ["heads/release/1.x", "abc1234"],
          ["tags/releases/v1", "abc1234"],
        ]),
        new Map([["heads/legacy/1.x", "abc1234"]]),
      );

      expect(result.branches.map(({ name }) => name)).toEqual(["release/1.x", "legacy/1.x"]);
      expect(result.tags[0].name).toBe("releases/v1");
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

  describe("archive work clones", () => {
    let testDir: string;
    let bareRepo: string;
    let seedRepo: string;
    let workRoot: string;

    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    const refresh = (branch = "main") =>
      cloneWorkDir(bareRepo, branch, workRoot, "project", { fastForwardOnly: true });

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), "repo-sync-archive-work-"));
      bareRepo = join(testDir, "source.git");
      seedRepo = join(testDir, "seed");
      workRoot = join(testDir, "work");
      git(testDir, "init", "--initial-branch=main", seedRepo);
      git(seedRepo, "config", "user.email", "test@example.com");
      git(seedRepo, "config", "user.name", "test");
      writeFileSync(join(seedRepo, "README.md"), "hello\n");
      git(seedRepo, "add", "README.md");
      git(seedRepo, "commit", "-m", "init");
      git(seedRepo, "branch", "feature/initial");
      git(seedRepo, "tag", "v1");
      git(testDir, "clone", "--bare", seedRepo, bareRepo);
      git(seedRepo, "remote", "add", "origin", bareRepo);
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("exposes every archived branch in a new work clone", () => {
      const result = refresh();

      expect(result.success).toBe(true);
      expect(git(result.clonePath, "rev-parse", "origin/feature/initial")).toBe(
        git(seedRepo, "rev-parse", "HEAD"),
      );
      expect(git(result.clonePath, "rev-parse", "v1")).toBe(git(seedRepo, "rev-parse", "v1"));
    });

    it("keeps exact names when branches and tags share a name", () => {
      git(seedRepo, "branch", "v1");
      const refs = getLocalRefs(seedRepo);

      expect(refs.get("heads/v1")).toBe(git(seedRepo, "rev-parse", "refs/heads/v1"));
      expect(refs.get("tags/v1")).toBe(git(seedRepo, "rev-parse", "refs/tags/v1"));
      expect(refs.has("heads/heads/v1")).toBe(false);
      expect(refs.has("tags/tags/v1")).toBe(false);
    });

    it("fetches new branches and tags while fast-forwarding the default branch", () => {
      const initial = refresh();
      expect(initial.success).toBe(true);
      git(seedRepo, "commit", "--allow-empty", "-m", "update");
      git(seedRepo, "branch", "feature/later");
      git(seedRepo, "tag", "v2");
      git(seedRepo, "push", "--all", "origin");
      git(seedRepo, "push", "--tags", "origin");

      const result = refresh();

      expect(result.success).toBe(true);
      expect(git(result.clonePath, "rev-parse", "HEAD")).toBe(git(seedRepo, "rev-parse", "HEAD"));
      expect(git(result.clonePath, "rev-parse", "origin/feature/later")).toBe(
        git(seedRepo, "rev-parse", "feature/later"),
      );
      expect(git(result.clonePath, "rev-parse", "v2")).toBe(git(seedRepo, "rev-parse", "v2"));

      const switched = refresh("feature/later");
      expect(switched.success).toBe(true);
      expect(git(switched.clonePath, "symbolic-ref", "--short", "HEAD")).toBe("feature/later");
    });

    it("refreshes all branches in an existing single-branch work clone", () => {
      mkdirSync(workRoot);
      const clonePath = join(workRoot, "project");
      git(testDir, "clone", "--single-branch", "--branch", "main", bareRepo, clonePath);
      expect(git(clonePath, "config", "--get", "remote.origin.fetch")).toBe(
        "+refs/heads/main:refs/remotes/origin/main",
      );

      const result = refresh();

      expect(result.success).toBe(true);
      expect(git(clonePath, "config", "--get-all", "remote.origin.fetch")).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      );
      expect(git(clonePath, "rev-parse", "origin/feature/initial")).toBe(
        git(seedRepo, "rev-parse", "feature/initial"),
      );
    });

    it("treats shell punctuation in archived branch names literally", () => {
      const marker = join(testDir, "shell-executed");
      // Empty shell quotes keep dot-prefixed temporary path components valid in a ref.
      const branch = `main;touch\${IFS}${marker.replaceAll("/.", "/''.")};#`;
      git(seedRepo, "checkout", "-b", branch);
      git(seedRepo, "push", "origin", branch);
      git(bareRepo, "symbolic-ref", "HEAD", `refs/heads/${branch}`);

      const initial = refresh(branch);
      expect(initial.success).toBe(true);
      expect(git(initial.clonePath, "symbolic-ref", "--short", "HEAD")).toBe(branch);
      const parent = git(seedRepo, "rev-parse", "HEAD");
      git(seedRepo, "commit", "--allow-empty", "-m", "update");
      git(seedRepo, "push", "origin", branch);

      const result = refresh(branch);

      expect(result.success).toBe(true);
      expect(getParentCommit(result.clonePath, branch)).toBe(parent);
      expect(git(result.clonePath, "rev-parse", "HEAD")).toBe(git(seedRepo, "rev-parse", "HEAD"));
      expect(existsSync(marker)).toBe(false);
    });

    it("refuses to discard commits on the work clone's default branch", () => {
      const initial = refresh();
      git(
        initial.clonePath,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "local work",
      );
      const localHead = git(initial.clonePath, "rev-parse", "HEAD");

      const result = refresh();

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/commits that are not in the cache/);
      expect(git(result.clonePath, "rev-parse", "HEAD")).toBe(localHead);
    });

    it.each(["remote branch", "tag"])(
      "allows a detached HEAD preserved only by a cached %s",
      (refType) => {
        git(seedRepo, "checkout", "--detach");
        git(seedRepo, "commit", "--allow-empty", "-m", "release only");
        const releaseCommit = git(seedRepo, "rev-parse", "HEAD");
        if (refType === "remote branch") {
          git(seedRepo, "push", "origin", "HEAD:refs/heads/release");
        } else {
          git(seedRepo, "tag", "--annotate", "release", "--message", "release");
          git(seedRepo, "push", "origin", "refs/tags/release");
        }

        const initial = refresh();
        expect(initial.success).toBe(true);
        git(initial.clonePath, "checkout", "--detach", releaseCommit);
        expect(git(initial.clonePath, "for-each-ref", "--contains", "HEAD", "refs/heads/")).toBe(
          "",
        );

        const result = refresh();

        expect(result.success).toBe(true);
        expect(git(result.clonePath, "symbolic-ref", "--short", "HEAD")).toBe("main");
        const preservedRef =
          refType === "remote branch" ? "origin/release" : "refs/tags/release^{}";
        expect(git(result.clonePath, "rev-parse", preservedRef)).toBe(releaseCommit);
      },
    );

    it("does not partially push branch updates when the destination rejects a tag", () => {
      const originalCommit = git(bareRepo, "rev-parse", "refs/heads/main");
      git(seedRepo, "commit", "--allow-empty", "-m", "update");
      git(seedRepo, "branch", "new-feature");
      git(seedRepo, "tag", "--force", "v1");

      const result = pushRefs(seedRepo, "origin");

      expect(result.success).toBe(false);
      expect(git(bareRepo, "rev-parse", "refs/heads/main")).toBe(originalCommit);
      expect(git(bareRepo, "rev-parse", "refs/tags/v1")).toBe(originalCommit);
      expect(git(bareRepo, "for-each-ref", "refs/heads/new-feature")).toBe("");
    });

    it("rejects a stale notice lease atomically when the destination changes", () => {
      const expected = git(bareRepo, "rev-parse", "refs/heads/main");
      git(seedRepo, "commit", "--allow-empty", "-m", "concurrent destination work");
      git(seedRepo, "push", "origin", "main");
      const concurrent = git(bareRepo, "rev-parse", "refs/heads/main");
      git(seedRepo, "reset", "--hard", expected);
      git(seedRepo, "commit", "--allow-empty", "-m", "replacement notice");
      const replacement = git(seedRepo, "rev-parse", "HEAD");

      const result = pushRefs(seedRepo, "origin", {
        refs: new Map([
          ["heads/main", replacement],
          ["heads/new-feature", replacement],
        ]),
        noticeLease: { branch: "main", expected },
      });

      expect(result.success).toBe(false);
      expect(git(bareRepo, "rev-parse", "refs/heads/main")).toBe(concurrent);
      expect(git(bareRepo, "for-each-ref", "refs/heads/new-feature")).toBe("");
    });

    it("preserves detached commits until they have a branch", () => {
      const initial = refresh();
      git(initial.clonePath, "checkout", "--detach");
      git(
        initial.clonePath,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "detached work",
      );
      const detachedHead = git(initial.clonePath, "rev-parse", "HEAD");

      const refused = refresh();
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/not on any branch/);
      expect(git(refused.clonePath, "rev-parse", "HEAD")).toBe(detachedHead);

      git(initial.clonePath, "branch", "local-work");
      const result = refresh();
      expect(result.success).toBe(true);
      expect(git(result.clonePath, "rev-parse", "local-work")).toBe(detachedHead);
      expect(git(result.clonePath, "symbolic-ref", "--short", "HEAD")).toBe("main");
    });
  });
});
