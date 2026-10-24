# repo-sync

Sync public repositories to private mirrors. Keep backup copies of open source dependencies in your private git server.

Repositories without a reachable upstream can be seeded and updated from source ZIP archives that carry complete Git history (see [Archive imports](#archive-imports)).

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
    sourceNotice: linked
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

Requires the repo to be pulled or imported first.

### `import <repo-name> --archive <zip>`

Seed or update an [archive-managed](#archive-imports) repo from the branches and tags in a source ZIP. Runs locally with no network access.

```bash
node dist/cli.js import my-tool \
  --archive /archives/my-tool_20261014T134606Z_ab368155984f_source.zip
```

### `push [repo-name]`

Push cached branches and tags to private mirrors and apply the configured source notice.

```bash
node dist/cli.js push              # Push all repos
node dist/cli.js push lodash       # Push a specific repo
```

**Safety checks:**
- Protects private commits beyond recognized generated source notices
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
archiveLimits:              # Optional: bounds for archive imports
  maxBytes: 4294967296      # Total declared ZIP contents (default: 4 GiB)
  maxEntries: 200000        # ZIP entries (default: 200000)

repos:
  - name: repo-name          # Identifier (used in commands and cache storage)
    public: <url>            # Public repo URL (HTTPS, no auth needed)
    private: <url>           # Private repo URL (SSH or HTTPS with auth)
    sourceNotice: linked     # Optional: linked, generic or none (default: none)

  - name: local-id           # Identifier; independent of the archive and private repo names
    source: archive          # Seeded and updated by `import`; no public URL
    private: <url>           # Private repo URL
    sourceNotice: generic    # Optional: archives support generic or none
```

`source` defaults to `remote`. Archive-managed entries cannot set `public` or use a linked source notice.

### Source notices

Set `sourceNotice` independently for each repository:

| Mode | Generated README banner | Sources |
|------|-------------------------|---------|
| `linked` | A mirror notice linking to the configured `public` URL | Remote only |
| `generic` | A mirror notice without a source URL | Remote or archive |
| `none` | No generated notice (default) | Remote or archive |

The generic banner uses the same format as the linked banner:

> **📦 Mirrored Repository**
>
> This repository is automatically mirrored from an external repository.
> Do not commit directly to this repository.

Enabled notices add one generated commit above the source tip on the private default branch. Cached source branches and work clones stay unchanged, preserving the original source commits and their IDs. Switching to `none` restores the source branch tip without a generated notice. Replacing or removing a verified generated notice uses an exact `--force-with-lease` check to protect unrelated private commits.

Notice settings control the generated banner only: `generic` does not remove URLs already present in repository files, configuration or history.

Existing configurations may use `markSource: true` for `linked` or `markSource: false` for `none`. Setting both `markSource` and `sourceNotice` is an error. Archive entries reject `linked`, including legacy `markSource: true`; use `sourceNotice: generic` for an archive notice.

The obsolete `markSourceDeleteClone` setting is rejected. Notices no longer create work clones; use `repo-sync clone` when you want a working checkout.

## Archive imports

Some sources are delivered as ZIP archives rather than reachable remotes. An entry with `source: archive` gets its cache from `import` instead of `pull`, and otherwise uses the usual `status`, `push` and `clone` commands.

### Archive requirements

The ZIP must contain exactly one top-level directory with a real, self-contained `.git` directory and at least one named branch:

```
my-tool/
  .git/       # complete Git history, branches and tags
  src/ ...    # optional working tree; ignored by import
```

Linked worktrees, shallow history and external object alternates are not self-contained. Imported history must pass Git integrity checks. Unsafe ZIP paths, unsupported entries and archives exceeding `archiveLimits` are rejected.

The working tree is ignored: modified, missing and untracked files do not affect the import. Only committed Git history is copied into the cache. Archive metadata files are also ignored.

### Import and sync behavior

Import reads the archive's Git data into a temporary repository, verifies it using controlled Git settings, then updates `<cacheDir>/repos/<name>.git`. Archive hooks and execution settings are not used. The ZIP is never modified, and staging files are removed when the import finishes.

All named branches and tags are imported with their original names and object IDs. Existing branches must fast-forward; existing tags cannot be replaced. Branches and tags omitted from a later archive stay in the cache. Re-importing the same ZIP is harmless. To replace rewritten history, run `clean` and import again.

A new cache uses the archive's default branch. For a detached HEAD, it selects a branch at that commit when available, otherwise the first named branch. Later imports preserve the cache's default branch.

For archive-managed entries:

- `pull` skips them in broad runs and refuses them by name.
- `push` requires source branch updates to fast-forward and keeps refs that exist only on private. Replacing a verified generated notice is the sole force-with-lease exception. `status` lists private-only refs as `Kept on private`.
- `status` and `push` fail if private cannot be fetched, rather than trusting stale refs.
- `clone` fetches all cached branches, only fast-forwards an existing work clone and refuses to drop its local commits, including commits on a detached HEAD.

Import never changes work clones. Repositories configured with a public URL retain the usual remote pull and mirror push behavior.

### Archive workflow

```bash
node dist/cli.js import my-tool --archive my-tool_source.zip
node dist/cli.js status my-tool   # Compare imported branches and tags with private
node dist/cli.js push my-tool     # Publish branches/tags; keep private-only refs
node dist/cli.js clone my-tool    # Working clone at <cacheDir>/work/my-tool
```

## How It Works

1. **Pull**: Does `git clone --mirror` (or `git fetch --prune`) from public into `<cacheDir>/repos/<name>.git` (default: `~/.repo-sync/repos/<name>.git`). Archive-managed entries are filled by `import` instead

2. **Clone**: Optionally prepares a local working clone at `<cacheDir>/work/<name>` from the cached mirror

3. **Status**: Fetches refs from private, compares with cached clone, shows what's new/changed

4. **Push**: Pushes branches and tags to private with prune, syncing updates and deletions

Push sync keeps branches/tags aligned with public history. Archive-managed entries preserve private-only refs and reject source-history rewrites; source notices follow the checks described above.

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
