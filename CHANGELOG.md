# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-06-13

### Added
- **Millisecond-Precision mtime Embedding**: Prefixed encrypted payloads with the local file modification time (`mtime`) at millisecond resolution to ensure extremely accurate order-of-events merging.
- **Backward-Compatible SYNC Header**: Added a 5-byte `SYNC` magic prefix (`SYNC` ASCII bytes + format version byte) preceding the embedded `mtime` to dynamically identify upgraded payloads, preventing potential note corruption on vaults upgraded from `0.1.0`.
- **Markerless Chronological Auto-Merge**: Overlapping text line edits are automatically resolved by chronological order of modification (earlier on top, later on bottom) without injecting messy git conflict markers.

### Fixed
- **Electron Host Header Issue**: Fixed `net::ERR_INVALID_ARGUMENT` connection error by stripping the manual `Host` header from request parameters immediately before calling `requestUrl`.

---

## [0.1.0] - 2026-06-13

### Added
- **S3 Sync Core**: Full-featured, self-contained S3 synchronization using Obsidian's native `requestUrl` to bypass CORS.
- **Zero-Knowledge Encryption**: AES-GCM-256 local client-side encryption using native Web Crypto API.
- **Key Obfuscation**: Zero-knowledge encryption of directory paths and file names to prevent metadata exposure in the S3 bucket.
- **Gzip Compression**: Pre-compression of notes using `CompressionStream` to reduce data footprint by 60% to 80%.
- **Settings UI**: Test Connection utility, custom S3 endpoint configurations, passphrase input, device naming, and sync interval scheduling.
- **Gitignore & Licenses**: Configured project rules and licensed the repository under the permissive MIT license.
