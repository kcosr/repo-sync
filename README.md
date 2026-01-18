# repo-sync

Sync public repositories to private mirrors. Keep local backup copies of open source dependencies in your private git server.

## Why?

- **Avoid disappearing dependencies** - If a public repo is deleted or goes private, you still have your copy
- **Deploy from your infrastructure** - Pull from your private mirror instead of public internet
- **Controlled upgrades** - Review changes before syncing to your private copy

## Installation

```bash
npm install -g repo-sync
```

Or run directly:
```bash
npx repo-sync
```

## Quick Start

1. Create a config file at `~/.repo-sync/config.yaml`:

```yaml
repos:
  - name: lodash
    public: https://github.com/lodash/lodash.git
    private: git@gitlab.company.com:vendor/lodash.git
  - name: express
    public: https://github.com/expressjs/express.git
    private: git@gitlab.company.com:vendor/express.git
```

2. Create empty target repos on your private git server

3. Pull from public sources:
```bash
repo-sync pull
```

4. Check what's changed:
```bash
repo-sync status
```

5. Push to your private mirrors:
```bash
repo-sync push
```

## Commands

### `repo-sync pull [repo-name]`

Clone or fetch from public repositories.

```bash
repo-sync pull              # Pull all configured repos
repo-sync pull lodash       # Pull a specific repo
```

On first run, this does a full `git clone --mirror`. On subsequent runs, it fetches updates.

### `repo-sync status [repo-name]`

Show sync status - what's different between public and your private mirror.

```bash
repo-sync status
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

### `repo-sync push [repo-name]`

Push to private mirrors. Only pushes if local (from public) is ahead of private.

```bash
repo-sync push              # Push all repos
repo-sync push lodash       # Push a specific repo
```

**Safety checks:**
- Won't push if private has commits not in public (shouldn't happen)
- Won't push if refs have diverged (needs manual intervention)
- Skips repos that are already up to date

### `repo-sync clean [repo-name]`

Remove local temporary clones.

```bash
repo-sync clean             # Clean all
repo-sync clean lodash      # Clean specific repo
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Custom config file path (default: `~/.repo-sync/config.yaml`) |
| `-h, --help` | Show help |

## Config File

Default location: `~/.repo-sync/config.yaml`

```yaml
repos:
  - name: repo-name          # Identifier (used in commands and temp storage)
    public: <url>            # Public repo URL (HTTPS, no auth needed)
    private: <url>           # Private repo URL (SSH or HTTPS with auth)
```

## How It Works

1. **Pull**: Does a `git clone --mirror` (or `git fetch --prune` on update) from public into a temporary bare repo at `~/.repo-sync/repos/<name>.git`

2. **Status**: Fetches refs from private, compares with local clone, shows what's new/changed

3. **Push**: Does a `git push --mirror` to private, which syncs all branches, tags, and refs

The `--mirror` flag ensures an exact copy - all branches, all tags, all history.

## Workflow Example

**Initial setup:**
```bash
# 1. Add repos to config
cat >> ~/.repo-sync/config.yaml << 'EOF'
repos:
  - name: react
    public: https://github.com/facebook/react.git
    private: git@gitlab.mycompany.com:vendor/react.git
EOF

# 2. Create empty 'react' repo on your GitLab

# 3. Initial sync
repo-sync pull react
repo-sync push react
```

**Regular updates:**
```bash
# Check what's new upstream
repo-sync pull
repo-sync status

# Review changes, then push
repo-sync push
```

## License

MIT
