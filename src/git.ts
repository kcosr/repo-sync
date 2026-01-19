import { type ExecSyncOptions, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export function addSourceNotice(repoPath: string, publicUrl: string, branch: string): ExecResult {
  const tempDir = join(tmpdir(), `repo-sync-${Date.now()}`);

  try {
    // Clone the bare repo to a temp working directory
    mkdirSync(tempDir, { recursive: true });
    const cloneResult = exec(
      `git clone "${repoPath}" "${tempDir}" --branch ${branch} --single-branch`,
    );
    if (!cloneResult.success) {
      return { success: false, output: "", error: `Failed to clone to temp: ${cloneResult.error}` };
    }

    // Find README file (case-insensitive)
    const readmeNames = [
      "README.md",
      "readme.md",
      "README.MD",
      "README",
      "readme",
      "README.txt",
      "readme.txt",
    ];
    let readmePath: string | null = null;
    let readmeName: string | null = null;

    for (const name of readmeNames) {
      const path = join(tempDir, name);
      if (existsSync(path)) {
        readmePath = path;
        readmeName = name;
        break;
      }
    }

    if (!readmePath || !readmeName) {
      // No README found, create one
      readmePath = join(tempDir, "README.md");
      readmeName = "README.md";
      writeFileSync(readmePath, "");
    }

    // Read current content
    const currentContent = readFileSync(readmePath, "utf-8");

    // Check if notice already exists (from previous sync)
    const noticeMarker = "<!-- repo-sync-source-notice -->";
    let newContent: string;

    if (currentContent.includes(noticeMarker)) {
      // Replace existing notice
      newContent = currentContent.replace(
        /<!-- repo-sync-source-notice -->[\s\S]*?<!-- end-repo-sync-source-notice -->\n*/,
        "",
      );
    } else {
      newContent = currentContent;
    }

    // Prepend notice
    const notice = `${noticeMarker}
> **📦 Mirrored Repository**
>
> This repository is automatically mirrored from [${publicUrl}](${publicUrl}).
> Do not commit directly to this repository.
<!-- end-repo-sync-source-notice -->

`;

    newContent = notice + newContent;
    writeFileSync(readmePath, newContent);

    // Configure git user for the commit
    exec('git config user.email "repo-sync@localhost"', tempDir);
    exec('git config user.name "repo-sync"', tempDir);

    // Commit the change
    exec(`git add "${readmeName}"`, tempDir);
    const commitResult = exec('git commit -m "Add source repository notice"', tempDir);
    if (!commitResult.success) {
      return { success: false, output: "", error: `Failed to commit: ${commitResult.error}` };
    }

    // Push back to the bare repo
    const pushResult = exec(`git push origin ${branch}`, tempDir);
    if (!pushResult.success) {
      return {
        success: false,
        output: "",
        error: `Failed to push to bare repo: ${pushResult.error}`,
      };
    }

    return { success: true, output: "Source notice added" };
  } finally {
    // Cleanup temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
