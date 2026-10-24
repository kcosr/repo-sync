import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ArchiveEntry, ArchiveError, ZipArchive, sha256File } from "./archive.js";
import { getImportLogPath, getRepoTempPath, getStagingDir } from "./config.js";
import type { ArchiveLimits, ArchiveRepoConfig, ImportOutcome, ImportRecord } from "./types.js";

/** Untracked archive metadata that may sit beside `.git` without making the tree dirty. */
export const ARCHIVE_METADATA_FILE = "ARCHIVE-INFO.json";

/** Git config key that marks a cache as created and owned by `repo-sync import`. */
export const ARCHIVE_SOURCE_CONFIG = "repo-sync.source";

const IMPORT_REF = "refs/repo-sync/import";
const MAX_REF_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REPORTED_PATHS = 10;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ImportRequest {
  archivePath: string;
  commit: string;
  branch: string;
}

export interface ImportOptions {
  cacheDir: string;
  limits: ArchiveLimits;
}

export interface ImportResult {
  success: boolean;
  outcome?: ImportOutcome;
  repoPath: string;
  provenancePath: string;
  record?: ImportRecord;
  aheadCount?: number;
  error?: string;
}

class ImportError extends Error {}

interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

interface GitOptions {
  gitDir?: string;
  workTree?: string;
  indexFile?: string;
  stdin?: number;
  discardStdout?: boolean;
}

/**
 * Runs git with settings repo-sync controls: no system/global/XDG configuration, no hooks,
 * no fsmonitor, no network transports and no inherited GIT_* environment. Archive-supplied
 * repositories are never used as a git directory; their objects are copied into a fresh
 * quarantine repository first.
 */
class TrustedGit {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly cwd: string,
    home: string,
  ) {
    this.env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
  }

  run(args: string[], options: GitOptions = {}): GitResult {
    const prefix = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.symlinks=true",
      "-c",
      "core.fileMode=true",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
    ];
    if (options.gitDir) {
      prefix.push(`--git-dir=${options.gitDir}`);
    }
    if (options.workTree) {
      prefix.push("-c", "core.bare=false", `--work-tree=${options.workTree}`);
    }
    const env = options.indexFile ? { ...this.env, GIT_INDEX_FILE: options.indexFile } : this.env;
    const result = spawnSync("git", [...prefix, ...args], {
      cwd: this.cwd,
      env,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: [options.stdin ?? "ignore", options.discardStdout ? "ignore" : "pipe", "pipe"],
    });
    if (result.error) {
      return { ok: false, status: null, stdout: "", stderr: result.error.message };
    }
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: (result.stderr ?? "").trim(),
    };
  }

  /** Runs git and throws an ImportError describing `action` if it fails. */
  must(action: string, args: string[], options: GitOptions = {}): string {
    const result = this.run(args, options);
    if (!result.ok) {
      throw new ImportError(`${action}: ${result.stderr || `git exited with ${result.status}`}`);
    }
    return result.stdout.trim();
  }
}

function objectFormatFor(commit: string): "sha1" | "sha256" {
  return commit.length === 64 ? "sha256" : "sha1";
}

/** Validates the CLI-supplied commit and branch shape before any filesystem work. */
export function validateImportRequest(request: ImportRequest): string | undefined {
  if (!OBJECT_ID.test(request.commit)) {
    return `--commit must be a full 40- or 64-character lowercase hexadecimal commit ID (got '${request.commit}')`;
  }
  if (request.branch.length === 0 || request.branch.startsWith("-") || request.branch === "HEAD") {
    return `--branch '${request.branch}' is not a valid branch name`;
  }
  return undefined;
}

