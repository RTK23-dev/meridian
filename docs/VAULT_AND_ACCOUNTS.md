# Encrypted Credential Vault & Multi-Account Platform Management

Meridian provides an enterprise-grade, database-backed encrypted credential vault and multi-account platform manager (`src/lib/meridian/vault/` and `src/lib/meridian/accounts/`), introduced in migration `0021_credential_vault_and_multi_account.sql`.

This system eliminates single-account environment variable bottlenecks and enables agencies and brands to manage dozens of social and ad accounts concurrently with cryptographic security and strict tenant isolation.

---

## 1. Cryptographic Architecture

The credential vault encrypts all sensitive OAuth tokens, refresh tokens, API keys, and webhook secrets at rest using **AES-256-GCM** (Galois/Counter Mode).

### Cipher Specifications
- **Algorithm**: `AES-256-GCM`
- **Key Length**: 256 bits (32 bytes), derived from `VAULT_MASTER_KEY` environment variable or ephemeral in-memory fallback for local preview.
- **Initialization Vector (IV)**: 96-bit (12 bytes) cryptographically random IV generated via `crypto.randomBytes(12)` per encrypted payload. **IVs are never reused.**
- **Authentication Tag**: 128-bit (16 bytes) GCM auth tag guaranteeing data authenticity and integrity.
- **Tamper Protection**: Any tampering with ciphertext, IV, or authentication tag immediately causes decryption to fail and throw `Error("Tampered ciphertext or invalid tag")`.

```
Raw Secret (JSON/Token) ──▶ AES-256-GCM (Random IV + Key) ──▶ { Ciphertext, IV, AuthTag, KeyVersion }
                                                                             │
                                                                   Persisted in Postgres
                                                                 (credential_vault table)
```

---

## 2. Database Schema

### `credential_vault`
Stores encrypted credentials scoped by organization:

| Column | Type | Description |
|---|---|---|
| `id` | `text PRIMARY KEY` | UUID of the encrypted credential entry |
| `organization_id` | `text NOT NULL REFERENCES organizations` | Tenant organization boundary |
| `credential_type` | `text NOT NULL` | Type: `oauth_token`, `api_key`, `service_account`, `webhook_secret` |
| `ciphertext` | `text NOT NULL` | Base64-encoded encrypted payload |
| `iv` | `text NOT NULL` | Base64-encoded 96-bit IV |
| `tag` | `text NOT NULL` | Base64-encoded 128-bit GCM authentication tag |
| `key_version` | `integer NOT NULL DEFAULT 1` | Key rotation version tracking |
| `expires_at` | `timestamptz` | Token expiration timestamp (null for permanent keys) |
| `created_at` | `timestamptz` | Record creation timestamp |
| `updated_at` | `timestamptz` | Record last update timestamp |

### `platform_accounts`
Stores connected social media and advertising platform accounts linked to the vault:

| Column | Type | Description |
|---|---|---|
| `id` | `text PRIMARY KEY` | UUID of the connected account |
| `organization_id` | `text NOT NULL REFERENCES organizations` | Tenant organization boundary |
| `brand_id` | `text NOT NULL REFERENCES brands` | Brand boundary |
| `platform` | `text NOT NULL` | `instagram`, `facebook`, `youtube`, `tiktok`, `meta_ads`, `google_ads` |
| `account_type` | `text NOT NULL` | `social_page`, `ad_account`, `channel`, `creator_profile` |
| `external_account_id` | `text NOT NULL` | Platform external identifier (e.g. Meta Page ID, Channel ID) |
| `name` | `text NOT NULL` | Display name of the account |
| `handle` | `text NOT NULL` | Handle or username (e.g. `@brandhandle`) |
| `avatar_url` | `text NOT NULL` | Profile avatar URL |
| `credential_id` | `text REFERENCES credential_vault` | FK to the encrypted credentials in the vault |
| `status` | `text NOT NULL` | `connected`, `disconnected`, `expired`, `invalid_permissions` |
| `metadata` | `jsonb NOT NULL DEFAULT '{}'` | Platform-specific metadata (follower count, page roles, scopes) |

---

## 3. Account Lifecycle & State Machine

```
              Connect Account (Admin/Member)
                           │
                           ▼
                     [ CONNECTED ]
                     ▲           │
     Token Renewed   │           │ Token Revoked / Expired
                     │           ▼
               [ EXPIRED / INVALID_PERMISSIONS ]
                           │
                           │ Disconnect Requested
                           ▼
                    [ DISCONNECTED ]
```

1. **Connection**: An operator provides platform credentials or completes OAuth. The raw tokens are encrypted into `credential_vault` and linked to a new `platform_accounts` record with status `connected`.
2. **Execution**: Publishing and telemetry workers resolve credentials through `PlatformAccountManager.resolveAccountCredentials()`. If credentials have expired, the account status transitions to `expired` and publishing halts safely.
3. **Tenant Invariant**: A brand can never access credentials or accounts belonging to another brand or organization (`hasRole` and tenancy checks enforce this on every call).

---

## 4. Operator Interface

Accessible at `/brands/$brandId/accounts`:
- **Account Cards**: Visual cards grouped by platform displaying handle, account type, follower count, and real-time connection status.
- **Connect Drawer**: Connect modal allowing operators to link Instagram Pages, TikTok Business profiles, YouTube Channels, and Meta Ad accounts.
- **Connection Diagnostics**: Explicit error badges for `EXPIRED` or `INVALID_PERMISSIONS` with one-click re-authentication.
