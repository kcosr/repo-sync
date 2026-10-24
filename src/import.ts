import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extractGitArchive } from "./archive.js";
import { getRepoTempPath, getStagingDir } from "./config.js";
import type { ArchiveLimits, ArchiveRepoConfig } from "./types.js";

const ARCHIVE_SOURCE_CONFIG = "repo-sync.source";
const IMPORT_REFS = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"];

export interface ImportRequest {
  archivePath: string;
}

export interface ImportOptions {
  cacheDir: string;
  limits: ArchiveLimits;
}

export interface ImportResult {
  success: boolean;
  repoPath: string;
  isNew: boolean;
  error?: string;
}

class ImportError extends Error {}

/** Never run Git against the extracted repository's configuration, hooks or object indexes. */
class TrustedGit {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly cwd: string) {
    this.env = {
      PATH: process.env.PATH,
      HOME: cwd,
      XDG_CONFIG_HOME: join(cwd, ".config"),
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    };
  }

  run(args: string[], options: { gitDir?: string; stdin?: number } = {}) {
    const prefix = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
    ];
    if (options.gitDir) prefix.push(`--git-dir=${options.gitDir}`);
    const result = spawnSync("git", [...prefix, ...args], {
      cwd: this.cwd,
      env: this.env,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: (result.stdout ?? "").trim(),
      stderr: result.error?.message ?? (result.stderr ?? "").trim(),
    };
  }

  must(action: string, args: string[], options: { gitDir?: string; stdin?: number } = {}): string {
    const result = this.run(args, options);
    if (!result.ok) {
      throw new ImportError(
        `${action}: ${result.stderr || result.stdout || `git exited with ${result.status}`}`,
      );
    }
    return result.stdout;
  }

  init(path: string, format: string): void {
    this.must("Failed to create staging repository", [
      "init",
      "--bare",
      "--quiet",
      "--template=",
      `--object-format=${format}`,
      path,
    ]);
  }
}

/** Moves loose objects and re-indexes packs from the archive into the quarantine repository. */
function importObjects(git: TrustedGit, archiveGitDir: string, quarantine: string, format: string) {
  const objectsDir = join(archiveGitDir, "objects");
  if (!existsSync(objectsDir) || !lstatSync(objectsDir).isDirectory()) {
    throw new ImportError("Archive Git directory has no objects directory");
  }
  const looseName = new RegExp(`^[0-9a-f]{${format === "sha256" ? 62 : 38}}$`);
  let count = 0;
  for (const fanout of readdirSync(objectsDir, { withFileTypes: true })) {
    if (!fanout.isDirectory() || !/^[0-9a-f]{2}$/.test(fanout.name)) {
      continue;
    }
    for (const object of readdirSync(join(objectsDir, fanout.name), { withFileTypes: true })) {
      if (object.isFile() && looseName.test(object.name)) {
        const destination = join(quarantine, "objects", fanout.name);
        mkdirSync(destination, { recursive: true });
        renameSync(join(objectsDir, fanout.name, object.name), join(destination, object.name));
        count++;
      }
    }
  }
  const packDir = join(objectsDir, "pack");
  if (existsSync(packDir)) {
    for (const pack of readdirSync(packDir, { withFileTypes: true })) {
      if (!pack.isFile() || !/^pack-[0-9a-f]+\.pack$/.test(pack.name)) {
        continue;
      }
      const fd = openSync(join(packDir, pack.name), "r");
      try {
        git.must(`Archive pack ${pack.name} failed verification`, ["index-pack", "--stdin"], {
          gitDir: quarantine,
          stdin: fd,
        });
      } finally {
        closeSync(fd);
      }
      count++;
    }
  }
  if (count === 0) {
    throw new ImportError("Archive Git directory contains no objects");
  }
}

