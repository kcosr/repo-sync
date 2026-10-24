import { findRepo, getArchiveLimits, getCacheDir, isArchiveRepo, loadConfig } from "./config.js";
import { importArchive } from "./import.js";
import { clean, clone, formatStatus, pull, push, status } from "./sync.js";
import type { Config, RepoConfig } from "./types.js";

const COMMANDS = ["pull", "import", "clone", "status", "push", "clean"];

export function printUsage(): void {
  console.log(`
repo-sync - Sync public repositories to private mirrors

Usage:
  repo-sync pull [repo-name]     Clone/fetch from public repos
  repo-sync import <repo-name> --archive <zip> --commit <sha> --branch <branch>
                                 Import a source ZIP into an archive-managed repo
  repo-sync clone [repo-name]    Create/update local work clone
  repo-sync status [repo-name]   Show sync status
  repo-sync push [repo-name]     Push to private repos
  repo-sync clean [repo-name]    Remove local temp clones

Options:
  -c, --config <path>   Path to config file (default: ./repo-sync.yaml)
  --archive <zip>       Source ZIP with complete Git history (import)
  --commit <sha>        Full commit ID the archive must be at (import)
  --branch <branch>     Branch to associate with the commit (import)
  -h, --help            Show this help message

Examples:
  repo-sync pull                 Pull all configured repos
  repo-sync pull my-lib          Pull a specific repo
  repo-sync import my-tool --archive my-tool_source.zip --commit <sha> --branch main
  repo-sync clone my-lib         Prepare local work clone for a repo
  repo-sync status               Show status of all repos
  repo-sync push                 Push all repos to private
  repo-sync push -y              Push without status check
`);
}

export interface ParsedArgs {
  command: string;
  repoName?: string;
  configPath?: string;
  archive?: string;
  commit?: string;
  branch?: string;
  yes: boolean;
  help: boolean;
}

const VALUE_OPTIONS: Record<string, "configPath" | "archive" | "commit" | "branch"> = {
  "-c": "configPath",
  "--config": "configPath",
  "--archive": "archive",
  "--commit": "commit",
  "--branch": "branch",
};

export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: "", yes: false, help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "-y" || arg === "--yes") {
      parsed.yes = true;
    } else if (arg in VALUE_OPTIONS) {
      const value = args[++i];
      if (value === undefined) {
        throw new Error(`Option ${arg} requires a value`);
      }
      parsed[VALUE_OPTIONS[arg]] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.command) {
      parsed.command = arg;
    } else if (!parsed.repoName) {
      parsed.repoName = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  const importOptions = [parsed.archive, parsed.commit, parsed.branch];
  if (parsed.command !== "import" && importOptions.some((value) => value !== undefined)) {
    throw new Error("--archive, --commit and --branch are only valid with 'import'");
  }

  return parsed;
}

function selectRepos(config: Config, repoName: string | undefined): RepoConfig[] | undefined {
  if (repoName) {
    const repo = findRepo(config, repoName);
    if (!repo) {
      console.error(`Error: Repository '${repoName}' not found in config`);
      console.error(`Available repos: ${config.repos.map((r) => r.name).join(", ")}`);
      return undefined;
    }
    return [repo];
  }

  return config.repos;
}

function importHint(name: string): string {
  return `repo-sync import ${name} --archive <zip> --commit <sha> --branch <branch>`;
}

function commandPull(repos: RepoConfig[], cacheDir: string, explicit: boolean): number {
  if (explicit && isArchiveRepo(repos[0])) {
    console.error(
      `Error: Repository '${repos[0].name}' is archive-managed; update it with '${importHint(repos[0].name)}'`,
    );
    return 1;
  }

  console.log(`Pulling ${repos.length} repo(s)...\n`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const repo of repos) {
    console.log(`${repo.name}:`);
    if (isArchiveRepo(repo)) {
      console.log("  - Skipped (archive-managed; update with 'repo-sync import')\n");
      skipped++;
      continue;
    }
    const result = pull(repo, { cacheDir });

    if (result.success) {
      console.log(`  ✓ ${result.isNew ? "Cloned" : "Updated"}\n`);
      success++;
    } else {
      console.error(`  ✗ ${result.error}\n`);
      failed++;
    }
  }

  const skippedSummary = skipped > 0 ? `, ${skipped} skipped (archive-managed)` : "";
  console.log(`\nPull complete: ${success} succeeded, ${failed} failed${skippedSummary}`);
  return failed > 0 ? 1 : 0;
}

