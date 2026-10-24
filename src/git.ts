import { type ExecSyncOptions, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RefComparison } from "./types.js";

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

export function exec(command: string, cwd?: string, silent = true): ExecResult {
  const options: ExecSyncOptions = {
    encoding: "utf-8",
    stdio: silent ? "pipe" : "inherit",
    cwd,
  };

  try {
    const output = execSync(command, options) as string;
    return { success: true, output: output?.trim() || "" };
  } catch (err) {
    const error = err as Error & { stderr?: string; stdout?: string };
    return {
      success: false,
      output: error.stdout?.trim() || "",
      error: error.stderr?.trim() || error.message,
    };
  }
}

function execGit(args: string[], cwd?: string, silent = true): ExecResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: silent ? "pipe" : "inherit",
  });
  return {
    success: result.status === 0,
    output: result.stdout?.trim() || "",
    error:
      result.status === 0
        ? undefined
        : result.stderr?.trim() || result.error?.message || `Git ${args[0]} failed`,
  };
}

export function cloneMirror(publicUrl: string, targetPath: string): ExecResult {
  return exec(`git clone --mirror "${publicUrl}" "${targetPath}"`);
}

export function fetchOrigin(repoPath: string): ExecResult {
  return exec("git fetch --prune origin", repoPath);
}

export function addRemote(repoPath: string, name: string, url: string): ExecResult {
  // Check if remote already exists
  const existing = exec(`git remote get-url ${name}`, repoPath);
  if (existing.success) {
    // Update if different
    if (existing.output !== url) {
      return exec(`git remote set-url ${name} "${url}"`, repoPath);
    }
    return { success: true, output: "" };
  }
  return exec(`git remote add ${name} "${url}"`, repoPath);
}

export function fetchRemote(repoPath: string, remoteName: string, prune = false): ExecResult {
  return execGit(["fetch", "--no-tags", ...(prune ? ["--prune"] : []), remoteName], repoPath);
}

export function getRemoteBranchHead(
  repoPath: string,
  remoteName: string,
  branch: string,
): ExecResult {
  const result = execGit(
    ["ls-remote", "--exit-code", "--refs", remoteName, `refs/heads/${branch}`],
    repoPath,
  );
  return { ...result, output: result.output.split(/\s/)[0] ?? "" };
}

export interface PushRefsOptions {
  mirror?: boolean;
  branchOverride?: { branch: string; commit: string; expected: string };
}

export function pushRefs(
  repoPath: string,
  remoteName: string,
  options: PushRefsOptions = {},
): ExecResult {
  const args = ["push", "--atomic"];
  if (options.mirror) args.push("--prune");
  if (options.branchOverride) {
    args.push(
      `--force-with-lease=refs/heads/${options.branchOverride.branch}:${options.branchOverride.expected}`,
    );
  }
  const force = options.mirror ? "+" : "";
  args.push(remoteName, `${force}refs/heads/*:refs/heads/*`, `${force}refs/tags/*:refs/tags/*`);
  if (options.branchOverride) {
    // Git gives an explicit refspec priority over a matching wildcard. Source
    // refs stay untouched, and the argument list stays bounded for large mirrors.
    args.push(`${options.branchOverride.commit}:refs/heads/${options.branchOverride.branch}`);
  }
  return execGit(args, repoPath, false);
}

export function isImportedCache(repoPath: string): boolean {
  return exec("git config --get repo-sync.source", repoPath).output === "archive";
}

export function getLocalRefs(repoPath: string): Map<string, string> {
  const refs = new Map<string, string>();

  // Get branches
  const branches = exec(
    "git for-each-ref --format='%(refname:lstrip=2) %(objectname)' refs/heads/",
    repoPath,
  );
  if (branches.success && branches.output) {
    for (const line of branches.output.split("\n")) {
      const [name, sha] = line.split(" ");
      if (name && sha) {
        refs.set(`heads/${name}`, sha);
      }
    }
  }

  // Get tags
  const tags = exec(
    "git for-each-ref --format='%(refname:lstrip=2) %(objectname)' refs/tags/",
    repoPath,
  );
  if (tags.success && tags.output) {
    for (const line of tags.output.split("\n")) {
      const [name, sha] = line.split(" ");
      if (name && sha) {
        refs.set(`tags/${name}`, sha);
      }
    }
  }

  return refs;
}

