import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { jest } from "@jest/globals";
import { DEFAULT_ARCHIVE_LIMITS, getRepoTempPath } from "./config.js";
import { importArchive } from "./import.js";
import { clone } from "./sync.js";
import { SourceRepo, git, initBare, makeTempDir } from "./testing/fixtures.js";
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

  const entry = (): ArchiveRepoConfig => ({
    name: "tool",
    source: "archive",
    private: privateRepo,
  });
  const cachePath = () => getRepoTempPath("tool", cacheDir);
  const zipPath = () => join(root, `archive-${zipCount++}.zip`);
  const sourceRepo = () => SourceRepo.create(join(root, "tool-src"));
  const runImport = (zip: string, cache = cacheDir) =>
    importArchive(
      entry(),
      { archivePath: zip },
      { cacheDir: cache, limits: DEFAULT_ARCHIVE_LIMITS },
    );
  const refs = () => git(cachePath(), ["for-each-ref", "--format=%(refname) %(objectname)"]);

  function expectStagingClean(): void {
    expect(readdirSync(join(cacheDir, "staging"))).toEqual([]);
  }

  it("fetches all branches and tags with complete packed and loose history", async () => {
    const repo = sourceRepo();
    const first = repo.commit("first", { "README.md": "one\n" });
    repo.git("checkout", "--quiet", "-b", "feature");
    const feature = repo.commit("feature", { "feature.txt": "feature\n" });
    repo.git("tag", "-a", "-m", "release", "v1");
    const tag = repo.git("rev-parse", "v1");
    repo.git("checkout", "--quiet", "main");
    repo.git("gc", "--quiet");
    const last = repo.commit("main advances", { "README.md": "two\n" });
    const zip = repo.archive(zipPath());
    const original = readFileSync(zip);

    expect(await runImport(zip)).toMatchObject({
      success: true,
      isNew: true,
      repoPath: cachePath(),
    });
    expect(refs()).toBe(
      `refs/heads/feature ${feature}\nrefs/heads/main ${last}\nrefs/tags/v1 ${tag}`,
    );
    expect(git(cachePath(), ["rev-list", "main"]).split("\n")).toEqual([last, first]);
    expect(git(cachePath(), ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(git(cachePath(), ["config", "--get", "remote.private.url"])).toBe(privateRepo);
    expect(git(cachePath(), ["remote"])).toBe("private");
    expect(git(cachePath(), ["config", "--get", "repo-sync.source"])).toBe("archive");
    git(cachePath(), ["fsck", "--full", "--strict"]);
    expect(readFileSync(zip)).toEqual(original);
    expect(git(privateRepo, ["for-each-ref"])).toBe("");
    expect(existsSync(join(cacheDir, "imports"))).toBe(false);
    expectStagingClean();
  });

  it("updates repeatedly, adds new refs and retains branches/tags omitted by later ZIPs", async () => {
    const repo = sourceRepo();
    const first = repo.commit("first", { "a.txt": "a\n" });
    repo.git("branch", "legacy");
    repo.git("tag", "v1");
    const firstZip = repo.archive(zipPath());
    expect((await runImport(firstZip)).success).toBe(true);
    const config = readFileSync(join(cachePath(), "config"));
    const before = refs();
    expect(await runImport(firstZip)).toMatchObject({ success: true, isNew: false });
    expect(refs()).toBe(before);
    repo.git("branch", "-D", "legacy");
    repo.git("tag", "-d", "v1");
    const next = repo.commit("next", { "b.txt": "b\n" });
    repo.git("checkout", "--quiet", "-b", "release");
    repo.git("tag", "v2");

    expect(await runImport(repo.archive(zipPath()))).toMatchObject({ success: true, isNew: false });
    expect(refs()).toBe(
      `refs/heads/legacy ${first}\nrefs/heads/main ${next}\nrefs/heads/release ${next}\nrefs/tags/v1 ${first}\nrefs/tags/v2 ${next}`,
    );
    expect(readFileSync(join(cachePath(), "config"))).toEqual(config);
    expect(git(cachePath(), ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expectStagingClean();
  });

  it.each(["backward", "divergent", "unrelated"])(
    "rejects %s branch updates without changing any refs",
    async (kind) => {
      const repo = sourceRepo();
      const first = repo.commit("first", { "a.txt": "a\n" });
      repo.commit("second", { "b.txt": "b\n" });
      expect((await runImport(repo.archive(zipPath()))).success).toBe(true);
      const before = refs();
      repo.git("reset", "--hard", first);
      if (kind === "divergent") repo.commit("different", { "c.txt": "c\n" });
      if (kind === "unrelated") {
        repo.git("checkout", "--orphan", "other");
        repo.commit("unrelated", { "other.txt": "other\n" });
        repo.git("branch", "-M", "main");
      }
      repo.git("branch", "new-branch");
      repo.git("tag", "new-tag");
      const result = await runImport(repo.archive(zipPath()));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fast-forward/);
      expect(refs()).toBe(before);
      expectStagingClean();
    },
  );

  it("rejects changed tags atomically even when branches could fast-forward", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    repo.git("tag", "v1");
    expect((await runImport(repo.archive(zipPath()))).success).toBe(true);
    const before = refs();
    repo.commit("next", { "b.txt": "b\n" });
    repo.git("tag", "-f", "v1");
    const result = await runImport(repo.archive(zipPath()));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/existing tags cannot change/);
    expect(refs()).toBe(before);
    expectStagingClean();
  });

  it("keeps every ref unchanged on a Git lock failure and succeeds on retry", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    await runImport(repo.archive(zipPath()));
    const before = refs();
    repo.commit("next", { "b.txt": "b\n" });
    repo.git("branch", "another");
    const zip = repo.archive(zipPath());
    const lock = join(cachePath(), "refs", "heads", "main.lock");
    writeFileSync(lock, "locked");
    expect((await runImport(zip)).success).toBe(false);
    expect(refs()).toBe(before);
    rmSync(lock);
    expect((await runImport(zip)).success).toBe(true);
    expect(git(cachePath(), ["rev-parse", "another"])).toBe(repo.head());
    expectStagingClean();
  });

  it.each(["sha1", "sha256"] as const)(
    "reads %s object format and detached HEAD from the archive",
    async (format) => {
      const repo = SourceRepo.create(join(root, "source"), { objectFormat: format });
      const commit = repo.commit("first", { "a.txt": "a\n" });
      repo.git("checkout", "--quiet", "--detach");
      expect((await runImport(repo.archive(zipPath()))).success).toBe(true);
      expect(git(cachePath(), ["rev-parse", "HEAD"])).toBe(commit);
      expect(git(cachePath(), ["rev-parse", "--show-object-format"])).toBe(format);
      expect(git(cachePath(), ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    },
  );

  it("chooses the first named branch when detached HEAD is not a branch tip", async () => {
    const repo = sourceRepo();
    const first = repo.commit("first", { "a.txt": "a\n" });
    const next = repo.commit("next", { "b.txt": "b\n" });
    repo.git("checkout", "--quiet", "--detach", first);
    expect((await runImport(repo.archive(zipPath()))).success).toBe(true);
    expect(git(cachePath(), ["rev-parse", "HEAD"])).toBe(next);
  });

  it("requires a named branch for the retained working-clone workflow", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    repo.git("checkout", "--quiet", "--detach");
    repo.git("branch", "-D", "main");
    const result = await runImport(repo.archive(zipPath()));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no named branches/);
    expect(existsSync(cachePath())).toBe(false);
  });

  it("uses committed history and ignores dirty, untracked and ignored working-tree files", async () => {
    const repo = sourceRepo();
    repo.commit("first", { ".gitignore": "*.secret\n", "a.txt": "committed\n" });
    repo.write("a.txt", "dirty\n");
    repo.write("untracked.txt", "not committed\n");
    repo.write("ignored.secret", "ignored\n");
    const zip = repo.archive(zipPath(), {
      transform: (entries) => [
        ...entries,
        {
          name: "tool-src/outside",
          data: "/outside",
          mode: 0o120777,
        },
      ],
    });
    expect((await runImport(zip)).success).toBe(true);
    expect(git(cachePath(), ["show", "main:a.txt"])).toBe("committed");
    expect(git(cachePath(), ["ls-tree", "--name-only", "main"])).toBe(".gitignore\na.txt");
  });

  it("rejects missing objects without touching an existing cache", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    await runImport(repo.archive(zipPath()));
    const before = refs();
    const next = repo.commit("next", { "b.txt": "b\n" });
    const objectPath = `.git/objects/${next.slice(0, 2)}/${next.slice(2)}`;
    const zip = repo.archive(zipPath(), {
      transform: (entries) => entries.filter((item) => !item.name.endsWith(objectPath)),
    });
    const result = await runImport(zip);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/incomplete or corrupt/);
    expect(refs()).toBe(before);
    expectStagingClean();
  });

  it("rejects corrupt packs and rebuilds archive-supplied pack indexes", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    repo.git("gc", "--quiet");
    const zip = repo.archive(zipPath(), {
      transform: (entries) =>
        entries.map((item) =>
          item.name.endsWith(".idx") ? { ...item, data: "untrusted index" } : item,
        ),
    });
    expect((await runImport(zip)).success).toBe(true);
    const before = refs();
    const corrupt = repo.archive(zipPath(), {
      transform: (entries) =>
        entries.map((item) =>
          item.name.endsWith(".pack") ? { ...item, data: "invalid pack" } : item,
        ),
    });
    expect((await runImport(corrupt)).success).toBe(false);
    expect(refs()).toBe(before);
  });

  it.each([
    "shallow",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "commondir",
    "info/grafts",
    "reftable/tables.list",
  ])("rejects non-self-contained or unsupported Git layout %s", async (name) => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    const zip = repo.archive(zipPath(), {
      transform: (entries) => [...entries, { name: `tool-src/.git/${name}`, data: "outside" }],
    });
    const result = await runImport(zip);
    expect(result.success).toBe(false);
    expect(existsSync(cachePath())).toBe(false);
    expectStagingClean();
  });

  it("uses an absolute cache path for Git when configured with a relative one", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    expect(
      (await runImport(repo.archive(zipPath()), relative(process.cwd(), cacheDir))).success,
    ).toBe(true);
    expect(git(cachePath(), ["rev-parse", "HEAD"])).toBe(repo.head());
  });

  it("does not take over existing paths or remote-managed caches", async () => {
    const repo = sourceRepo();
    repo.commit("first", { "a.txt": "a\n" });
    const zip = repo.archive(zipPath());
    mkdirSync(join(cacheDir, "repos"), { recursive: true });
    writeFileSync(cachePath(), "keep me");
    expect((await runImport(zip)).success).toBe(false);
    expect(readFileSync(cachePath(), "utf-8")).toBe("keep me");
    rmSync(cachePath());
    initBare(cachePath());
    const result = await runImport(zip);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not created by/);
    expect(refs()).toBe("");
  });

  it("reports missing ZIPs and cleans staging", async () => {
    expect((await runImport(join(root, "missing.zip"))).success).toBe(false);
    expect(existsSync(cachePath())).toBe(false);
    expectStagingClean();
  });

  it("never executes archive-supplied configuration, hooks or filters", async () => {
    const sentinels = join(root, "sentinels");
    mkdirSync(sentinels);
    const evil = join(root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch "${sentinels}/ran-$$"\n`, { mode: 0o755 });
    const repo = sourceRepo();
    repo.write(".gitattributes", "* filter=evil diff=evil merge=evil\n");
    repo.commit("init", { "README.md": "# hi\n" });
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

    const result = await runImport(repo.archive(zipPath()));

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
});