async function commandImport(
  config: Config,
  repo: RepoConfig,
  cacheDir: string,
  args: ParsedArgs,
): Promise<number> {
  if (!isArchiveRepo(repo)) {
    console.error(
      `Error: Repository '${repo.name}' pulls from a public remote; set 'source: archive' to import archives`,
    );
    return 1;
  }
  const { archive, commit, branch } = args;
  if (!archive || !commit || !branch) {
    console.error(
      `Error: import requires --archive, --commit and --branch\n  ${importHint(repo.name)}`,
    );
    return 1;
  }

  console.log(`Importing ${repo.name}...\n`);
  const result = await importArchive(
    repo,
    { archivePath: archive, commit, branch },
    { cacheDir, limits: getArchiveLimits(config) },
  );

  if (result.record?.archive.sha256) {
    console.log(`  Archive: ${result.record.archive.path}`);
    console.log(`  SHA-256: ${result.record.archive.sha256}`);
  }

  if (!result.success) {
    console.error(`  ✗ Import rejected: ${result.error}`);
    if (result.record) {
      console.error(`  Previous cache state preserved. Provenance: ${result.provenancePath}`);
    }
    return 1;
  }

  const short = commit.substring(0, 12);
  if (result.outcome === "unchanged") {
    console.log(`  - Already imported: ${branch} is at ${short} (no changes)`);
  } else if (result.outcome === "fast-forward") {
    const previous = result.record?.previousCommit?.substring(0, 12);
    console.log(
      `  ✓ Fast-forwarded ${branch}: ${previous} → ${short} (+${result.aheadCount} commits)`,
    );
  } else {
    console.log(`  ✓ Created ${branch} at ${short}`);
  }
  console.log(`  Provenance: ${result.provenancePath}`);
  return 0;
}

function commandStatus(repos: RepoConfig[], cacheDir: string): number {
  for (const repo of repos) {
    const result = status(repo, { cacheDir });
    console.log(formatStatus(result));
  }
  return 0;
}

function commandClone(repos: RepoConfig[], cacheDir: string): number {
  console.log(`Preparing work clones for ${repos.length} repo(s)...\n`);

  let success = 0;
  let failed = 0;

  for (const repo of repos) {
    console.log(`${repo.name}:`);
    const result = clone(repo, { cacheDir });

    if (result.success) {
      console.log(`  ✓ Ready at ${result.clonePath}\n`);
      success++;
    } else {
      console.error(`  ✗ ${result.error}\n`);
      failed++;
    }
  }

  console.log(`\nClone complete: ${success} succeeded, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

function commandPush(repos: RepoConfig[], cacheDir: string): number {
  console.log(`Pushing ${repos.length} repo(s)...\n`);

  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const repo of repos) {
    console.log(`${repo.name}:`);
    const result = push(repo, { cacheDir });

    if (result.success) {
      if (result.pushed) {
        console.log("  ✓ Pushed\n");
        pushed++;
      } else {
        console.log("  - Already up to date\n");
        skipped++;
      }
    } else {
      console.error(`  ✗ ${result.error}\n`);
      failed++;
    }
  }

  console.log(`\nPush complete: ${pushed} pushed, ${skipped} skipped, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

function commandClean(repos: RepoConfig[], cacheDir: string): number {
  console.log(`Cleaning ${repos.length} repo(s)...\n`);

  for (const repo of repos) {
    console.log(`${repo.name}: cleaning...`);
    clean(repo, { cacheDir });
    console.log("  ✓ Removed\n");
  }

  console.log("Clean complete");
  return 0;
}

/** Runs the CLI with `args` (excluding the node/script prefix) and returns the exit code. */
export async function run(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    printUsage();
    return 1;
  }

  const { command, repoName, configPath, help } = parsed;
  if (help || !command) {
    printUsage();
    return help ? 0 : 1;
  }
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }
  if (command === "import" && !repoName) {
    console.error("Error: import requires a repository name");
    return 1;
  }

  try {
    const config = loadConfig(configPath);
    const cacheDir = getCacheDir(config);
    const repos = selectRepos(config, repoName);
    if (!repos) {
      return 1;
    }

    switch (command) {
      case "pull":
        return commandPull(repos, cacheDir, repoName !== undefined);
      case "import":
        return await commandImport(config, repos[0], cacheDir, parsed);
      case "clone":
        return commandClone(repos, cacheDir);
      case "status":
        return commandStatus(repos, cacheDir);
      case "push":
        return commandPush(repos, cacheDir);
      default:
        return commandClean(repos, cacheDir);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}