function checkRepositoryLayout(archive: ZipArchive): void {
  const gitDir = `${archive.root}/.git`;
  const byPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const gitEntry = byPath.get(gitDir);
  if (gitEntry && gitEntry.type !== "directory") {
    throw new ImportError(
      gitEntry.type === "file"
        ? `${gitDir} is a worktree pointer file; the archive must contain a real .git directory`
        : `${gitDir} is a symlink; the archive must contain a real .git directory`,
    );
  }
  const insideGit = (entry: ArchiveEntry) => entry.path.startsWith(`${gitDir}/`);
  if (!archive.entries.some(insideGit)) {
    throw new ImportError(`Archive does not contain a Git repository at ${gitDir}`);
  }

  for (const entry of archive.entries) {
    const segments = entry.path.split("/");
    const nested = segments.some(
      (segment, depth) => segment.toLowerCase() === ".git" && !(depth === 1 && segment === ".git"),
    );
    if (nested) {
      throw new ImportError(`Archive contains a nested Git directory: ${entry.path}`);
    }
    if (insideGit(entry) && entry.type === "symlink") {
      throw new ImportError(`Archive Git directory contains a symlink: ${entry.path}`);
    }
  }

  const disallowed: Array<[string, string]> = [
    ["shallow", "shallow history is not self-contained"],
    ["objects/info/alternates", "external object alternates are not self-contained"],
    ["objects/info/http-alternates", "external object alternates are not self-contained"],
    ["info/grafts", "grafted history is not self-contained"],
    ["commondir", "it is a linked worktree that depends on another checkout"],
    ["reftable", "reftable ref storage is not supported"],
  ];
  for (const [path, reason] of disallowed) {
    if (byPath.has(`${gitDir}/${path}`)) {
      throw new ImportError(`Archive Git directory contains ${path}: ${reason}`);
    }
  }
  if (byPath.get(`${gitDir}/HEAD`)?.type !== "file") {
    throw new ImportError("Archive Git directory has no HEAD file");
  }
}