export function getRemoteRefs(repoPath: string, remoteName: string): Map<string, string> {
  const refs = new Map<string, string>();

  const result = exec(
    `git for-each-ref --format='%(refname) %(objectname)' refs/remotes/${remoteName}/`,
    repoPath,
  );

  if (result.success && result.output) {
    for (const line of result.output.split("\n")) {
      const match = line.match(/^refs\/remotes\/[^/]+\/(.+) ([a-f0-9]+)$/);
      // Git 2.48+ records the remote's default branch as the symbolic ref <remote>/HEAD.
      if (match && match[1] !== "HEAD") {
        const [, name, sha] = match;
        refs.set(`heads/${name}`, sha);
      }
    }
  }

  // For tags, we need to check the remote's tags directly
  // After fetch, remote tags are stored locally as regular tags
  // We compare against what we fetched from private
  const tagsResult = exec(`git ls-remote --tags ${remoteName}`, repoPath);

  if (tagsResult.success && tagsResult.output) {
    for (const line of tagsResult.output.split("\n")) {
      const match = line.match(/^([a-f0-9]+)\s+refs\/tags\/(.+)$/);
      if (match && !match[2].endsWith("^{}")) {
        const [, sha, name] = match;
        refs.set(`tags/${name}`, sha);
      }
    }
  }

  return refs;
}

export function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  const result = execGit(["merge-base", "--is-ancestor", ancestor, descendant], repoPath);
  return result.success;
}

export function getCommitCount(repoPath: string, from: string, to: string): number {
  const result = execGit(["rev-list", "--count", `${from}..${to}`], repoPath);
  if (result.success) {
    return Number.parseInt(result.output, 10) || 0;
  }
  return 0;
}

export function compareRefs(
  repoPath: string,
  localRefs: Map<string, string>,
  privateRefs: Map<string, string>,
): { branches: RefComparison[]; tags: RefComparison[] } {
  const branches: RefComparison[] = [];
  const tags: RefComparison[] = [];

  // Check all local refs
  for (const [refName, localSha] of localRefs) {
    const privateSha = privateRefs.get(refName) || null;
    const [type, ...nameParts] = refName.split("/");
    const name = nameParts.join("/");
    const target = type === "tags" ? tags : branches;

    if (!privateSha) {
      // New ref, doesn't exist on private
      target.push({
        name,
        localRef: localSha,
        privateRef: null,
        status: "new",
      });
    } else if (localSha === privateSha) {
      // Same commit
      target.push({
        name,
        localRef: localSha,
        privateRef: privateSha,
        status: "same",
      });
    } else {
      // Different commits - check relationship
      const localIsAncestor = isAncestor(repoPath, localSha, privateSha);
      const privateIsAncestor = isAncestor(repoPath, privateSha, localSha);

      if (privateIsAncestor) {
        // Private is ancestor of local = local is ahead
        const aheadCount = getCommitCount(repoPath, privateSha, localSha);
        target.push({
          name,
          localRef: localSha,
          privateRef: privateSha,
          status: "ahead",
          aheadCount,
        });
      } else if (localIsAncestor) {
        // Local is ancestor of private = local is behind (shouldn't happen)
        const behindCount = getCommitCount(repoPath, localSha, privateSha);
        target.push({
          name,
          localRef: localSha,
          privateRef: privateSha,
          status: "behind",
          behindCount,
        });
      } else {
        // Diverged
        target.push({
          name,
          localRef: localSha,
          privateRef: privateSha,
          status: "diverged",
        });
      }
    }
  }

  // Check for refs that exist on private but not locally (removed from public)
  for (const [refName, privateSha] of privateRefs) {
    if (!localRefs.has(refName)) {
      const [type, ...nameParts] = refName.split("/");
      const name = nameParts.join("/");
      const target = type === "tags" ? tags : branches;
      target.push({
        name,
        localRef: null,
        privateRef: privateSha,
        status: "missing",
      });
    }
  }

  return { branches, tags };
}

export function repoExists(repoPath: string): boolean {
  if (!existsSync(repoPath)) {
    return false;
  }
  // Check if it's a valid git repo
  const result = exec("git rev-parse --git-dir", repoPath);
  return result.success;
}

export function getRepoCloneTime(repoPath: string): Date | undefined {
  if (!existsSync(repoPath)) {
    return undefined;
  }
  const stats = statSync(repoPath);
  return stats.mtime;
}

export function getDefaultBranch(repoPath: string): string {
  // Try to get the default branch from HEAD
  const result = exec("git symbolic-ref HEAD", repoPath);
  if (result.success) {
    // Returns refs/heads/main or refs/heads/master
    return result.output.replace("refs/heads/", "");
  }
  // Fallback to main, then master
  const mainExists = exec("git show-ref --verify refs/heads/main", repoPath);
  if (mainExists.success) return "main";
  return "master";
}

export function getParentCommit(repoPath: string, commitRef: string): string | null {
  const result = execGit(["rev-parse", `${commitRef}^`], repoPath);
  if (result.success && result.output) {
    return result.output;
  }
  return null;
}

function sanitizeCloneName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Report commits a refresh cannot preserve: local commits on the target branch,
 * or a detached HEAD that no branch, tag, or cached remote branch contains.
 */
