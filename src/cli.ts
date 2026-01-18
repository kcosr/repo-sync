#!/usr/bin/env node

import { findRepo, loadConfig } from "./config.js";
import { clean, formatStatus, pull, push, status } from "./sync.js";
import type { RepoConfig } from "./types.js";

function printUsage(): void {
  console.log(`
repo-sync - Sync public repositories to private mirrors

Usage:
  repo-sync pull [repo-name]     Clone/fetch from public repos
  repo-sync status [repo-name]   Show sync status
  repo-sync push [repo-name]     Push to private repos
  repo-sync clean [repo-name]    Remove local temp clones

Options:
  -c, --config <path>   Path to config file (default: ~/.repo-sync/config.yaml)
  -h, --help            Show this help message

Examples:
  repo-sync pull                 Pull all configured repos
  repo-sync pull my-lib          Pull a specific repo
  repo-sync status               Show status of all repos
  repo-sync push                 Push all repos to private
  repo-sync push -y              Push without status check
`);
}

function parseArgs(args: string[]): {
  command: string;
  repoName?: string;
  configPath?: string;
  yes: boolean;
  help: boolean;
} {
  let command = "";
  let repoName: string | undefined;
  let configPath: string | undefined;
  let yes = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-y" || arg === "--yes") {
      yes = true;
    } else if (arg === "-c" || arg === "--config") {
      configPath = args[++i];
    } else if (!command) {
      command = arg;
    } else if (!repoName) {
      repoName = arg;
    }
  }

  return { command, repoName, configPath, yes, help };
}

function getRepos(configPath: string | undefined, repoName: string | undefined): RepoConfig[] {
  const config = loadConfig(configPath);

  if (repoName) {
    const repo = findRepo(config, repoName);
    if (!repo) {
      console.error(`Error: Repository '${repoName}' not found in config`);
      console.error(`Available repos: ${config.repos.map((r) => r.name).join(", ")}`);
      process.exit(1);
    }
    return [repo];
  }

  return config.repos;
}

function commandPull(repos: RepoConfig[]): void {
  console.log(`Pulling ${repos.length} repo(s)...\n`);

  let success = 0;
  let failed = 0;

  for (const repo of repos) {
    console.log(`${repo.name}:`);
    const result = pull(repo);

    if (result.success) {
      console.log(`  ✓ ${result.isNew ? "Cloned" : "Updated"}\n`);
      success++;
    } else {
      console.error(`  ✗ ${result.error}\n`);
      failed++;
    }
  }

  console.log(`\nPull complete: ${success} succeeded, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

function commandStatus(repos: RepoConfig[]): void {
  for (const repo of repos) {
    const result = status(repo);
    console.log(formatStatus(result));
  }
}

function commandPush(repos: RepoConfig[]): void {
  console.log(`Pushing ${repos.length} repo(s)...\n`);

  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const repo of repos) {
    console.log(`${repo.name}:`);
    const result = push(repo);

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
  if (failed > 0) {
    process.exit(1);
  }
}

function commandClean(repos: RepoConfig[]): void {
  console.log(`Cleaning ${repos.length} repo(s)...\n`);

  for (const repo of repos) {
    console.log(`${repo.name}: cleaning...`);
    clean(repo);
    console.log("  ✓ Removed\n");
  }

  console.log("Clean complete");
}

function main(): void {
  const args = process.argv.slice(2);
  const { command, repoName, configPath, help } = parseArgs(args);

  if (help || !command) {
    printUsage();
    process.exit(help ? 0 : 1);
  }

  try {
    const repos = getRepos(configPath, repoName);

    switch (command) {
      case "pull":
        commandPull(repos);
        break;
      case "status":
        commandStatus(repos);
        break;
      case "push":
        commandPush(repos);
        break;
      case "clean":
        commandClean(repos);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
