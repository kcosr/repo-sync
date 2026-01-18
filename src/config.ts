import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config, RepoConfig } from "./types.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".repo-sync");
const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, "config.yaml");

export function getConfigPath(customPath?: string): string {
  return customPath || DEFAULT_CONFIG_PATH;
}

export function getTempDir(): string {
  return join(DEFAULT_CONFIG_DIR, "repos");
}

export function getRepoTempPath(repoName: string): string {
  return join(getTempDir(), `${repoName}.git`);
}

export function ensureConfigDir(): void {
  const configDir = DEFAULT_CONFIG_DIR;
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const tempDir = getTempDir();
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
}

export function loadConfig(configPath?: string): Config {
  const path = getConfigPath(configPath);

  if (!existsSync(path)) {
    throw new Error(
      `Config file not found: ${path}\nCreate it with:\n\n  mkdir -p ${dirname(path)}\n  cat > ${path} << 'EOF'\nrepos:\n  - name: example-repo\n    public: https://github.com/org/example-repo.git\n    private: git@private.company.com:vendor/example-repo.git\nEOF`,
    );
  }

  const content = readFileSync(path, "utf-8");
  const config = parseYaml(content) as Config;

  if (!config.repos || !Array.isArray(config.repos)) {
    throw new Error("Config must have a 'repos' array");
  }

  for (const repo of config.repos) {
    validateRepoConfig(repo);
  }

  return config;
}

function validateRepoConfig(repo: RepoConfig): void {
  if (!repo.name || typeof repo.name !== "string") {
    throw new Error("Each repo must have a 'name' string");
  }
  if (!repo.public || typeof repo.public !== "string") {
    throw new Error(`Repo '${repo.name}' must have a 'public' URL`);
  }
  if (!repo.private || typeof repo.private !== "string") {
    throw new Error(`Repo '${repo.name}' must have a 'private' URL`);
  }
}

export function findRepo(config: Config, name: string): RepoConfig | undefined {
  return config.repos.find((r) => r.name === name);
}