function findUnpreservedCommits(clonePath: string, branch: string): string | undefined {
  const target = `refs/remotes/origin/${branch}`;
  const localBranch = execGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    clonePath,
  );
  if (localBranch.success && !isAncestor(clonePath, `refs/heads/${branch}`, target)) {
    return `Work clone branch '${branch}' has commits that are not in the cache: ${clonePath}. Move or remove them before running clone.`;
  }
  const head = exec("git rev-parse --verify --quiet HEAD", clonePath);
  if (head.success && !isAncestor(clonePath, "HEAD", target)) {
    const refs = execGit(
      [
        "for-each-ref",
        "--contains",
        "HEAD",
        "--format=%(refname)",
        "refs/heads/",
        "refs/remotes/origin/",
        "refs/tags/",
      ],
      clonePath,
    );
    if (!refs.success || refs.output.length === 0) {
      return `Work clone HEAD has commits that are not on any branch, tag, or in the cache: ${clonePath}. Create a branch for them before running clone.`;
    }
  }
  return undefined;
}

function prepareWorkClone(
  repoPath: string,
  branch: string,
  clonePath: string,
  fastForwardOnly = false,
): ExecResult {
  mkdirSync(dirname(clonePath), { recursive: true });

  if (!existsSync(clonePath)) {
    const cloneResult = execGit([
      "clone",
      "--branch",
      branch,
      ...(fastForwardOnly ? [] : ["--single-branch"]),
      "--",
      repoPath,
      clonePath,
    ]);
    if (!cloneResult.success) {
      return {
        success: false,
        output: "",
        error: `Failed to clone to work directory: ${cloneResult.error}`,
      };
    }
  } else {
    const validRepoResult = exec("git rev-parse --git-dir", clonePath);
    if (!validRepoResult.success) {
      return {
        success: false,
        output: "",
        error: `Configured work clone path is not a git repo: ${clonePath}`,
      };
    }

    const dirtyResult = exec("git status --porcelain", clonePath);
    if (!dirtyResult.success) {
      return {
        success: false,
        output: "",
        error: `Failed to inspect work clone: ${dirtyResult.error}`,
      };
    }
    if (dirtyResult.output.trim().length > 0) {
      return {
        success: false,
        output: "",
        error: `Work clone has local changes: ${clonePath}. Commit/stash/reset changes before running clone.`,
      };
    }

    const currentOrigin = exec("git remote get-url origin", clonePath);
    if (!currentOrigin.success) {
      return {
        success: false,
        output: "",
        error: `Failed to read origin remote from work clone: ${currentOrigin.error}`,
      };
    }
    if (currentOrigin.output !== repoPath) {
      const updateOriginResult = execGit(["remote", "set-url", "origin", repoPath], clonePath);
      if (!updateOriginResult.success) {
        return {
          success: false,
          output: "",
          error: `Failed to update origin in work clone: ${updateOriginResult.error}`,
        };
      }
    }

    if (fastForwardOnly) {
      const refspecResult = execGit(
        ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        clonePath,
      );
      if (!refspecResult.success) {
        return {
          success: false,
          output: "",
          error: `Failed to configure work clone branches: ${refspecResult.error}`,
        };
      }
    }
    const fetchResult = execGit(
      ["fetch", ...(fastForwardOnly ? ["--tags"] : []), "origin"],
      clonePath,
    );
    if (!fetchResult.success) {
      return {
        success: false,
        output: "",
        error: `Failed to refresh work clone: ${fetchResult.error}`,
      };
    }

    if (fastForwardOnly) {
      const lossError = findUnpreservedCommits(clonePath, branch);
      if (lossError) {
        return { success: false, output: "", error: lossError };
      }
    }
  }

  const target = `refs/remotes/origin/${branch}`;
  const localBranch = execGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    clonePath,
  );
  const checkoutResult = fastForwardOnly
    ? localBranch.success
      ? execGit(["checkout", branch, "--"], clonePath)
      : execGit(["checkout", "--track", "-b", branch, target], clonePath)
    : execGit(["checkout", "-B", branch, target], clonePath);
  if (!checkoutResult.success) {
    return {
      success: false,
      output: "",
      error: `Failed to prepare branch '${branch}' in work clone: ${checkoutResult.error}`,
    };
  }

  if (fastForwardOnly) {
    const mergeResult = execGit(["merge", "--ff-only", "--no-edit", target], clonePath);
    if (!mergeResult.success) {
      return {
        success: false,
        output: "",
        error: `Failed to fast-forward branch '${branch}' in work clone: ${mergeResult.error}`,
      };
    }
  }

  return { success: true, output: "" };
}

export interface CloneWorkResult extends ExecResult {
  clonePath: string;
}

export function cloneWorkDir(
  repoPath: string,
  branch: string,
  cloneBaseDir: string,
  repoName: string,
  options: { fastForwardOnly?: boolean } = {},
): CloneWorkResult {
  const clonePath = join(cloneBaseDir, sanitizeCloneName(repoName));
  const prepareResult = prepareWorkClone(repoPath, branch, clonePath, options.fastForwardOnly);
  if (!prepareResult.success) {
    return {
      success: false,
      output: "",
      error: prepareResult.error,
      clonePath,
    };
  }
  return {
    success: true,
    output: "Work clone ready",
    clonePath,
  };
}
