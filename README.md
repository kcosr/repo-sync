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

### `import <repo-name> --archive <zip> --commit <sha> --branch <branch>`

Seed or update an [archive-managed](#archive-imports) repo from a source ZIP. Runs locally with no network access.

```bash
node dist/cli.js import my-tool \
  --archive /archives/my-tool_20261014T134606Z_ab368155984f_source.zip \
  --commit ab368155984f4656e2d94ebb622e0dd5a9e901ac \
  --branch main
```

- `--commit` is the full commit ID the archive must be at.
- `--branch` is the branch that commit is published as, whatever branch (or detached HEAD) the archive was on.

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

Remove cached mirror clones from `<cacheDir>/repos/` (default: `~/.repo-sync/repos/`). Import provenance in `<cacheDir>/imports/` is kept.

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
  maxBytes: 4294967296      # Total extracted bytes (default: 4 GiB)
  maxEntries: 200000        # ZIP entries (default: 200000)

repos:
  - name: repo-name          # Identifier (used in commands and cache storage)
    public: <url>            # Public repo URL (HTTPS, no auth needed)
    private: <url>           # Private repo URL (SSH or HTTPS with auth)
    markSource: true         # Optional: add notice to README showing source
    markSourceDeleteClone: false     # Optional: delete markSource working clone after push (default: true)

  - name: local-id           # Identifier; independent of the archive and private repo names
    source: archive          # Seeded and updated by `import`; no public URL
    private: <url>           # Private repo URL
```

`source` defaults to `remote`. Archive-managed entries cannot set `public`, `markSource` or `markSourceDeleteClone`.

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

## Archive imports

Some sources are delivered as ZIP archives rather than reachable remotes. An entry with `source: archive` gets its cache from `import` instead of `pull`, and otherwise uses the usual `status`, `push` and `clone` commands.

### Archive requirements

The ZIP must contain exactly one top-level directory holding a checkout with a real `.git` directory:

```
my-tool/
  .git/               # full, self-contained history
  ARCHIVE-INFO.json   # optional, may be untracked
  src/ ...            # working tree at the archived commit
```

Import rejects the archive unless:

- **History is self-contained.** No `.git` worktree pointer file, `commondir`, `shallow` file, grafts, object alternates or reftable storage. The selected commit and every object it reaches must be present and pass `git fsck`.
- **HEAD is the expected commit.** The archive's HEAD (a branch or detached) must resolve to `--commit`.
- **The source tree is clean.** Files and modes must match the commit exactly, with no modified, deleted or untracked files. The only exception is an untracked `ARCHIVE-INFO.json` beside `.git`.
- **The ZIP is safe to extract.** It may contain only relative paths without `..`, regular files, directories and symlinks that stay inside the top-level directory. Special files, nested `.git` directories, encrypted entries and overlapping entries are rejected, as are entries that fail size or CRC checks or exceed `archiveLimits`.

### What import does

1. Hashes the ZIP and extracts it into a new staging directory under `<cacheDir>/staging/`. The ZIP itself is never modified.
2. Copies the archive's Git objects into a fresh quarantine repository and verifies them there. The archive's `.git/config`, hooks, index, attributes and remotes are never used, and all Git commands run with repo-sync's own settings, so nothing supplied by the archive is executed.
3. Transfers only the history of `--commit` into `<cacheDir>/repos/<name>.git` and points `refs/heads/<branch>` at it. Commit IDs are preserved. Other archived branches and tags are not imported.
4. Removes the staging directory, whether the import succeeded or failed.

Activation happens only after every check passes. A new cache is moved into place in one rename, and an existing cache is updated with a compare-and-swap ref update. A rejected or failed import leaves the previous cache untouched, and if the provenance record cannot be written, activation is rolled back. Import never changes an existing cache's configuration (`status` and `push` pick up `private` URL changes from `repo-sync.yaml`), and it never touches work clones.

Updates must fast-forward. An archive whose commit is older than, or has diverged from, the cached branch is rejected rather than force-updated. To replace rewritten history, run `clean` and import again. Branches imported earlier stay in the cache even if a later archive no longer contains them. Re-importing the same archive is harmless and reports `Already imported`.

For archive-managed entries:

- `pull` skips them in broad runs and refuses them by name.
- `push` never force-pushes or prunes, so refs that exist only on private are kept. `status` lists them as `Kept on private`.
- `status` and `push` fail if private cannot be fetched, rather than trusting stale refs.
- `clone` only fast-forwards an existing work clone and refuses to drop its local commits, including commits on a detached HEAD.

### Provenance

Every import attempt appends one JSON line to `<cacheDir>/imports/<name>.jsonl`, outside the imported source tree. Each line records:

- the archive path, SHA-256, size and top-level directory
- the archive HEAD (a ref name, or `detached`)
- the commit and branch
- the previous commit, if any
- the result: `created`, `fast-forward`, `unchanged` or `rejected`
- the import time
- the validation checks that passed, or the rejection reason

`status` shows the most recent successful import.

### Archive workflow

```bash
node dist/cli.js import my-tool --archive my-tool_source.zip --commit <sha> --branch main
node dist/cli.js status my-tool   # Compare the imported branch with private
node dist/cli.js push my-tool     # Publish (fast-forward only, no deletions)
node dist/cli.js clone my-tool    # Working clone at <cacheDir>/work/my-tool
```

## How It Works

1. **Pull**: Does `git clone --mirror` (or `git fetch --prune`) from public into `<cacheDir>/repos/<name>.git` (default: `~/.repo-sync/repos/<name>.git`). Archive-managed entries are filled by `import` instead

2. **Clone**: Optionally prepares a local working clone at `<cacheDir>/work/<name>` from the cached mirror

3. **Status**: Fetches refs from private, compares with cached clone, shows what's new/changed

4. **Push**: Pushes branches and tags to private with prune, syncing updates and deletions

Push sync keeps branches/tags aligned with public history. For archive-managed entries, push only fast-forwards and never deletes.

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
