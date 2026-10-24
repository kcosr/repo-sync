import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jest } from "@jest/globals";
import { DEFAULT_ARCHIVE_LIMITS, getRepoTempPath } from "./config.js";
import { importArchive } from "./import.js";
import { inspectSourceNotice, prepareSourceNotice } from "./source-notice.js";
import { pull, push, status } from "./sync.js";
import { SourceRepo, git, initBare, makeTempDir } from "./testing/fixtures.js";
import type { ArchiveRepoConfig, RemoteRepoConfig, RepoConfig } from "./types.js";

function gitBytes(repoPath: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: repoPath,
    input,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "repo-sync",
      GIT_AUTHOR_EMAIL: "repo-sync@localhost",
      GIT_COMMITTER_NAME: "repo-sync",
      GIT_COMMITTER_EMAIL: "repo-sync@localhost",
      GIT_AUTHOR_DATE: "1700000100 +0000",
      GIT_COMMITTER_DATE: "1700000100 +0000",
    },
  });
}

describe("source notices in repository sync", () => {
  let root: string;
  let cacheDir: string;
  let privateRepo: string;
  let source: SourceRepo;
  let sourceCommit: string;
  let archiveCount = 0;
  const originalReadme = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("\r\n# Project\r\n\r\n"),
    Buffer.from("<!-- repo-sync-source-notice -->\nAn unrelated marker example.\n"),
    Buffer.from("<!-- end-repo-sync-source-notice -->\n\n"),
    Buffer.from([0xff, 0x0a, 0x0a]),
  ]);

  beforeEach(() => {
    root = makeTempDir("source-notice-sync");
    cacheDir = join(root, "cache");
    privateRepo = initBare(join(root, "private.git"));
    source = SourceRepo.create(join(root, "source"));
    writeFileSync(join(source.path, "README.md"), originalReadme);
    sourceCommit = source.commit("Original source", { "app.txt": "original application\n" });
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function remoteRepo(): RemoteRepoConfig {
    const publicRepo = join(root, "public.git");
    git(root, ["clone", "--quiet", "--bare", source.path, publicRepo]);
    return { name: "project", public: publicRepo, private: privateRepo, sourceNotice: "linked" };
  }

  function archiveRepo(): ArchiveRepoConfig {
    return { name: "project", source: "archive", private: privateRepo, sourceNotice: "generic" };
  }

  const cachePath = () => getRepoTempPath("project", cacheDir);
  const privateHead = () => git(privateRepo, ["rev-parse", "refs/heads/main"]);
  const sourceHead = () => git(cachePath(), ["rev-parse", "refs/heads/main"]);
  const privateReadme = () => gitBytes(privateRepo, ["show", "refs/heads/main:README.md"]);

  it("refuses remote pushes when destination refs cannot be listed", () => {
    const repo = remoteRepo();
    expect(pull(repo, { cacheDir }).success).toBe(true);
    rmSync(privateRepo, { recursive: true, force: true });

    const result = status(repo, { cacheDir });

    expect(result.canPush).toBe(false);
    expect(result.errors.join(" ")).toContain("Failed to list destination tags");
    expect(push(repo, { cacheDir })).toMatchObject({ success: false, pushed: false });
    expect(sourceHead()).toBe(sourceCommit);
  });

  async function importSource(repo: ArchiveRepoConfig): Promise<void> {
    const archivePath = source.archive(join(root, `source-${archiveCount++}.zip`));
    const result = await importArchive(
      repo,
      { archivePath },
      { cacheDir, limits: DEFAULT_ARCHIVE_LIMITS },
    );
    expect(result.success).toBe(true);
  }

  function expectSettled(repo: RepoConfig): void {
    const head = privateHead();
    const result = status(repo, { cacheDir });
    expect(result.canPush).toBe(true);
    expect(result.hasChanges).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.status.sourceNoticeChanged ?? false).toBe(false);
    expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: false });
    expect(privateHead()).toBe(head);
  }

  it("changes remote notices linked → generic → none without a source update", () => {
    const repo = remoteRepo();
    expect(pull(repo, { cacheDir }).success).toBe(true);
    const generatedTips: string[] = [];

    for (const mode of ["linked", "generic", "none"] as const) {
      repo.sourceNotice = mode;
      const pending = status(repo, { cacheDir });
      expect(pending.canPush).toBe(true);
      expect(pending.hasChanges).toBe(true);
      expect(pending.status.sourceNoticeChanged).toBe(true);
      expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
      expect(sourceHead()).toBe(sourceCommit);
      expect(source.head()).toBe(sourceCommit);
      expect(privateReadme().subarray(-originalReadme.length)).toEqual(originalReadme);
      expect(gitBytes(privateRepo, ["show", "refs/heads/main:app.txt"])).toEqual(
        Buffer.from("original application\n"),
      );

      if (mode === "none") {
        expect(privateHead()).toBe(sourceCommit);
        expect(privateReadme()).toEqual(originalReadme);
      } else {
        generatedTips.push(privateHead());
        expect(inspectSourceNotice(privateRepo, privateHead())).toEqual({
          sourceCommit,
          mode,
          ...(mode === "linked" ? { publicUrl: repo.public } : {}),
        });
        expect(privateReadme().toString().includes(repo.public)).toBe(mode === "linked");
      }
      expectSettled(repo);
    }

    expect(new Set(generatedTips).size).toBe(2);
  });

  it("keeps imported history pristine across ZIP updates and generic/none changes", async () => {
    const repo = archiveRepo();
    await importSource(repo);
    expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
    expect(inspectSourceNotice(privateRepo, privateHead())).toEqual({
      sourceCommit,
      mode: "generic",
    });
    expect(sourceHead()).toBe(sourceCommit);
    expectSettled(repo);

    const nextCommit = source.commit("Next ZIP", { "app.txt": "updated application\n" });
    source.git("branch", "release/2.x");
    source.git("tag", "--annotate", "v2", "--message", "release v2");
    await importSource(repo);
    const sourceRefs = git(cachePath(), ["for-each-ref", "refs/heads/", "refs/tags/"]);
    expect(status(repo, { cacheDir }).hasChanges).toBe(true);
    expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
    expect(inspectSourceNotice(privateRepo, privateHead())).toEqual({
      sourceCommit: nextCommit,
      mode: "generic",
    });
    expect(git(privateRepo, ["rev-parse", "refs/heads/release/2.x"])).toBe(nextCommit);
    expect(git(privateRepo, ["rev-parse", "refs/tags/v2"])).toBe(source.git("rev-parse", "v2"));
    expect(sourceHead()).toBe(nextCommit);
    expectSettled(repo);

    repo.sourceNotice = "none";
    expect(status(repo, { cacheDir }).status.sourceNoticeChanged).toBe(true);
    expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
    expect(privateHead()).toBe(nextCommit);
    expect(privateReadme()).toEqual(originalReadme);
    expectSettled(repo);

    repo.sourceNotice = "generic";
    expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
    expect(inspectSourceNotice(privateRepo, privateHead())?.sourceCommit).toBe(nextCommit);
    expectSettled(repo);
    expect(git(cachePath(), ["for-each-ref", "refs/heads/", "refs/tags/"])).toBe(sourceRefs);
    expect(source.head()).toBe(nextCommit);
  });

  it("blocks a notice change when someone added a private commit after the generated notice", async () => {
    const repo = archiveRepo();
    await importSource(repo);
    expect(push(repo, { cacheDir }).success).toBe(true);
    const notice = privateHead();
    const manualCommit = git(privateRepo, [
      "commit-tree",
      git(privateRepo, ["rev-parse", `${notice}^{tree}`]),
      "-p",
      notice,
      "-m",
      "Manual private work",
    ]);
    git(privateRepo, ["update-ref", "refs/heads/main", manualCommit]);
    repo.sourceNotice = "none";

    expect(status(repo, { cacheDir }).canPush).toBe(false);
    expect(push(repo, { cacheDir })).toMatchObject({ success: false, pushed: false });
    expect(privateHead()).toBe(manualCommit);
    expect(sourceHead()).toBe(sourceCommit);
  });

  it("blocks every archive update when an existing destination tag points to an older commit", async () => {
    source.git(
      "push",
      privateRepo,
      `${sourceCommit}:refs/heads/main`,
      `${sourceCommit}:refs/tags/release`,
    );
    const nextCommit = source.commit("Next source commit");
    source.git("branch", "new-feature");
    source.git("tag", "release");
    const repo = archiveRepo();
    await importSource(repo);

    const result = status(repo, { cacheDir });
    expect(result.canPush).toBe(false);
    expect(result.errors.join(" ")).toContain("Existing tags cannot change on private: release");
    expect(push(repo, { cacheDir })).toMatchObject({ success: false, pushed: false });
    expect(privateHead()).toBe(sourceCommit);
    expect(git(privateRepo, ["rev-parse", "refs/tags/release"])).toBe(sourceCommit);
    expect(git(privateRepo, ["for-each-ref", "refs/heads/new-feature"])).toBe("");
    expect(sourceHead()).toBe(nextCommit);
  });

  it.each([false, true])(
    "replaces a verified legacy private notice (legacy source cache: %s)",
    (legacyCache) => {
      const repo = remoteRepo();
      expect(pull(repo, { cacheDir }).success).toBe(true);
      const generated = prepareSourceNotice(cachePath(), sourceCommit, "linked", repo.public);
      const legacy = gitBytes(
        cachePath(),
        ["commit-tree", git(cachePath(), ["rev-parse", `${generated}^{tree}`]), "-p", sourceCommit],
        "Add source repository notice\n",
      )
        .toString()
        .trim();
      git(cachePath(), ["push", "private", `${legacy}:refs/heads/main`]);
      if (legacyCache) git(cachePath(), ["update-ref", "refs/heads/main", legacy]);
      repo.sourceNotice = "generic";

      const pending = status(repo, { cacheDir });
      expect(pending.canPush).toBe(true);
      expect(pending.status.sourceNoticeChanged).toBe(true);
      expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
      expect(inspectSourceNotice(privateRepo, privateHead())).toEqual({
        sourceCommit,
        mode: "generic",
      });
      expect(sourceHead()).toBe(legacyCache ? legacy : sourceCommit);
      expectSettled(repo);
      expect(pull(repo, { cacheDir }).success).toBe(true);
      expect(sourceHead()).toBe(sourceCommit);
      expectSettled(repo);
    },
  );

  it("preserves an imported source tip that itself is a genuine generated notice", async () => {
    const generatedSource = prepareSourceNotice(source.path, sourceCommit, "generic");
    source.git("reset", "--hard", generatedSource);
    const repo = archiveRepo();
    repo.sourceNotice = "none";
    await importSource(repo);

    expect(sourceHead()).toBe(generatedSource);
    expect(push(repo, { cacheDir })).toEqual({ success: true, pushed: true });
    expect(privateHead()).toBe(generatedSource);
    expect(privateReadme()).toEqual(gitBytes(source.path, ["show", "HEAD:README.md"]));
    expectSettled(repo);
    expect(sourceHead()).toBe(generatedSource);
  });
});