/** Read only the object format as inert config data; do not follow include directives. */
function archiveObjectFormat(git: TrustedGit, archiveGitDir: string): string {
  const result = git.run([
    "config",
    "--no-includes",
    "--file",
    join(archiveGitDir, "config"),
    "--get",
    "extensions.objectFormat",
  ]);
  if (result.status === 1) return "sha1";
  if (!result.ok || !["sha1", "sha256"].includes(result.stdout)) {
    throw new ImportError(`Cannot read archive object format: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Build an isolated local fetch source from objects and refs, then let Git validate it. */
function prepareSource(
  git: TrustedGit,
  archiveGitDir: string,
  source: string,
  format: string,
): string {
  git.init(source, format);
  importObjects(git, archiveGitDir, source, format);
  for (const name of ["HEAD", "packed-refs"]) {
    const path = join(archiveGitDir, name);
    if (existsSync(path)) copyFileSync(path, join(source, name));
  }
  for (const namespace of ["heads", "tags"]) {
    const path = join(archiveGitDir, "refs", namespace);
    if (existsSync(path)) cpSync(path, join(source, "refs", namespace), { recursive: true });
  }
  git.must(
    "Archive history is incomplete or corrupt",
    ["fsck", "--full", "--no-dangling", "--no-progress"],
    { gitDir: source },
  );
  const head = git.must(
    "Archive HEAD does not point to a commit",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { gitDir: source },
  );
  const branches = git
    .must(
      "Failed to read archive branches",
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"],
      { gitDir: source },
    )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  if (branches.length === 0) throw new ImportError("Archive has no named branches to import");
  const symbolic = git.run(["symbolic-ref", "--quiet", "HEAD"], { gitDir: source });
  return (
    branches.find(([ref]) => ref === symbolic.stdout)?.[0] ??
    branches.find(([, oid]) => oid === head)?.[0] ??
    branches[0][0]
  );
}

function configureCache(
  git: TrustedGit,
  gitDir: string,
  repo: ArchiveRepoConfig,
  head: string,
): void {
  for (const [key, value] of [
    ["remote.private.url", repo.private],
    ["remote.private.fetch", "+refs/heads/*:refs/remotes/private/*"],
    ["remote.private.tagOpt", "--no-tags"],
    [ARCHIVE_SOURCE_CONFIG, "archive"],
  ]) {
    git.must("Failed to configure cache", ["config", key, value], { gitDir });
  }
  git.must("Failed to set cache HEAD", ["symbolic-ref", "HEAD", head], { gitDir });
}

/** ZIP is a local upstream: validate Git data, fetch all branches/tags, and keep the cache. */
export async function importArchive(
  repo: ArchiveRepoConfig,
  request: ImportRequest,
  options: ImportOptions,
): Promise<ImportResult> {
  const cacheDir = resolve(options.cacheDir);
  const repoPath = getRepoTempPath(repo.name, cacheDir);
  let staging: string | undefined;
  let isNew = false;
  try {
    const stagingRoot = getStagingDir(cacheDir);
    mkdirSync(stagingRoot, { recursive: true });
    staging = mkdtempSync(join(stagingRoot, "import-"));
    const extractDir = join(staging, "extract");
    mkdirSync(extractDir);
    console.log("  Reading Git data from archive...");
    const archiveGitDir = await extractGitArchive(
      resolve(request.archivePath),
      extractDir,
      options.limits,
    );
    const git = new TrustedGit(staging);
    const format = archiveObjectFormat(git, archiveGitDir);
    const source = join(staging, "source.git");
    const head = prepareSource(git, archiveGitDir, source, format);

    const existing = lstatSync(repoPath, { throwIfNoEntry: false });
    isNew = existing === undefined;
    const target = isNew ? join(staging, "cache.git") : repoPath;
    if (isNew) {
      git.init(target, format);
      configureCache(git, target, repo, head);
    } else {
      if (
        !existing?.isDirectory() ||
        git.must("Invalid cache", ["rev-parse", "--is-bare-repository"], { gitDir: target }) !==
          "true"
      ) {
        throw new ImportError(`Cache path is not a bare Git repository: ${repoPath}`);
      }
      if (
        git.run(["config", "--get", ARCHIVE_SOURCE_CONFIG], { gitDir: target }).stdout !== "archive"
      ) {
        throw new ImportError(
          `Cache was not created by 'repo-sync import'; run 'repo-sync clean ${repo.name}' before importing`,
        );
      }
      if (
        git.must("Failed to read cache format", ["rev-parse", "--show-object-format"], {
          gitDir: target,
        }) !== format
      ) {
        throw new ImportError("Archive and cache use different Git object formats");
      }
    }

    console.log("  Fetching archived branches and tags...");
    // Git enforces fast-forward branches, immutable existing tags and all-or-nothing ref updates.
    git.must(
      "Could not import branches and tags (updates must fast-forward; existing tags cannot change)",
      [
        "fetch",
        "--atomic",
        "--no-tags",
        "--no-prune",
        "--no-prune-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        source,
        ...IMPORT_REFS,
      ],
      { gitDir: target },
    );
    if (isNew) {
      mkdirSync(dirname(repoPath), { recursive: true });
      renameSync(target, repoPath);
    }
    return { success: true, repoPath, isNew };
  } catch (err) {
    return { success: false, repoPath, isNew, error: (err as Error).message };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
