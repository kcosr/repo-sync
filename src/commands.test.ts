import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jest } from "@jest/globals";
import { parseArgs, run } from "./commands.js";
import { SourceRepo, git, initBare, makeTempDir } from "./testing/fixtures.js";

describe("commands", () => {
  describe("parseArgs", () => {
    it("parses import options", () => {
      expect(parseArgs(["import", "tool", "--archive", "a.zip"])).toMatchObject({
        command: "import",
        repoName: "tool",
        archive: "a.zip",
      });
    });

    it("rejects unknown options, missing values and extra arguments", () => {
      expect(() => parseArgs(["pull", "--forse"])).toThrow("Unknown option: --forse");
      expect(() => parseArgs(["import", "tool", "--archive"])).toThrow("requires a value");
      expect(() => parseArgs(["pull", "a", "b"])).toThrow("Unexpected argument: b");
    });

    it.each(["--commit", "--branch"])("rejects the removed %s option", (option) => {
      expect(() => parseArgs(["import", "tool", "--archive", "a.zip", option, "main"])).toThrow(
        `Unknown option: ${option}`,
      );
    });

    it("rejects import options on other commands", () => {
      expect(() => parseArgs(["pull", "--archive", "a.zip"])).toThrow("only valid with 'import'");
    });
  });

  describe("run", () => {
    let root: string;
    let cacheDir: string;
    let configPath: string;
    let output: string[];

    beforeEach(() => {
      root = makeTempDir("commands-test");
      cacheDir = join(root, "cache");
      configPath = join(root, "repo-sync.yaml");
      const capture = (...args: unknown[]) => {
        output.push(args.join(" "));
      };
      jest.spyOn(console, "log").mockImplementation(capture);
      jest.spyOn(console, "error").mockImplementation(capture);
    });

    afterEach(() => {
      jest.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    });

    function writeConfig(repos: string): void {
      writeFileSync(configPath, `cacheDir: ${cacheDir}\nrepos:\n${repos}`);
    }

    async function cli(...args: string[]): Promise<{ code: number; out: string }> {
      output = [];
      const code = await run([...args, "-c", configPath]);
      return { code, out: output.join("\n") };
    }

    function publicRepo(name: string): { source: SourceRepo; url: string } {
      const source = SourceRepo.create(join(root, `${name}-src`));
      source.commit("init", { "README.md": `# ${name}\n` });
      const url = join(root, `${name}-public.git`);
      git(root, ["clone", "--quiet", "--bare", source.path, url]);
      return { source, url };
    }

    it("validates import usage", async () => {
      const { url } = publicRepo("lib");
      writeConfig(
        `  - name: lib\n    public: ${url}\n    private: ${join(root, "lib.git")}\n  - name: tool\n    source: archive\n    private: ${join(root, "tool.git")}\n`,
      );

      expect((await cli("import")).out).toContain("import requires a repository name");
      expect((await cli("import", "lib", "--archive", "x.zip")).out).toContain(
        "pulls from a public remote; set 'source: archive'",
      );
      expect((await cli("import", "tool")).out).toContain("import requires --archive");
      const missing = await cli("import", "tool", "--archive", "missing.zip");
      expect(missing.code).toBe(1);
      expect(missing.out).toContain("Import rejected:");
      expect((await cli("bogus")).out).toContain("Unknown command: bogus");
    });

    it("skips archive-managed entries in broad pulls and refuses them by name", async () => {
      const { url } = publicRepo("lib");
      writeConfig(
        `  - name: lib\n    public: ${url}\n    private: ${join(root, "lib.git")}\n  - name: tool\n    source: archive\n    private: ${join(root, "tool.git")}\n`,
      );

      const broad = await cli("pull");
      const named = await cli("pull", "tool");

      expect(broad.code).toBe(0);
      expect(broad.out).toContain(
        "tool:\n  - Skipped (archive-managed; update with 'repo-sync import')",
      );
      expect(broad.out).toContain(
        "Pull complete: 1 succeeded, 0 failed, 1 skipped (archive-managed)",
      );
      expect(existsSync(join(cacheDir, "repos", "tool.git"))).toBe(false);
      expect(named.code).toBe(1);
      expect(named.out).toContain(
        "'tool' is archive-managed; update it with 'repo-sync import tool",
      );
    });

    it("runs import → status → push → clone without deleting or force-updating private refs", async () => {
      const source = SourceRepo.create(join(root, "upstream-src"));
      const first = source.commit("init", { "README.md": "# tool\n" });
      source.git("branch", "legacy");
      source.git("tag", "v1");
      const destination = initBare(join(root, "destination-name.git"));
      writeConfig(`  - name: local-id\n    source: archive\n    private: ${destination}\n`);
      const importZip = async (zip: string) => cli("import", "local-id", "--archive", zip);
      const cache = join(cacheDir, "repos", "local-id.git");

      const firstZip = source.archive(join(root, "v1.zip"));
      const imported = await importZip(firstZip);
      expect(imported.code).toBe(0);
      expect(imported.out).toContain("✓ Imported");
      const refsBefore = git(cache, ["for-each-ref"]);
      expect((await importZip(firstZip)).code).toBe(0);
      expect(git(cache, ["for-each-ref"])).toBe(refsBefore);

      const fresh = await cli("status", "local-id");
      expect(fresh.out).toContain("Source:  archive import");
      expect(fresh.out).toContain(`main: ${first.slice(0, 7)} (new)`);
      expect(fresh.out).toContain(`legacy: ${first.slice(0, 7)} (new)`);
      expect(fresh.out).toContain(`v1: ${first.slice(0, 7)} (new)`);

      expect((await cli("push", "local-id")).code).toBe(0);
      expect(git(destination, ["rev-parse", "main"])).toBe(first);
      expect(git(destination, ["rev-parse", "legacy", "v1"])).toBe(`${first}\n${first}`);
      expect((await cli("status", "local-id")).out).toContain("Up to date ✓");

      expect((await cli("clone", "local-id")).code).toBe(0);
      expect(git(join(cacheDir, "work", "local-id"), ["rev-parse", "HEAD"])).toBe(first);

      // A branch that only exists on private is reported and kept.
      git(destination, ["update-ref", "refs/heads/private-only", first]);
      const second = source.commit("second", { "a.txt": "a\n" });
      source.git("branch", "release");
      source.git("tag", "-a", "v2", "-m", "Release 2");
      const secondTag = source.git("rev-parse", "refs/tags/v2");
      source.git("branch", "-D", "legacy");
      source.git("tag", "-d", "v1");
      expect((await importZip(source.archive(join(root, "v2.zip")))).out).toContain("✓ Updated");
      // Missing branches and tags survive later archives, alongside newly imported refs.
      expect(
        git(cache, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]).split("\n"),
      ).toEqual([
        "refs/heads/legacy",
        "refs/heads/main",
        "refs/heads/release",
        "refs/tags/v1",
        "refs/tags/v2",
      ]);
      const ahead = await cli("status", "local-id");
      expect(ahead.out).toContain("(+1 commits)");
      expect(ahead.out).toContain(
        "Kept on private (not managed by imports):\n    branch private-only",
      );
      expect((await cli("push", "local-id")).code).toBe(0);
      expect(git(destination, ["rev-parse", "main"])).toBe(second);
      expect(git(destination, ["rev-parse", "private-only"])).toBe(first);
      expect(git(destination, ["rev-parse", "legacy", "v1"])).toBe(`${first}\n${first}`);
      expect(git(destination, ["rev-parse", "release"])).toBe(second);
      expect(git(destination, ["rev-parse", "refs/tags/v2"])).toBe(secondTag);
      expect((await cli("clone", "local-id")).code).toBe(0);
      expect(
        git(join(cacheDir, "work", "local-id"), ["rev-parse", "refs/remotes/origin/release"]),
      ).toBe(second);

      // Commits that only exist on private are never overwritten.
      const tree = git(destination, ["rev-parse", "main^{tree}"]);
      const divergent = git(destination, ["commit-tree", tree, "-p", second, "-m", "private only"]);
      git(destination, ["update-ref", "refs/heads/main", divergent]);
      const third = source.commit("third", { "b.txt": "b\n" });
      await importZip(source.archive(join(root, "v3.zip")));
      const refused = await cli("push", "local-id");
      expect(refused.code).toBe(1);
      expect(refused.out).toContain("diverged");
      expect(git(destination, ["rev-parse", "main"])).toBe(divergent);

      // Moving the private URL in repo-sync.yaml takes effect on the next status or push.
      const moved = initBare(join(root, "moved.git"));
      writeConfig(`  - name: local-id\n    source: archive\n    private: ${moved}\n`);
      expect((await cli("push", "local-id")).code).toBe(0);
      expect(git(moved, ["rev-parse", "main"])).toBe(third);

      // An unreachable destination is an error, never "up to date" from stale tracking refs.
      writeConfig(
        `  - name: local-id\n    source: archive\n    private: ${join(root, "missing.git")}\n`,
      );
      const unreachable = await cli("push", "local-id");
      expect(unreachable.code).toBe(1);
      expect(unreachable.out).toContain("Could not fetch from private");
      expect((await cli("status", "local-id")).out).toContain("Status:  Unknown (see errors)");
    });

    it("preserves dirty files and local commits in archive work clones", async () => {
      const source = SourceRepo.create(join(root, "upstream-src"));
      const first = source.commit("init", { "README.md": "# tool\n" });
      writeConfig(`  - name: tool\n    source: archive\n    private: ${join(root, "tool.git")}\n`);
      expect(
        (await cli("import", "tool", "--archive", source.archive(join(root, "v1.zip")))).code,
      ).toBe(0);
      expect((await cli("clone", "tool")).code).toBe(0);
      const work = SourceRepo.open(join(cacheDir, "work", "tool"));
      work.write("README.md", "local edits\n");
      const second = source.commit("second", { "README.md": "upstream edits\n" });

      expect(
        (await cli("import", "tool", "--archive", source.archive(join(root, "v2.zip")))).code,
      ).toBe(0);
      expect(work.head()).toBe(first);
      expect(work.git("diff")).toContain("local edits");
      expect((await cli("clone", "tool")).code).toBe(1);
      expect(work.git("diff")).toContain("local edits");

      work.git("restore", "README.md");
      expect((await cli("clone", "tool")).code).toBe(0);
      expect(work.head()).toBe(second);
      const local = work.commit("local commit", { "local.txt": "keep me\n" });
      source.commit("third", { "next.txt": "upstream\n" });
      expect(
        (await cli("import", "tool", "--archive", source.archive(join(root, "v3.zip")))).code,
      ).toBe(0);
      expect(work.head()).toBe(local);
      expect((await cli("clone", "tool")).code).toBe(1);
      expect(work.head()).toBe(local);
    });

    it("keeps the remote workflow unchanged: pull → status → push with prune → clone", async () => {
      const { source, url } = publicRepo("lib");
      source.git("branch", "feature");
      source.git("tag", "v1.0.0");
      git(root, ["--git-dir", url, "fetch", "--quiet", source.path, "+refs/*:refs/*"]);
      const mirror = initBare(join(root, "lib-mirror.git"));
      writeConfig(`  - name: lib\n    public: ${url}\n    private: ${mirror}\n`);

      expect((await cli("pull")).out).toContain("✓ Cloned");
      const status = await cli("status");
      expect(status.out).toContain(`Public:  ${url}`);
      expect(status.out).toContain("feature:");
      expect(status.out).toContain("v1.0.0");
      expect((await cli("push")).code).toBe(0);
      expect(git(mirror, ["for-each-ref", "--format=%(refname)"]).split("\n").sort()).toEqual([
        "refs/heads/feature",
        "refs/heads/main",
        "refs/tags/v1.0.0",
      ]);

      git(url, ["branch", "-D", "feature"]);
      expect((await cli("pull")).out).toContain("✓ Updated");
      const pruned = await cli("status");
      expect(pruned.out).toContain("feature: deleted from public");
      expect(pruned.out).not.toContain("HEAD:");
      expect((await cli("push")).code).toBe(0);
      expect(git(mirror, ["for-each-ref", "--format=%(refname)"]).split("\n").sort()).toEqual([
        "refs/heads/main",
        "refs/tags/v1.0.0",
      ]);
      expect((await cli("clone", "lib")).code).toBe(0);
    });

    it("refuses to pull into a cache that was created by import", async () => {
      const source = SourceRepo.create(join(root, "tool-src"));
      source.commit("init", { "README.md": "# tool\n" });
      writeConfig(`  - name: tool\n    source: archive\n    private: ${join(root, "tool.git")}\n`);
      await cli("import", "tool", "--archive", source.archive(join(root, "t.zip")));
      const { url } = publicRepo("other");
      writeConfig(`  - name: tool\n    public: ${url}\n    private: ${join(root, "tool.git")}\n`);

      const result = await cli("pull", "tool");

      expect(result.code).toBe(1);
      expect(result.out).toContain("Cache was created by 'repo-sync import'");
    });
  });
});
