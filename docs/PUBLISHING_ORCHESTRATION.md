# Multi-Account Social Publishing Orchestrator

Meridian provides a fault-tolerant multi-account publishing orchestrator (`src/lib/meridian/publishing/orchestrator.ts`), introduced in migration `0023_publishing_orchestration.sql`.

This system enables operators to schedule creative variants across multiple social accounts (Instagram Reels, TikTok, YouTube Shorts, Meta Ads) simultaneously with deterministic idempotency, automated rate limiting, exponential backoff retries, and immutable execution receipts.

---

## 1. Core Principles & Invariants

1. **Rule 1 Compliance**: Meridian never invents a publish receipt or connected state. Receipts are only created when an external platform confirms successful publication.
2. **Idempotency By Design**: Duplicate submissions within the same scheduling window produce identical idempotency hashes, preventing duplicate uploads even under network retries.
3. **Atomic Worker Claiming**: Distributed workers use PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` to claim scheduled jobs without race conditions or deadlocks.
4. **Tenant Isolation**: Every queue item and receipt is strictly scoped by `organization_id` and `brand_id`.

---

## 2. Idempotency Key Architecture

Idempotency keys are computed deterministically using SHA-256 over:
- `creativeId`: The unique ID of the creative variant.
- `targetAccountId`: The destination social account ID.
- `normalizedMinute`: The ISO timestamp truncated to the minute (`YYYY-MM-DDTHH:mm:00.000Z`).

```ts
export function buildIdempotencyKey(
  creativeId: string,
  targetAccountId: string,
  scheduledTimeIso: string,
): string {
  const date = new Date(scheduledTimeIso);
  date.setSeconds(0, 0); // Normalize to the minute
  const payload = `${creativeId}:${targetAccountId}:${date.toISOString()}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}
```

If an operator clicks "Schedule" multiple times or an automated flow re-triggers within the same minute, the database unique index on `(organization_id, brand_id, idempotency_key)` safely absorbs the duplicate.

---

## 3. Database Schema

### `publishing_queues`
Tracks pending, in-flight, and completed publishing tasks:

| Column | Type | Description |
|---|---|---|
| `id` | `text PRIMARY KEY` | UUID of the publishing queue job |
| `organization_id` | `text NOT NULL` | Tenant organization boundary |
| `brand_id` | `text NOT NULL` | Brand boundary |
| `creative_id` | `text NOT NULL` | Target creative variant |
| `target_account_id` | `text NOT NULL` | Target account in `platform_accounts` |
| `platform` | `text NOT NULL` | Social platform (`instagram`, `tiktok`, `youtube`, `meta`) |
| `target_type` | `text NOT NULL DEFAULT 'organic'` | `organic` or `paid_campaign` |
| `scheduled_time` | `timestamptz NOT NULL` | Target publication time |
| `status` | `text NOT NULL DEFAULT 'queued'` | `queued`, `processing`, `published`, `failed`, `cancelled` |
| `idempotency_key` | `text NOT NULL` | Unique minute-normalized hash |
| `attempts` | `integer NOT NULL DEFAULT 0` | Current execution attempt count |
| `max_attempts` | `integer NOT NULL DEFAULT 3` | Maximum allowed retries |
| `next_retry_at` | `timestamptz` | Backoff timestamp for next retry attempt |
| `receipt_id` | `text` | FK to confirmed `publishing_receipts` record |
| `error` | `text NOT NULL DEFAULT ''` | Diagnostic error message from last attempt |

### `publishing_receipts`
Immutable proof of live external publication:

| Column | Type | Description |
|---|---|---|
| `id` | `text PRIMARY KEY` | UUID of the receipt |
| `organization_id` | `text NOT NULL` | Tenant organization boundary |
| `brand_id` | `text NOT NULL` | Brand boundary |
| `queue_id` | `text` | Originating queue job ID |
| `platform` | `text NOT NULL` | Publishing platform |
| `account_id` | `text NOT NULL` | Destination account ID |
| `external_post_id` | `text NOT NULL` | Live platform post/reel/video ID |
| `external_url` | `text NOT NULL` | Public link to the published post |
| `status` | `text NOT NULL DEFAULT 'live'` | Live post status |
| `published_at` | `timestamptz NOT NULL` | Publication confirmation timestamp |
| `raw_response` | `jsonb NOT NULL DEFAULT '{}'` | Raw platform API response |

---

## 4. Exponential Backoff & Rate Limits

When a platform API returns a transient error (e.g., rate limits, network timeouts), the orchestrator calculates exponential backoff:

$$\text{delaySeconds} = \min(3600, 60 \times 2^{\text{attempt}})$$

- Attempt 0: 60 seconds (1 minute)
- Attempt 1: 120 seconds (2 minutes)
- Attempt 2: 240 seconds (4 minutes)
- Maximum ceiling: 3,600 seconds (1 hour)

After `max_attempts` (default: 3), the job transitions to `failed` status and alerts the operator.

### Platform Rate Limits
- **Instagram**: Maximum 25 posts/hour per account, minimum 120s between posts.
- **TikTok**: Maximum 30 posts/hour per account, minimum 60s between posts.
- **YouTube Shorts**: Maximum 10 uploads/hour per account, minimum 300s between uploads.

---

## 5. Studio Operator Workflow

Accessible at `/brands/$brandId/studio` under **Tab 5: Queue & Schedule**:
1. **Multi-Account Selector**: Operators select any number of connected accounts across Instagram, TikTok, and YouTube.
2. **Scheduling Controls**: Immediate publishing or future date/time pickers.
3. **Queue Monitor**: Real-time table displaying status badges (`QUEUED`, `PROCESSING`, `PUBLISHED`, `FAILED`), attempts count, and error diagnostics.
4. **Action Controls**: One-click **Retry** for failed jobs and **Cancel** for queued jobs.
5. **Receipts Feed**: Direct clickable links to live published posts with timestamped receipts.
