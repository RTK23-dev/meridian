# Meridian Operator Guide & Control Center

Meridian provides an integrated Control Center for operators, growth engineers, and creative strategists to navigate across brands, execute tasks at high velocity, monitor background workers, and audit system actions.

---

## 1. Global Command Palette (`Cmd+K` / `Ctrl+K`)

The command palette is accessible from anywhere in the application by pressing `Cmd + K` (Mac) or `Ctrl + K` (Windows/Linux), or by typing `/` when no form field is focused.

### Capabilities
- **Brand Switching**: Instantly switch between any brand in the workspace without leaving the keyboard (searches brands by name).
- **Direct Navigation**: Jump directly to any core screen (`Overview`, `Factory`, `Market`, `Intelligence`, `Opportunities`, `Reviews`, `Studio`, `Library`, `Learning`, `Brand Brain`, `Products`, `Connected Accounts`).
- **One-Click Actions**:
  - `🚀 Multi-Account Publishing Queue`: Opens Studio scheduling dashboard.
  - `🧠 JEV Multimodal Account Intelligence`: Opens Account DNA and Whitespace radar.
  - `📈 Multi-Channel Performance Telemetry`: Opens Bayesian flywheel and telemetry ingestion.
  - `🔐 Encrypted Credential Vault & Accounts`: Opens vault account manager.
  - `🏭 Content Factory Pipeline`: Opens automated factory board.
- **System Actions**: Toggle theme (Dark/Light), refresh opportunities, switch workspace organization, and open keyboard shortcuts.

---

## 2. Keyboard Navigation Shortcuts

Meridian features high-velocity two-key chord shortcuts (inspired by Vim and Gmail). Press `G` followed by a destination key within 900ms:

| Shortcut | Destination | Description |
|---|---|---|
| `G` then `O` | Overview | Jumps to brand or workspace overview |
| `G` then `S` | Studio | Jumps to creative generation & variant matrix |
| `G` then `R` | Reviews | Jumps to human review gate queue |
| `G` then `I` | Intelligence | Jumps to JEV Account DNA & Whitespace Radar |
| `G` then `L` | Learning | Jumps to Telemetry & Bayesian Flywheel |
| `G` then `F` | Factory | Jumps to Content Factory automated pipeline |
| `G` then `A` | Accounts | Jumps to Connected Social Accounts & Vault |
| `?` | Help Modal | Displays all available keyboard shortcuts |
| `/` | Search | Opens the Command Palette |

---

## 3. Background Workers & Job Lifecycle

Meridian offloads all heavy video analysis, transcription, rendering, and publishing tasks to dedicated worker processes. The web process never performs background execution directly.

### Running Workers
```bash
# Terminal 1: Background Job Worker (Leases and executes jobs)
npm run worker

# Terminal 2: Periodic Scheduler (Enqueues recurring jobs)
npm run scheduler
```

### Worker Health Monitoring (`/jobs`)
Operators can monitor real-time worker operations at `/jobs`:
- **Worker Heartbeat**: Indicates whether `worker-entry.ts` is running and beating within the 30-second window.
- **Scheduler Heartbeat**: Indicates whether `scheduler-entry.ts` is active.
- **Queued / Retrying Counts**: Total jobs waiting for worker execution.
- **Dead Letter Queue**: Jobs that failed `max_attempts` with full diagnostic error payloads and one-click retry.

### Supported Worker Job Types
- `factory.decode`: Scene cut detection, keyframing, and OCR text extraction.
- `factory.embed`: pgvector 384-dimensional multimodal embedding computation.
- `factory.render`: Multi-aspect timeline composition assembly.
- `publishing.dispatch`: Claims and executes scheduled social posts via `orchestrator.ts`.
- `telemetry.sync`: Closes the Bayesian learning loop and updates JEV profile priors.
- `opportunity.refresh`: Re-ranks opportunities based on newest evidence.
- `video.generate` / `video.poll`: Communicates with Hypit video rendering engine.

---

## 4. Health & Observability Endpoint (`/api/health`)

For production monitoring (Kubernetes, AWS ECS, Datadog, Uptime Robot), Meridian exposes a health check endpoint at `/api/health`. Without a query string it is liveness only, and it is unauthenticated:

```json
{ "status": "ok" }
```

It reads no database and returns no counts.

`/api/health?detail=1` returns the operational detail. It needs a signed-in workspace admin, and it covers only that admin's active workspace. A signed-out caller gets `401`, and a member gets `403`. Job and queue counts are never summed across workspaces. When the database cannot be read, the affected values are `unknown` or `null`, not zero:

```json
{
  "status": "ok",
  "database": "up",
  "worker": "running",
  "scheduler": "running",
  "storage": { "status": "READY" },
  "localSemantic": "minilm",
  "externalEmbeddings": "CONNECTED",
  "video": "CONNECTED",
  "jobs": [
    { "status": "succeeded", "count": 142 },
    { "status": "queued", "count": 2 }
  ],
  "publishingQueue": [
    { "status": "published", "count": 48 },
    { "status": "queued", "count": 3 }
  ]
}
```

---

## 5. Audit Logging & Compliance (`/audit`)

Every mutation in Meridian records an immutable entry in the `audit_logs` table:
- **Actor Provenance**: User ID and name of the operator who triggered the action.
- **Action Code**: E.g. `account.connected`, `decision.approved`, `publish.scheduled`, `pattern.shared`.
- **Target Object**: Object type and ID affected.
- **Export**: One-click CSV download of all filtered audit rows for security compliance.