function readSmallFile(path: string, limit: number): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > limit) {
    throw new ImportError(`Archive ref file is not a readable regular file: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function isSafeRefName(ref: string): boolean {
  return (
    ref.startsWith("refs/") &&
    ref
      .split("/")
      .every(
        (s) =>
          s.length > 0 && s !== "." && s !== ".." && ![...s].some((c) => c < " " || c === "\\"),
      )
  );
}

function resolveArchiveRef(gitDir: string, ref: string, depth = 0): string | null {
  if (depth > 5 || !isSafeRefName(ref)) {
    throw new ImportError(`Archive HEAD refers to an invalid ref: ${ref}`);
  }
  const loosePath = join(gitDir, ...ref.split("/"));
  if (existsSync(loosePath) && lstatSync(loosePath).isFile()) {
    const value = readSmallFile(loosePath, 4096).trim();
    if (OBJECT_ID.test(value)) {
      return value;
    }
    const symbolic = /^ref: (\S+)$/.exec(value);
    if (symbolic) {
      return resolveArchiveRef(gitDir, symbolic[1], depth + 1);
    }
    throw new ImportError(`Archive ref ${ref} has unrecognized contents`);
  }
  const packedPath = join(gitDir, "packed-refs");
  if (existsSync(packedPath)) {
    for (const line of readSmallFile(packedPath, MAX_REF_FILE_BYTES).split("\n")) {
      const [id, name] = line.split(" ");
      if (name === ref && OBJECT_ID.test(id)) {
        return id;
      }
    }
  }
  return null;
}

/** Reads the archive's HEAD as plain data; returns the ref it names (null when detached). */
function readArchiveHead(gitDir: string): { ref: string | null; commit: string | null } {
  const head = readSmallFile(join(gitDir, "HEAD"), 4096).trim();
  if (OBJECT_ID.test(head)) {
    return { ref: null, commit: head };
  }
  const symbolic = /^ref: (\S+)$/.exec(head);
  if (!symbolic) {
    throw new ImportError("Archive HEAD has unrecognized contents");
  }
  return { ref: symbolic[1], commit: resolveArchiveRef(gitDir, symbolic[1]) };
}

/** Moves loose objects and re-indexes packs from the archive into the quarantine repository. */
function importObjects(git: TrustedGit, archiveGitDir: string, quarantine: string, commit: string) {
  const objectsDir = join(archiveGitDir, "objects");
  if (!existsSync(objectsDir) || !lstatSync(objectsDir).isDirectory()) {
    throw new ImportError("Archive Git directory has no objects directory");
  }
  const looseName = new RegExp(`^[0-9a-f]{${commit.length - 2}}$`);
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
          discardStdout: true,
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

function checkCleanTree(
  git: TrustedGit,
  quarantine: string,
  workTree: string,
  indexFile: string,
  commit: string,
): void {
  const options = { gitDir: quarantine, workTree, indexFile };
  git.must("Failed to prepare source tree check", ["update-ref", "--no-deref", "HEAD", commit], {
    gitDir: quarantine,
  });
  git.must("Failed to read commit tree", ["read-tree", commit], options);
  const status = git.must(
    "Failed to check source tree",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--no-renames",
    ],
    options,
  );
  const changes = status
    .split("\0")
    .filter((line) => line.length > 0 && line !== `?? ${ARCHIVE_METADATA_FILE}`);
  if (changes.length > 0) {
    const shown = changes.slice(0, MAX_REPORTED_PATHS).join(", ");
    const more =
      changes.length > MAX_REPORTED_PATHS
        ? `, and ${changes.length - MAX_REPORTED_PATHS} more`
        : "";
    throw new ImportError(
      `Archive source tree does not match commit ${commit} (${changes.length} change(s): ${shown}${more})`,
    );
  }
}

function readCacheState(
  git: TrustedGit,
  repoPath: string,
  branch: string,
  commit: string,
): { exists: boolean; previous: string | null } {
  if (!existsSync(repoPath) && !isDanglingLink(repoPath)) {
    return { exists: false, previous: null };
  }
  const bare = git.run(["rev-parse", "--is-bare-repository"], { gitDir: repoPath });
  if (!bare.ok || bare.stdout.trim() !== "true") {
    throw new ImportError(`Cache path exists but is not a bare Git repository: ${repoPath}`);
  }
  const source = git.run(["config", "--get", ARCHIVE_SOURCE_CONFIG], { gitDir: repoPath });
  if (source.stdout.trim() !== "archive") {
    throw new ImportError(
      `Cache at ${repoPath} was not created by 'repo-sync import'; run 'repo-sync clean' for this repo before importing`,
    );
  }
  const format = git.must(
    "Failed to read cache object format",
    ["rev-parse", "--show-object-format"],
    {
      gitDir: repoPath,
    },
  );
  if (format !== objectFormatFor(commit)) {
    throw new ImportError(
      `Cache uses ${format} object IDs but --commit is a ${objectFormatFor(commit)} ID`,
    );
  }
  const current = git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], {
    gitDir: repoPath,
  });
  return { exists: true, previous: current.ok ? current.stdout.trim() : null };
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isAncestor(
  git: TrustedGit,
  gitDir: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = git.run(["merge-base", "--is-ancestor", ancestor, descendant], { gitDir });
  if (result.status !== 0 && result.status !== 1) {
    throw new ImportError(`Failed to compare commits: ${result.stderr}`);
  }
  return result.status === 0;
}

function configureCache(git: TrustedGit, gitDir: string, repo: ArchiveRepoConfig): void {
  const settings: Array<[string, string]> = [
    ["remote.private.url", repo.private],
    ["remote.private.fetch", "+refs/heads/*:refs/remotes/private/*"],
    ["remote.private.tagOpt", "--no-tags"],
    [ARCHIVE_SOURCE_CONFIG, "archive"],
  ];
  for (const [key, value] of settings) {
    git.must("Failed to configure cache", ["config", "--replace-all", key, value], { gitDir });
  }
}

export function readImportHistory(repoName: string, cacheDir?: string): ImportRecord[] {
  const path = getImportLogPath(repoName, cacheDir);
  if (!existsSync(path)) {
    return [];
  }
  const records: ImportRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as ImportRecord);
    } catch {
      // Skip a torn final line rather than hiding every earlier record.
    }
  }
  return records;
}

export function getLastImport(repoName: string, cacheDir?: string): ImportRecord | undefined {
  return readImportHistory(repoName, cacheDir)
    .filter((record) => record.result !== "rejected")
    .at(-1);
}

/**
 * Imports one commit from a source ZIP into the archive-managed cache for `repo`, associating
 * it with `request.branch`. The archive is validated completely in a private staging directory
 * before the cache changes; activation is a rename (new cache) or a compare-and-swap ref update
 * (existing cache) that is rolled back if provenance cannot be recorded, so a failure leaves the
 * previous cache untouched. No network access occurs.
 */
export async function importArchive(
  repo: ArchiveRepoConfig,
  request: ImportRequest,
  options: ImportOptions,
): Promise<ImportResult> {
  // Git runs from the staging directory, so every path handed to it must be absolute.
  const cacheDir = resolve(options.cacheDir);
  const repoPath = getRepoTempPath(repo.name, cacheDir);
  const provenancePath = getImportLogPath(repo.name, cacheDir);
  const archivePath = resolve(request.archivePath);
  const requestError = validateImportRequest(request);
  if (requestError) {
    return { success: false, repoPath, provenancePath, error: requestError };
  }

  const stagingRoot = getStagingDir(cacheDir);
  mkdirSync(stagingRoot, { recursive: true });
  const staging = mkdtempSync(join(stagingRoot, `${repo.name.replace(/[^a-zA-Z0-9._-]/g, "-")}-`));
  const home = join(staging, "home");
  mkdirSync(home);
  const git = new TrustedGit(staging, home);
  if (!git.run(["check-ref-format", `refs/heads/${request.branch}`]).ok) {
    rmSync(staging, { recursive: true, force: true });
    return {
      success: false,
      repoPath,
      provenancePath,
      error: `--branch '${request.branch}' is not a valid branch name`,
    };
  }

  const record: ImportRecord = {
    repo: repo.name,
    result: "rejected",
    importedAt: new Date().toISOString(),
    archive: { path: archivePath, sha256: null, size: null, root: null, head: null },
    commit: request.commit,
    branch: request.branch,
    previousCommit: null,
    validation: { passed: false, checks: [] },
  };
  const checks = record.validation.checks;
  let archive: ZipArchive | undefined;
  let logFd: number | undefined;
  let outcome: ImportOutcome;
  let aheadCount: number | undefined;

  try {
    if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
      throw new ImportError(`Archive not found: ${archivePath}`);
    }
    console.log("  Reading archive...");
    const digest = await sha256File(archivePath);
    record.archive.sha256 = digest.sha256;
    record.archive.size = digest.size;
    archive = ZipArchive.open(archivePath, options.limits);
    if (archive.size !== digest.size || archive.mtimeMs !== digest.mtimeMs) {
      throw new ImportError("Archive changed while it was being imported");
    }
    record.archive.root = archive.root;
    checks.push("archive-structure");
    checkRepositoryLayout(archive);
    checks.push("self-contained-layout");

    const cache = readCacheState(git, repoPath, request.branch, request.commit);
    record.previousCommit = cache.previous;

    console.log("  Extracting archive...");
    const extractDir = join(staging, "extract");
    mkdirSync(extractDir);
    await archive.extractTo(extractDir);
    const workTree = join(extractDir, archive.root);
    const archiveGitDir = join(workTree, ".git");

    const head = readArchiveHead(archiveGitDir);
    record.archive.head = head.ref ?? "detached";
    if (head.commit !== request.commit) {
      throw new ImportError(
        head.commit
          ? `Archive HEAD${head.ref ? ` (${head.ref})` : ""} is ${head.commit}, not the expected commit ${request.commit}`
          : `Archive HEAD (${head.ref}) does not point to a commit`,
      );
    }
    checks.push("head-matches-commit");

    console.log("  Verifying Git objects and history...");
    const quarantine = join(staging, "quarantine.git");
    git.must("Failed to create quarantine repository", [
      "init",
      "--bare",
      "--quiet",
      "--template=",
      `--object-format=${objectFormatFor(request.commit)}`,
      quarantine,
    ]);
    importObjects(git, archiveGitDir, quarantine, request.commit);
    const type = git.run(["cat-file", "-t", request.commit], { gitDir: quarantine });
    if (!type.ok || type.stdout.trim() !== "commit") {
      throw new ImportError(`Commit ${request.commit} is not present in the archive's Git objects`);
    }
    const fsck = git.run(["fsck", "--full", "--no-dangling", "--no-progress", request.commit], {
      gitDir: quarantine,
    });
    if (!fsck.ok) {
      const detail = `${fsck.stdout}\n${fsck.stderr}`.trim().split("\n").slice(0, 5).join("; ");
      throw new ImportError(
        `Archive history for ${request.commit} is incomplete or corrupt: ${detail}`,
      );
    }
    checks.push("object-integrity", "complete-history");

    console.log("  Checking source tree...");
    checkCleanTree(git, quarantine, workTree, join(staging, "index"), request.commit);
    checks.push("clean-source-tree");

    if (cache.previous === request.commit) {
      outcome = "unchanged";
    } else if (cache.previous) {
      const known = git.run(["cat-file", "-e", `${cache.previous}^{commit}`], {
        gitDir: quarantine,
      });
      if (known.ok && isAncestor(git, quarantine, cache.previous, request.commit)) {
        outcome = "fast-forward";
        aheadCount = Number.parseInt(
          git.must(
            "Failed to count commits",
            ["rev-list", "--count", `${cache.previous}..${request.commit}`],
            {
              gitDir: quarantine,
            },
          ),
          10,
        );
        checks.push("fast-forward");
      } else if (known.ok && isAncestor(git, quarantine, request.commit, cache.previous)) {
        throw new ImportError(
          `Commit ${request.commit} is older than cached branch '${request.branch}' (${cache.previous}); refusing to move it backwards`,
        );
      } else {
        throw new ImportError(
          `Commit ${request.commit} diverges from cached branch '${request.branch}' (${cache.previous}); refusing to force-update`,
        );
      }
    } else {
      outcome = "created";
    }

    git.must("Failed to stage import ref", ["update-ref", IMPORT_REF, request.commit, ""], {
      gitDir: quarantine,
    });
    // Open the provenance log first so an unwritable log rejects the import before activation.
    mkdirSync(dirname(provenancePath), { recursive: true });
    logFd = openSync(provenancePath, "a");

    // Activation: everything above only touched the staging directory. Existing caches keep
    // their configuration; status and push sync the private URL from repo-sync.yaml.
    const branchRef = `refs/heads/${request.branch}`;
    let rollback = () => {};
    if (!cache.exists) {
      const candidate = join(staging, "cache.git");
      git.must("Failed to create cache repository", [
        "init",
        "--bare",
        "--quiet",
        "--template=",
        `--object-format=${objectFormatFor(request.commit)}`,
        `--initial-branch=${request.branch}`,
        candidate,
      ]);
      configureCache(git, candidate, repo);
      git.must(
        "Failed to transfer verified history",
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          quarantine,
          `${IMPORT_REF}:${branchRef}`,
        ],
        { gitDir: candidate },
      );
      mkdirSync(dirname(repoPath), { recursive: true });
      if (existsSync(repoPath) || isDanglingLink(repoPath)) {
        throw new ImportError(`Cache path appeared during import: ${repoPath}`);
      }
      renameSync(candidate, repoPath);
      rollback = () => renameSync(repoPath, candidate);
    } else if (outcome !== "unchanged") {
      git.must(
        "Failed to transfer verified history",
        ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", quarantine, IMPORT_REF],
        { gitDir: repoPath },
      );
      git.must(
        "Failed to update cache branch",
        [
          "update-ref",
          "-m",
          `repo-sync import ${record.archive.sha256}`,
          branchRef,
          request.commit,
          cache.previous ?? "",
        ],
        { gitDir: repoPath },
      );
      const previous = cache.previous;
      rollback = () => {
        const args = previous
          ? ["update-ref", branchRef, previous, request.commit]
          : ["update-ref", "-d", branchRef, request.commit];
        git.must("Failed to roll back cache branch", args, { gitDir: repoPath });
      };
    }

    record.result = outcome;
    record.validation.passed = true;
    try {
      writeFileSync(logFd, `${JSON.stringify(record)}\n`);
    } catch (err) {
      record.result = "rejected";
      record.validation.passed = false;
      rollback();
      throw new ImportError(
        `Failed to record provenance in ${provenancePath}; the import was rolled back: ${(err as Error).message}`,
      );
    }
  } catch (err) {
    const known = err instanceof ImportError || err instanceof ArchiveError;
    const message = known ? err.message : `Unexpected error: ${(err as Error).message}`;
    record.validation.error = message;
    const logged = tryAppendRecord(provenancePath, record);
    return {
      success: false,
      repoPath,
      provenancePath,
      record,
      error: logged ? message : `${message} (provenance could not be written to ${provenancePath})`,
    };
  } finally {
    archive?.close();
    if (logFd !== undefined) {
      closeSync(logFd);
    }
    rmSync(staging, { recursive: true, force: true });
  }

  return { success: true, outcome, repoPath, provenancePath, record, aheadCount };
}

function tryAppendRecord(path: string, record: ImportRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}
