import { type ExecSyncOptions, execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
    const error = err as Error & { stderr?: string };
    return {
      success: false,
      output: "",
      error: error.stderr || error.message,
    };
  }
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

export function fetchRemote(repoPath: string, remoteName: string): ExecResult {
  return exec(`git fetch ${remoteName}`, repoPath);
}

export function pushMirror(repoPath: string, remoteName: string): ExecResult {
  return exec(`git push --mirror ${remoteName}`, repoPath, false);
}

export function getLocalRefs(repoPath: string): Map<string, string> {
  const refs = new Map<string, string>();

  // Get branches
  const branches = exec(
    "git for-each-ref --format='%(refname:short) %(objectname)' refs/heads/",
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
    "git for-each-ref --format='%(refname:short) %(objectname)' refs/tags/",
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
      if (match) {
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
  const result = exec(`git merge-base --is-ancestor ${ancestor} ${descendant}`, repoPath);
  return result.success;
}

export function getCommitCount(repoPath: string, from: string, to: string): number {
  const result = exec(`git rev-list --count ${from}..${to}`, repoPath);
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
    const [type, name] = refName.split("/", 2);
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
      const [type, name] = refName.split("/", 2);
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
