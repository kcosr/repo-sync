# Changelog

## [Unreleased]

### Breaking Changes

- Simplified `import` to accept `--archive` only; removed `--commit` and `--branch` options ([#6](https://github.com/kcosr/repo-sync/pull/6))
- Removed `markSourceDeleteClone`; source notices no longer create work clones. Use `clone` explicitly ([#6](https://github.com/kcosr/repo-sync/pull/6))

### Added

- Added `import` command and `source: archive` entries to seed and update repositories from source ZIPs with complete Git history. Broad `pull` skips archive entries ([#5](https://github.com/kcosr/repo-sync/pull/5))
- Added per-repository `sourceNotice: linked | generic | none`, with legacy `markSource` compatibility and generic notices for ZIP sources ([#6](https://github.com/kcosr/repo-sync/pull/6))

### Changed

- CLI now rejects unknown options, options missing a value and extra positional arguments ([#5](https://github.com/kcosr/repo-sync/pull/5))
- ZIP imports now synchronize all branches and tags atomically, require fast-forward branches and unchanged existing tags, and retain refs omitted by subsequent archives ([#6](https://github.com/kcosr/repo-sync/pull/6))
- Source notices are separate generated commits on private, preserving cached source history and unrelated README content when modes change ([#6](https://github.com/kcosr/repo-sync/pull/6))

### Fixed

- Fixed `status` reporting the `<remote>/HEAD` ref that Git 2.48+ creates as a branch deleted from public ([#5](https://github.com/kcosr/repo-sync/pull/5))
- Protected pushes with atomic ref updates, exact default-branch leases and complete ref listings for large mirrors ([#6](https://github.com/kcosr/repo-sync/pull/6))
- Preserved archive work-clone commits reachable through local branches, tags or cached branches during refresh ([#6](https://github.com/kcosr/repo-sync/pull/6))

### Removed

- Removed archive provenance records and manual ref rollback machinery in favor of Git's atomic fetch ([#6](https://github.com/kcosr/repo-sync/pull/6))
## [0.0.4] - 2026-02-17

### Breaking Changes

### Added

- Added `build:bun` script to compile a standalone Bun executable at `./bin/repo-sync` ([#4](https://github.com/kcosr/repo-sync/pull/4))

### Changed

### Fixed

### Removed

## [0.0.3] - 2026-02-17

### Breaking Changes

### Added

- Added `clone` command to create/update local work clones at `<cacheDir>/work/<repo-name>` from cached mirrors ([#3](https://github.com/kcosr/repo-sync/pull/3))

### Changed

### Fixed

- Fixed failed `git commit` handling to capture stdout so "nothing to commit" is treated as up-to-date during `markSource` runs ([#3](https://github.com/kcosr/repo-sync/pull/3))
- Fixed push ref syncing to avoid pushing remote-tracking refs by using explicit branch/tag refspecs with prune ([#3](https://github.com/kcosr/repo-sync/pull/3))

### Removed

## [0.0.2] - 2026-02-17

### Breaking Changes

### Added

### Changed

- Added top-level `cacheDir` config to control repo cache location, and moved `markSource` working clones under `<cacheDir>/work/<repo-name>` with `markSourceDeleteClone` controlling cleanup ([#2](https://github.com/kcosr/repo-sync/pull/2))

### Fixed

### Removed

## [0.0.1] - 2026-01-19

### Breaking Changes

### Added

- Added `markSource` config option to automatically add source repository notice to README files ([#1](https://github.com/kcosr/repo-sync/pull/1))

### Changed

### Fixed

### Removed

## [0.0.0] - 2026-01-17

Initial release.
