# Obsidian S3 Sync Plugin

A robust, self-contained S3 synchronization plugin for Obsidian. Sync your vault with standard AWS S3 or compatible storage services (Cloudflare R2, MinIO, Backblaze B2, etc.) featuring automatic conflict resolution, **client-side zero-knowledge encryption**, and **native Gzip compression**.

---

## Key Features

- **Multi-Provider Compatibility**: Syncs with AWS S3, Cloudflare R2, MinIO, Backblaze B2, and other compatible object stores.
- **Zero-Knowledge Encryption**: All file contents are compressed and encrypted locally using **AES-GCM-256** (Web Crypto API) before upload. Your passphrase never leaves your device.
- **File Name (Key) Obfuscation**: Folder structures and filenames are cryptographically obfuscated on S3 using deterministic AES-GCM encryption, preventing metadata leaks.
- **Native Gzip Compression**: Pre-compresses text files using `CompressionStream` to reduce upload sizes by **60% to 80%** and speed up transfers.
- **Chronological 3-Way Auto-Merge**: Overlapping text line insertions are automatically merged in chronological order without prompting.
- **Interactive Conflict Resolution UI**: When conflicting updates occur on existing lines (or on binary files), sync pauses for those files and prompts the user with a premium side-by-side modal to select which version to keep.
- **Automatic Syncing**: Customizable periodic sync intervals and sync-on-startup support.

---

## Installation

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Move them into your vault's plugin directory:
   `<your-vault>/.obsidian/plugins/obsidian-s3-sync/`
3. Restart Obsidian, go to **Settings** -> **Community plugins**, and enable **S3 Sync**.

---

## AWS IAM Permissions

To run the sync plugin safely, the access key needs the following S3 permissions. Use this minimal IAM policy (replace `YOUR-BUCKET-NAME`):

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ListBucketPermissions",
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::YOUR-BUCKET-NAME"
            ]
        },
        {
            "Sid": "ObjectReadWriteDeletePermissions",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": [
                "arn:aws:s3:::YOUR-BUCKET-NAME/*"
            ]
        }
    ]
}
```

---

## Cryptographic Security Architecture

```
                                  [ Client-Side ]
Local Vault (Plaintext) 
        │
        ▼
Compression (Gzip Stream) ──► Encryption (AES-GCM-256) ──► Path Obfuscation (Hex IV + Ciphertext)
                                                                 │
                                                                 ▼
                                                       [ S3 Bucket (Obfuscated) ]
```

### 1. Key Derivation (PBKDF2)
- **PBKDF2-HMAC-SHA256** with **100,000 iterations** derives the 256-bit AES key.
- **Salt**: Deterministically generated from a SHA-256 hash of the S3 bucket name. This guarantees key uniqueness per bucket without saving local salt files.

### 2. Payload Encryption
- Uses a secure random **12-byte Initialization Vector (IV)** per file.
- Encrypts Gzip binary stream to construct the final upload payload: `[12-byte IV] + [Ciphertext]`.

### 3. Key/Path Obfuscation
- The S3 object key is derived by encrypting the vault-relative path (e.g. `Private/diary.md`) using AES-GCM-256 with a deterministic IV derived from the SHA-256 of the path itself.
- S3 Key = `Prefix/` + `hex(IV)` + `hex(Ciphertext)`.
- Other teammates using the same passphrase decode the hex key, extract the IV, and decrypt the path back to its plaintext representation.

---

## Conflict Resolution Matrix

| Local changed? | Remote changed? | File Type | Action / Resolution |
| :--- | :--- | :--- | :--- |
| **No** | **No** | Any | Do nothing. |
| **Yes** | **No** | Any | **Compress, Encrypt & Upload** local version. |
| **No** | **Yes** | Any | **Download, Decrypt & Decompress** to local vault. |
| **Yes** | **Yes** | **Binary** | **Interactive Prompt**: Prompt the user to select which file (local or remote) to keep. |
| **Yes** | **Yes** | **Text** | **Selective Resolution**: Auto-merge insertions. If updates overlap on existing text, prompt the user via modal to choose local, remote, or merge. |
| **Deleted** | **No** | Any | **Delete Remote**: Remove S3 object. |
| **No** | **Deleted** | Any | **Delete Local**: Remove file from vault. |
| **Deleted** | **Yes** | Any | **Re-download**: Recreate local file from remote (remote changes win). |
| **Yes** | **Deleted** | Any | **Re-upload**: Re-upload local file to remote (local changes win). |

---

## Development

Build the production bundle locally:

```bash
# Install dependencies
npm install

# Build & Bundle
npm run build
```
