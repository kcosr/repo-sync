import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { jest } from "@jest/globals";
import { DEFAULT_ARCHIVE_LIMITS, getImportLogPath, getRepoTempPath } from "./config.js";
import { type ImportResult, importArchive, readImportHistory } from "./import.js";
import { clone } from "./sync.js";
import { SourceRepo, git, initBare, makeTempDir } from "./testing/fixtures.js";
import type { ZipEntrySpec } from "./testing/zip-writer.js";
import type { ArchiveRepoConfig } from "./types.js";

const HOOKS = [
  "pre-commit",
  "post-checkout",
  "post-index-change",
  "reference-transaction",
  "pre-auto-gc",
  "post-rewrite",
  "post-merge",
  "pre-push",
  "fsmonitor-watchman",
  "push-to-checkout",
  "pre-receive",
  "update",
  "post-receive",
  "post-update",
];

function corrupt(data: ZipEntrySpec["data"]): Buffer {
  const copy = Buffer.from(data as Buffer);
  for (let i = 32; i < copy.length - 32; i += 7) {
    copy[i] ^= 0xff;
  }
  return copy;
}

describe("importArchive", () => {
  let root: string;
  let cacheDir: string;
  let privateRepo: string;
  let zipCount = 0;

  beforeEach(() => {
    root = makeTempDir("import-test");
    cacheDir = join(root, "cache");
    privateRepo = initBare(join(root, "private.git"));
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const entry = (name = "tool"): ArchiveRepoConfig => ({
    name,
    source: "archive",
    private: privateRepo,
  });
  const cachePath = () => getRepoTempPath("tool", cacheDir);
  const zipPath = () => join(root, `archive-${zipCount++}.zip`);

  function runImport(
    zip: string,
    commit: string,
    branch = "main",
    repo = entry(),
    cache = cacheDir,
  ) {
    return importArchive(
      repo,
      { archivePath: zip, commit, branch },
      { cacheDir: cache, limits: DEFAULT_ARCHIVE_LIMITS },
    );
  }

  function cacheRef(ref: string): string | null {
    try {
      return git(cachePath(), ["rev-parse", "--verify", "--quiet", ref]);
    } catch {
      return null;
    }
  }

  function stagingEntries(): string[] {
    const dir = join(cacheDir, "staging");
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  function expectRejected(result: ImportResult, message: RegExp): void {
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect(stagingEntries()).toEqual([]);
  }

  function sourceRepo(name = "tool-src"): SourceRepo {
    return SourceRepo.create(join(root, "sources", name));
  }

  /** Packed history plus a newer loose commit, as a real checkout would have. */
  function standardRepo(): { repo: SourceRepo; commits: string[] } {
    const repo = sourceRepo();
    const commits = [
      repo.commit("initial", { "README.md": "# tool\n", "src/main.ts": "export {};\n" }),
      repo.commit("second", { "src/util.ts": "export const x = 1;\n" }),
    ];
    repo.git("gc", "--quiet");
    commits.push(repo.commit("third", { "CHANGELOG.md": "## 1.0\n" }));
    return { repo, commits };
  }

  describe("successful imports", () => {
    it("seeds a new cache with the verified commit, its history and original commit IDs", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath());
      const before = readFileSync(zip);
      const mtime = statSync(zip).mtimeMs;

      const result = await runImport(zip, commits[2]);

      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe("created");
      expect(result.repoPath).toBe(cachePath());
      expect(git(cachePath(), ["rev-list", "main"]).split("\n")).toEqual([...commits].reverse());
      expect(git(cachePath(), ["ls-tree", "-r", "main"])).toBe(repo.git("ls-tree", "-r", "main"));
      expect(git(cachePath(), ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
      expect(git(cachePath(), ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
      expect(git(cachePath(), ["config", "--get", "repo-sync.source"])).toBe("archive");
      expect(git(cachePath(), ["config", "--get", "remote.private.url"])).toBe(privateRepo);
      expect(git(cachePath(), ["remote"])).toBe("private");
      git(cachePath(), ["fsck", "--full", "--strict"]);
      expect(readFileSync(zip).equals(before)).toBe(true);
      expect(statSync(zip).mtimeMs).toBe(mtime);
      expect(stagingEntries()).toEqual([]);
      expect(git(privateRepo, ["for-each-ref"])).toBe("");
    });

    it("records provenance outside the source tree", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath());

      const result = await runImport(zip, commits[2]);
      const history = readImportHistory("tool", cacheDir);

      expect(result.provenancePath).toBe(getImportLogPath("tool", cacheDir));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        repo: "tool",
        result: "created",
        commit: commits[2],
        branch: "main",
        previousCommit: null,
        archive: {
          path: zip,
          sha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
          size: statSync(zip).size,
          root: "tool-src",
          head: "refs/heads/main",
        },
        validation: { passed: true },
      });
      expect(history[0].validation.checks).toEqual(
        expect.arrayContaining([
          "archive-structure",
          "self-contained-layout",
          "head-matches-commit",
          "object-integrity",
          "complete-history",
          "clean-source-tree",
        ]),
      );
      expect(Number.isNaN(Date.parse(history[0].importedAt))).toBe(false);
    });

    it("associates a detached-HEAD archive with the requested branch", async () => {
      const repo = sourceRepo();
      repo.commit("on main", { "a.txt": "a\n" });
      repo.git("checkout", "--quiet", "--detach");
      const detached = repo.commit("detached only", { "b.txt": "b\n" });

      const result = await runImport(repo.archive(zipPath()), detached, "release/1.x");

      expect(result.error).toBeUndefined();
      expect(result.record?.archive.head).toBe("detached");
      expect(cacheRef("refs/heads/release/1.x")).toBe(detached);
      expect(cacheRef("refs/heads/main")).toBeNull();
      expect(git(cachePath(), ["symbolic-ref", "HEAD"])).toBe("refs/heads/release/1.x");
    });

    it("keeps the local identifier independent of the archive and destination names", async () => {
      const repo = sourceRepo("upstream-src");
      const commit = repo.commit("init", { "a.txt": "a\n" });
      const destination = initBare(join(root, "destination-name.git"));
      const local: ArchiveRepoConfig = {
        name: "local-id",
        source: "archive",
        private: destination,
      };

      const result = await runImport(repo.archive(zipPath()), commit, "main", local);

      expect(result.error).toBeUndefined();
      expect(result.repoPath).toBe(join(cacheDir, "repos", "local-id.git"));
      expect(result.provenancePath).toBe(join(cacheDir, "imports", "local-id.jsonl"));
      expect(result.record?.archive.root).toBe("upstream-src");
      expect(git(result.repoPath, ["config", "--get", "remote.private.url"])).toBe(destination);
      expect(readdirSync(join(cacheDir, "repos"))).toEqual(["local-id.git"]);
    });

    it("accepts an untracked ARCHIVE-INFO.json beside .git", async () => {
      const repo = sourceRepo();
      const commit = repo.commit("init", { "a.txt": "a\n" });
      repo.write("ARCHIVE-INFO.json", JSON.stringify({ source_commit: commit }));

      const result = await runImport(repo.archive(zipPath()), commit);

      expect(result.error).toBeUndefined();
      expect(git(cachePath(), ["ls-tree", "--name-only", "main"])).toBe("a.txt");
    });

    it("imports only the selected history, not other archived branches or tags", async () => {
      const repo = sourceRepo();
      const base = repo.commit("base", { "a.txt": "a\n" });
      repo.git("checkout", "--quiet", "-b", "feature");
      const feature = repo.commit("feature work", { "f.txt": "f\n" });
      repo.git("tag", "-a", "-m", "release", "v1.0.0");
      repo.git("checkout", "--quiet", "main");

      const result = await runImport(repo.archive(zipPath()), base);

      expect(result.error).toBeUndefined();
      expect(git(cachePath(), ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
      expect(() => git(cachePath(), ["cat-file", "-e", feature])).toThrow();
    });

    it("resolves a relative cacheDir before running Git", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath());
      const relativeCache = relative(process.cwd(), cacheDir);

      const first = await runImport(zip, commits[2], "main", entry(), relativeCache);
      const again = await runImport(zip, commits[2], "main", entry(), relativeCache);

      expect(first.error).toBeUndefined();
      expect(again.outcome).toBe("unchanged");
      expect(first.repoPath).toBe(cachePath());
      expect(cacheRef("refs/heads/main")).toBe(commits[2]);
    });

    it("imports SHA-256 repositories", async () => {
      const repo = SourceRepo.create(join(root, "sources", "sha256-src"), {
        objectFormat: "sha256",
      });
      const commit = repo.commit("init", { "a.txt": "a\n" });

      const result = await runImport(repo.archive(zipPath()), commit);

      expect(commit).toHaveLength(64);
      expect(result.error).toBeUndefined();
      expect(git(cachePath(), ["rev-parse", "--show-object-format"])).toBe("sha256");
      expect(cacheRef("refs/heads/main")).toBe(commit);
    });
  });

  describe("repeated imports", () => {
    it("reports an identical reimport as unchanged and leaves the cache as it was", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath());
      await runImport(zip, commits[2]);
      const refs = git(cachePath(), ["for-each-ref"]);

      const result = await runImport(zip, commits[2]);

      expect(result.success).toBe(true);
      expect(result.outcome).toBe("unchanged");
      expect(git(cachePath(), ["for-each-ref"])).toBe(refs);
      expect(readImportHistory("tool", cacheDir).map((r) => r.result)).toEqual([
        "created",
        "unchanged",
      ]);
      expect(stagingEntries()).toEqual([]);
    });

    it("fast-forwards to a newer archive and records the previous commit", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      repo.commit("fourth", { "d.txt": "d\n" });
      const latest = repo.commit("fifth", { "e.txt": "e\n" });

      const result = await runImport(repo.archive(zipPath()), latest);

      expect(result.outcome).toBe("fast-forward");
      expect(result.aheadCount).toBe(2);
      expect(result.record?.previousCommit).toBe(commits[2]);
      expect(cacheRef("refs/heads/main")).toBe(latest);
    });

    it("keeps previously imported branches that a later archive no longer contains", async () => {
      const repo = sourceRepo();
      repo.commit("base", { "a.txt": "a\n" });
      repo.git("checkout", "--quiet", "-b", "legacy");
      const legacy = repo.commit("legacy", { "l.txt": "l\n" });
      await runImport(repo.archive(zipPath()), legacy, "legacy");
      repo.git("checkout", "--quiet", "main");
      repo.git("branch", "--quiet", "-D", "legacy");
      const main = repo.commit("main", { "m.txt": "m\n" });

      const result = await runImport(repo.archive(zipPath()), main, "main");

      expect(result.outcome).toBe("created");
      expect(cacheRef("refs/heads/legacy")).toBe(legacy);
      expect(cacheRef("refs/heads/main")).toBe(main);
      expect(git(cachePath(), ["symbolic-ref", "HEAD"])).toBe("refs/heads/legacy");
    });
  });

  describe("history requirements", () => {
    it("rejects shallow archives", async () => {
      const { repo } = standardRepo();
      const shallowPath = join(root, "sources", "shallow");
      git(root, ["clone", "--quiet", "--depth", "1", `file://${repo.path}`, shallowPath]);
      const shallow = SourceRepo.open(shallowPath);

      const result = await runImport(shallow.archive(zipPath()), shallow.head());

      expectRejected(result, /contains shallow: shallow history is not self-contained/);
      expect(existsSync(cachePath())).toBe(false);
    });

    it("rejects archives that borrow objects through alternates", async () => {
      const { repo } = standardRepo();
      const sharedPath = join(root, "sources", "shared");
      git(root, ["clone", "--quiet", "--shared", repo.path, sharedPath]);
      const shared = SourceRepo.open(sharedPath);

      const result = await runImport(shared.archive(zipPath()), shared.head());

      expectRejected(result, /alternates are not self-contained/);
    });

    it("rejects linked worktrees that point at another checkout", async () => {
      const { repo, commits } = standardRepo();
      const linkedPath = join(root, "sources", "linked");
      repo.git("worktree", "add", "--quiet", "--detach", linkedPath);

      const result = await runImport(SourceRepo.open(linkedPath).archive(zipPath()), commits[2]);

      expectRejected(result, /worktree pointer file/);
    });

    it("rejects a linked worktree's git directory copied in place", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath(), {
        transform: (entries) => [...entries, { name: "tool-src/.git/commondir", data: "../..\n" }],
      });

      const result = await runImport(zip, commits[2]);

      expectRejected(result, /linked worktree that depends on another checkout/);
    });

    it("rejects history with missing objects", async () => {
      const repo = sourceRepo();
      const first = repo.commit("one", { "a.txt": "a\n" });
      const second = repo.commit("two", { "b.txt": "b\n" });
      const missing = `/.git/objects/${first.slice(0, 2)}/${first.slice(2)}`;
      const zip = repo.archive(zipPath(), {
        transform: (entries) => entries.filter((e) => !e.name.endsWith(missing)),
      });

      const result = await runImport(zip, second);

      expectRejected(result, new RegExp(`incomplete or corrupt: .*missing commit ${first}`));
    });

    it("rejects corrupt packs", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath(), {
        transform: (entries) =>
          entries.map((e) => (e.name.endsWith(".pack") ? { ...e, data: corrupt(e.data) } : e)),
      });

      const result = await runImport(zip, commits[2]);

      expectRejected(result, /failed verification/);
    });

    it("rejects archives without a Git directory", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath(), {
        transform: (entries) => entries.filter((e) => !e.name.startsWith("tool-src/.git/")),
      });

      expectRejected(await runImport(zip, commits[2]), /does not contain a Git repository/);
    });

    it("rejects nested Git directories", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath(), {
        transform: (entries) => [
          ...entries,
          { name: "tool-src/vendor/lib/.git/HEAD", data: "ref: refs/heads/main\n" },
        ],
      });

      expectRejected(await runImport(zip, commits[2]), /nested Git directory/);
    });

    it("rejects symlinks inside the Git directory", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath(), {
        transform: (entries) => [
          ...entries,
          { name: "tool-src/.git/objects/info/link", data: "../../README.md", mode: 0o120777 },
        ],
      });

      expectRejected(await runImport(zip, commits[2]), /Git directory contains a symlink/);
    });
  });

  describe("commit verification", () => {
    it("rejects an archive whose HEAD is not the expected commit", async () => {
      const { repo, commits } = standardRepo();

      const result = await runImport(repo.archive(zipPath()), commits[1]);

      expectRejected(
        result,
        new RegExp(
          `HEAD \\(refs/heads/main\\) is ${commits[2]}, not the expected commit ${commits[1]}`,
        ),
      );
      expect(readImportHistory("tool", cacheDir)[0]).toMatchObject({
        result: "rejected",
        validation: { passed: false },
      });
    });

    it("rejects a commit that the archive does not contain", async () => {
      const { repo } = standardRepo();

      const result = await runImport(repo.archive(zipPath()), "0123456789".repeat(4));

      expectRejected(result, /not the expected commit 0123456789/);
    });

    it("rejects an archive whose HEAD names an unborn branch", async () => {
      const repo = sourceRepo();
      const commit = repo.commit("init", { "a.txt": "a\n" });
      repo.git("symbolic-ref", "HEAD", "refs/heads/unborn");

      expectRejected(
        await runImport(repo.archive(zipPath()), commit),
        /does not point to a commit/,
      );
    });

    it("validates the commit and branch arguments without recording an attempt", async () => {
      const missing = join(root, "missing.zip");

      const short = await runImport(missing, "abc1234");
      const badBranch = await runImport(missing, "a".repeat(40), "bad..name");
      const optionLike = await runImport(missing, "a".repeat(40), "--force");

      expect(short.error).toMatch(/full 40- or 64-character/);
      expect(badBranch.error).toMatch(/not a valid branch name/);
      expect(optionLike.error).toMatch(/not a valid branch name/);
      expect(existsSync(getImportLogPath("tool", cacheDir))).toBe(false);
      expect(stagingEntries()).toEqual([]);
    });

    it("records a rejected attempt for a missing archive", async () => {
      const result = await runImport(join(root, "missing.zip"), "a".repeat(40));

      expectRejected(result, /Archive not found/);
      expect(readImportHistory("tool", cacheDir)[0].archive.sha256).toBeNull();
    });
  });

  describe("clean source tree", () => {
    it.each<[string, (repo: SourceRepo) => void, RegExp]>([
      ["a modified tracked file", (r) => r.write("README.md", "changed\n"), / M README\.md/],
      ["an untracked file", (r) => r.write("notes.txt", "scratch\n"), /\?\? notes\.txt/],
      [
        "a deleted tracked file",
        (r) => unlinkSync(join(r.path, "src/main.ts")),
        / D src\/main\.ts/,
      ],
      [
        "a changed executable bit",
        (r) => chmodSync(join(r.path, "README.md"), 0o755),
        / M README\.md/,
      ],
      [
        "a staged but uncommitted change",
        (r) => {
          r.write("README.md", "staged\n");
          r.git("add", "README.md");
        },
        / M README\.md/,
      ],
      [
        "ARCHIVE-INFO.json below the repository root",
        (r) => r.write("src/ARCHIVE-INFO.json", "{}"),
        /\?\? src\/ARCHIVE-INFO\.json/,
      ],
    ])("rejects %s", async (_label, mutate, expected) => {
      const { repo, commits } = standardRepo();
      mutate(repo);

      const result = await runImport(repo.archive(zipPath()), commits[2]);

      expectRejected(result, /does not match commit/);
      expect(result.error).toMatch(expected);
      expect(existsSync(cachePath())).toBe(false);
    });
  });

  describe("hostile archives", () => {
    it("never executes archive-supplied configuration, hooks or filters", async () => {
      const sentinels = join(root, "sentinels");
      mkdirSync(sentinels);
      const evil = join(root, "evil.sh");
      writeFileSync(evil, `#!/bin/sh\ntouch "${sentinels}/ran-$$"\n`, { mode: 0o755 });
      const repo = sourceRepo();
      repo.write(".gitattributes", "* filter=evil diff=evil merge=evil\n");
      const commit = repo.commit("init", { "README.md": "# hi\n" });
      const gitDir = join(repo.path, ".git");
      writeFileSync(join(gitDir, "evil.config"), `[core]\n\tfsmonitor = ${evil}\n`);
      mkdirSync(join(gitDir, "info"), { recursive: true });
      writeFileSync(join(gitDir, "info", "attributes"), "* filter=evil\n");
      mkdirSync(join(gitDir, "hooks"), { recursive: true });
      for (const hook of HOOKS) {
        writeFileSync(join(gitDir, "hooks", hook), `#!/bin/sh\n"${evil}"\n`, { mode: 0o755 });
      }
      appendFileSync(
        join(gitDir, "config"),
        `[core]
\tfsmonitor = ${evil}
\thooksPath = .git/hooks
\tpager = ${evil}
\teditor = ${evil}
\taskPass = ${evil}
\tsshCommand = ${evil}
\talternateRefsCommand = ${evil}
\tworktree = ${join(root, "elsewhere")}
[include]
\tpath = evil.config
[filter "evil"]
\tclean = ${evil}
\tsmudge = ${evil}
\tprocess = ${evil}
\trequired = true
[diff "evil"]
\ttextconv = ${evil}
[diff]
\texternal = ${evil}
[merge "evil"]
\tdriver = ${evil}
[uploadpack]
\tpackObjectsHook = ${evil}
[credential]
\thelper = !${evil}
[protocol]
\tallow = always
[remote "origin"]
\turl = ext::${evil}
\tuploadpack = ${evil}
\tfetch = +refs/heads/*:refs/remotes/origin/*
`,
      );

      const result = await runImport(repo.archive(zipPath()), commit);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(git(cachePath(), ["config", "--list"])).not.toMatch(
        /fsmonitor|hookspath|filter\.|remote\.origin|include\.|uploadpack|alternaterefs|worktree/i,
      );
      expect(existsSync(join(cachePath(), "hooks"))).toBe(false);
      // Normal workflows on the imported repository do not pick up the archive's settings.
      expect(clone(entry(), { cacheDir }).success).toBe(true);
      expect(readdirSync(sentinels)).toEqual([]);
    });

    it("rejects path traversal in a source archive before extracting anything", async () => {
      const repo = sourceRepo();
      const commit = repo.commit("init", { "a.txt": "a\n" });
      const zip = repo.archive(zipPath(), {
        transform: (entries) => [...entries, { name: "tool-src/../../escaped.txt", data: "x" }],
      });

      const result = await runImport(zip, commit);

      expectRejected(result, /unsafe path: tool-src\/\.\.\/\.\.\/escaped\.txt/);
      expect(result.record?.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(cacheDir, "escaped.txt"))).toBe(false);
      expect(existsSync(join(root, "escaped.txt"))).toBe(false);
      expect(existsSync(cachePath())).toBe(false);
    });

    it("rejects worktree symlinks that escape the repository", async () => {
      const repo = sourceRepo();
      const commit = repo.commit("init", { "a.txt": "a\n" });
      const zip = repo.archive(zipPath(), {
        transform: (entries) => [
          ...entries,
          { name: "tool-src/etc", data: "../../../../etc", mode: 0o120777, method: 0 },
        ],
      });

      expectRejected(await runImport(zip, commit), /symlink escapes the archive directory/);
    });
  });

  describe("divergent updates", () => {
    it("refuses to move a branch to a diverging commit", async () => {
      const repo = sourceRepo();
      const base = repo.commit("base", { "a.txt": "a\n" });
      const ours = repo.commit("ours", { "b.txt": "b\n" });
      await runImport(repo.archive(zipPath()), ours);
      repo.git("reset", "--quiet", "--hard", base);
      const theirs = repo.commit("theirs", { "c.txt": "c\n" });

      const result = await runImport(repo.archive(zipPath()), theirs);

      expectRejected(result, /diverges from cached branch 'main'.*refusing to force-update/);
      expect(cacheRef("refs/heads/main")).toBe(ours);
    });

    it("refuses to move a branch backwards", async () => {
      const repo = sourceRepo();
      const base = repo.commit("base", { "a.txt": "a\n" });
      const ours = repo.commit("ours", { "b.txt": "b\n" });
      await runImport(repo.archive(zipPath()), ours);
      repo.git("reset", "--quiet", "--hard", base);

      const result = await runImport(repo.archive(zipPath()), base);

      expectRejected(result, /older than cached branch 'main'/);
      expect(cacheRef("refs/heads/main")).toBe(ours);
    });

    it("refuses to replace a branch with unrelated history", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      const other = sourceRepo("unrelated");
      const unrelated = other.commit("unrelated root", { "x.txt": "x\n" });

      const result = await runImport(other.archive(zipPath()), unrelated);

      expectRejected(result, /diverges from cached branch 'main'/);
      expect(cacheRef("refs/heads/main")).toBe(commits[2]);
    });
  });

  describe("failure recovery", () => {
    it("rejects the import before activation when provenance cannot be recorded", async () => {
      const { repo, commits } = standardRepo();
      mkdirSync(getImportLogPath("tool", cacheDir), { recursive: true });

      const result = await runImport(repo.archive(zipPath()), commits[2]);

      expectRejected(result, /provenance could not be written/);
      expect(existsSync(cachePath())).toBe(false);
    });

    const withDevFull = existsSync("/dev/full") ? it : it.skip;

    withDevFull("rolls back a new cache when writing provenance fails", async () => {
      const { repo, commits } = standardRepo();
      mkdirSync(join(cacheDir, "imports"), { recursive: true });
      symlinkSync("/dev/full", getImportLogPath("tool", cacheDir));

      const result = await runImport(repo.archive(zipPath()), commits[2]);

      expectRejected(result, /Failed to record provenance .*the import was rolled back/);
      expect(existsSync(cachePath())).toBe(false);
    });

    withDevFull("rolls back a branch update when writing provenance fails", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      const next = repo.commit("next", { "n.txt": "n\n" });
      const newBranch = repo.archive(zipPath());
      rmSync(getImportLogPath("tool", cacheDir));
      symlinkSync("/dev/full", getImportLogPath("tool", cacheDir));

      const updated = await runImport(newBranch, next);
      const created = await runImport(newBranch, next, "release");

      expectRejected(updated, /the import was rolled back/);
      expectRejected(created, /the import was rolled back/);
      expect(cacheRef("refs/heads/main")).toBe(commits[2]);
      expect(cacheRef("refs/heads/release")).toBeNull();
    });

    it("never rewrites an existing cache's configuration", async () => {
      const { repo, commits } = standardRepo();
      const zip = repo.archive(zipPath());
      await runImport(zip, commits[2]);
      const configBefore = readFileSync(join(cachePath(), "config"), "utf-8");
      const moved = { ...entry(), private: join(root, "moved.git") };
      const next = repo.commit("next", { "n.txt": "n\n" });
      const nextZip = repo.archive(zipPath());
      writeFileSync(join(cachePath(), "refs", "heads", "main.lock"), "");

      expect((await runImport(zip, commits[2], "main", moved)).outcome).toBe("unchanged");
      expect((await runImport(nextZip, next, "main", moved)).success).toBe(false);

      expect(readFileSync(join(cachePath(), "config"), "utf-8")).toBe(configBefore);
      expect(cacheRef("refs/heads/main")).toBe(commits[2]);
    });

    it("preserves the previous cache through rejected updates", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      const next = repo.commit("next", { "n.txt": "n\n" });
      const attempts = [
        repo.archive(zipPath(), {
          transform: (e) => [...e, { name: "tool-src/../x", data: "x" }],
        }),
        repo.archive(zipPath(), {
          transform: (e) =>
            e.map((x) => (x.name === "tool-src/README.md" ? { ...x, data: "dirty\n" } : x)),
        }),
        repo.archive(zipPath(), {
          transform: (e) =>
            e.map((x) => (x.name.endsWith(".pack") ? { ...x, data: corrupt(x.data) } : x)),
        }),
      ];

      for (const zip of attempts) {
        const result = await runImport(zip, next);
        expect(result.success).toBe(false);
        expect(cacheRef("refs/heads/main")).toBe(commits[2]);
      }

      git(cachePath(), ["fsck", "--full"]);
      expect(
        readImportHistory("tool", cacheDir).map((r) => [r.result, r.validation.passed]),
      ).toEqual([
        ["created", true],
        ["rejected", false],
        ["rejected", false],
        ["rejected", false],
      ]);
      expect(stagingEntries()).toEqual([]);
      expect((await runImport(repo.archive(zipPath()), next)).outcome).toBe("fast-forward");
    });

    it("leaves the cache unchanged when activation fails, then recovers on retry", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      const next = repo.commit("next", { "n.txt": "n\n" });
      const zip = repo.archive(zipPath());
      const lock = join(cachePath(), "refs", "heads", "main.lock");
      writeFileSync(lock, "");

      const failed = await runImport(zip, next);

      expectRejected(failed, /Failed to update cache branch/);
      expect(cacheRef("refs/heads/main")).toBe(commits[2]);
      unlinkSync(lock);
      expect((await runImport(zip, next)).outcome).toBe("fast-forward");
      expect(cacheRef("refs/heads/main")).toBe(next);
    });

    it("refuses to take over a cache that import did not create", async () => {
      const { repo, commits } = standardRepo();
      const existing = initBare(cachePath());

      const result = await runImport(repo.archive(zipPath()), commits[2]);

      expectRejected(result, /was not created by 'repo-sync import'/);
      expect(git(existing, ["for-each-ref"])).toBe("");
    });

    it("never replaces an existing path that is not a repository", async () => {
      const { repo, commits } = standardRepo();
      mkdirSync(cachePath(), { recursive: true });
      writeFileSync(join(cachePath(), "keep.txt"), "keep");

      const result = await runImport(repo.archive(zipPath()), commits[2]);

      expectRejected(result, /not a bare Git repository/);
      expect(readdirSync(cachePath())).toEqual(["keep.txt"]);
    });

    it("never touches work clones, including ones with local changes", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      const work = clone(entry(), { cacheDir });
      writeFileSync(join(work.clonePath, "README.md"), "local edit\n");
      const next = repo.commit("next", { "n.txt": "n\n" });

      expect((await runImport(repo.archive(zipPath()), next)).outcome).toBe("fast-forward");

      expect(readFileSync(join(work.clonePath, "README.md"), "utf-8")).toBe("local edit\n");
      expect(git(work.clonePath, ["rev-parse", "HEAD"])).toBe(commits[2]);
      const refresh = clone(entry(), { cacheDir });
      expect(refresh.success).toBe(false);
      expect(refresh.error).toMatch(/local changes/);
    });

    it("fast-forwards work clones but never drops their local commits", async () => {
      const { repo, commits } = standardRepo();
      await runImport(repo.archive(zipPath()), commits[2]);
      const work = clone(entry(), { cacheDir });
      const next = repo.commit("next", { "n.txt": "n\n" });
      await runImport(repo.archive(zipPath()), next);

      expect(clone(entry(), { cacheDir }).success).toBe(true);
      expect(git(work.clonePath, ["rev-parse", "HEAD"])).toBe(next);

      writeFileSync(join(work.clonePath, "local.txt"), "mine\n");
      git(work.clonePath, ["add", "local.txt"]);
      git(work.clonePath, ["commit", "--quiet", "-m", "local work"]);
      const local = git(work.clonePath, ["rev-parse", "HEAD"]);
      const latest = repo.commit("latest", { "l.txt": "l\n" });
      await runImport(repo.archive(zipPath()), latest);

      const refresh = clone(entry(), { cacheDir });

      expect(refresh.success).toBe(false);
      expect(refresh.error).toMatch(/has commits that are not in the cache/);
      expect(git(work.clonePath, ["rev-parse", "HEAD"])).toBe(local);
    });

    it("succeeds without network access to the private remote", async () => {
      const { repo, commits } = standardRepo();
      const offline: ArchiveRepoConfig = {
        name: "tool",
        source: "archive",
        private: "https://example.invalid/never-contacted.git",
      };

      const result = await runImport(repo.archive(zipPath()), commits[2], "main", offline);

      expect(result.error).toBeUndefined();
      expect(git(cachePath(), ["for-each-ref", "refs/remotes"])).toBe("");
    });
  });
});
