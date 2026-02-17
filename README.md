# repo-sync

Sync public repositories to private mirrors. Keep backup copies of open source dependencies in your private git server.

## Why?

- **Avoid disappearing dependencies** - If a public repo is deleted or goes private, you still have your copy
- **Deploy from your infrastructure** - Pull from your private mirror instead of public internet
- **Controlled upgrades** - Review changes before syncing to your private copy

## Setup

1. Clone this repo:
```bash
git clone https://github.com/kcosr/repo-sync.git
cd repo-sync
npm install
npm run build
npm run build:bun   # Optional: build standalone Bun executable at ./bin/repo-sync
```

2. Edit `repo-sync.yaml` with your repos:
```yaml
cacheDir: /Users/you/.repo-sync

repos:
  - name: lodash
    public: https://github.com/lodash/lodash.git
    private: git@gitlab.company.com:vendor/lodash.git
    markSource: true
    markSourceDeleteClone: false
  - name: express
    public: https://github.com/expressjs/express.git
    private: git@gitlab.company.com:vendor/express.git
```

3. Create empty target repos on your private git server

4. Sync:
```bash
node dist/cli.js pull      # Clone/fetch from public
node dist/cli.js status    # See what's changed
node dist/cli.js push      # Push to private mirrors
```

## Commands

### `pull [repo-name]`

Clone or fetch from public repositories.

```bash
node dist/cli.js pull              # Pull all configured repos
node dist/cli.js pull lodash       # Pull a specific repo
```

On first run, does a full `git clone --mirror`. On subsequent runs, fetches updates.

### `status [repo-name]`

Show sync status - what's different between public and your private mirror.

```bash
node dist/cli.js status
```

Example output:
```
lodash
  Public:  https://github.com/lodash/lodash.git
  Private: git@gitlab.company.com:vendor/lodash.git
  Pulled:  1/17/2026, 10:30:00 AM
  Branches:
    main: abc1234 → def5678 (+12 commits)
  Tags:
    v4.18.0: abc1234 (new)
```

### `clone [repo-name]`

Create or update a local working clone at `<cacheDir>/work/<repo-name>` from the cached mirror.

```bash
node dist/cli.js clone              # Prepare work clones for all repos
node dist/cli.js clone lodash       # Prepare work clone for one repo
```

Requires the repo to be pulled first (`pull`).

### `push [repo-name]`

Push to private mirrors. Only pushes if local (from public) is ahead of private.

```bash
node dist/cli.js push              # Push all repos
node dist/cli.js push lodash       # Push a specific repo
```

**Safety checks:**
- Won't push if private has commits not in public (shouldn't happen)
- Won't push if refs have diverged (needs manual intervention)
- Skips repos that are already up to date

### `clean [repo-name]`

Remove cached mirror clones from `<cacheDir>/repos/` (default: `~/.repo-sync/repos/`).

```bash
node dist/cli.js clean             # Clean all
node dist/cli.js clean lodash      # Clean specific repo
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Custom config file path (default: `./repo-sync.yaml`) |
| `-h, --help` | Show help |

## Config File

Edit `repo-sync.yaml` in this repo:

```yaml
cacheDir: <path>            # Optional: root data dir (default: ~/.repo-sync)

repos:
  - name: repo-name          # Identifier (used in commands and cache storage)
    public: <url>            # Public repo URL (HTTPS, no auth needed)
    private: <url>           # Private repo URL (SSH or HTTPS with auth)
    markSource: true         # Optional: add notice to README showing source
    markSourceDeleteClone: false     # Optional: delete markSource working clone after push (default: true)
```

### `markSource` Option

When `markSource: true` is set, the tool adds a notice to the top of the README indicating where the repository was mirrored from:

```markdown
> **📦 Mirrored Repository**
>
> This repository is automatically mirrored from [https://github.com/org/repo](https://github.com/org/repo).
> Do not commit directly to this repository.
```

This adds one commit on top of the public history. On each sync, this commit is recreated.

When `markSource` is enabled, these optional per-repo settings control the working clone used to create that commit:

- `markSourceDeleteClone`: Whether to delete the working clone after each push. Defaults to `true`.

If `markSourceDeleteClone: false`, the tool keeps and reuses a clone at:

`<cacheDir>/work/<repo-name>` (default: `~/.repo-sync/work/<repo-name>`)

## How It Works

1. **Pull**: Does `git clone --mirror` (or `git fetch --prune`) from public into `<cacheDir>/repos/<name>.git` (default: `~/.repo-sync/repos/<name>.git`)

2. **Clone**: Optionally prepares a local working clone at `<cacheDir>/work/<name>` from the cached mirror

3. **Status**: Fetches refs from private, compares with cached clone, shows what's new/changed

4. **Push**: Pushes branches and tags to private with prune, syncing updates and deletions

Push sync keeps branches/tags aligned with public history.

## Typical Workflow

```bash
cd repo-sync

# Check what's new upstream
node dist/cli.js pull
node dist/cli.js status

# Review changes, then push
node dist/cli.js push
```

## Standalone Binary

Build a standalone executable with Bun:

```bash
npm run build:bun
./bin/repo-sync --help
```

## License

MIT
