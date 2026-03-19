<p align="center">
  <img src="banner.png" alt="claude-hive" width="100%"/>
</p>

# claude-hive

Run multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents on a single VM. One supervisor process, concurrent execution, shared filesystem memory.

## Why

Running each agent on its own VM works, but it's wasteful — idle processes, inter-VM networking, duplicate services, and more infrastructure to maintain. Claude-hive consolidates multiple agents onto one box while keeping them independent: separate workspaces, separate identities, separate memory, but shared resources and instant delegation.

## Two Versions

| | **synapse-sdk.js** (production) | **Claude Code CLI** (interactive) |
|---|---|---|
| **Runtime** | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Claude Code CLI (`claude`) |
| **Auth** | API key (`ANTHROPIC_API_KEY`) | Claude Code subscription (Max plan) |
| **Use case** | Automation, crons, agent fleet, conversation threading | Interactive work, ad-hoc queries, development |
| **Billing** | Per-token API billing, task tracking | Subscription-based |
| **Features** | Task system, MCP passthrough, spawn throttle, conversation threading, scheduling, retries, approvals | Direct MCP tool access, lowest latency, no SDK overhead |

**SDK for automation, CLI for interactive use.** The SDK handles all automated workloads — cron tasks, agent delegation, conversation threading, heartbeat checks, and the approval workflow. It calls the API directly with per-token cost tracking, task management, and spawn dedup throttling.

**CLI for day-to-day interactive work.** When you `cd` into an agent's workspace and run `claude`, you get the same MCP tools (query builder, schema linking, etc.) with lower latency and no SDK overhead. The CLI reads MCP server config from `.claude.json` project settings. Use this for ad-hoc queries, exploration, and development — not for automated pipelines.

## How It Works

```
┌──────────────────────────────────────────────────────┐
│  synapse (supervisor)                        :18789  │
│                                                      │
│  POST /api/tasks        → create task (CRUD)         │
│  POST /spawn/agent-name → run task, return result    │
│  POST /hooks/sender     → external webhook           │
│  GET  /api/tasks        → list/filter tasks          │
│  GET  /health           → status + queue depth       │
│  GET  /api/usage        → token usage tracking       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Agent 1  │  │ Agent 2  │  │ Agent 3  │           │
│  │ CLAUDE.md│  │ CLAUDE.md│  │ CLAUDE.md│           │
│  │ TASKS.md │  │ TASKS.md │  │ TASKS.md │           │
│  │ memory/  │  │ memory/  │  │ memory/  │           │
│  └──────────┘  └──────────┘  └──────────┘           │
│  ┌─────────────────────────────────────────┐         │
│  │ Task Scheduler (60s) │ FLEET-TASKS.json │         │
│  └─────────────────────────────────────────┘         │
│               shared filesystem                      │
└──────────────────────────────────────────────────────┘
         ▲              ▲              ▲
         │              │              │
       cron          user msg      agent delegation
```

1. **Synapse** listens for HTTP requests and cron-triggered tasks
2. Each request runs the target agent with the given prompt
3. The agent reads its `CLAUDE.md` (identity + instructions), does the work, writes to memory
4. If Agent 1 needs Agent 2, it calls `curl http://localhost:18789/spawn/agent-2` — synchronous, gets result back in the same turn
5. All agents can read each other's memory files directly (no API needed)

## Quick Start

### 1. Prerequisites

```bash
# Node.js 22+
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22

# For SDK version (recommended):
npm install @anthropic-ai/claude-agent-sdk

# For CLI version (development only):
npm install -g @anthropic-ai/claude-code
```

### 2. Clone and configure

```bash
git clone https://github.com/justfeltlikerunning/claude-hive.git
cd claude-hive

# Set up your environment
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY and HOOK_TOKEN

# Set up synapse config (agent definitions, HiveLog URL, etc.)
cp synapse-config.example.js synapse-config.js
# Edit synapse-config.js — define your agents, set HIVELOG_URL
```

### 3. Create your agents

```bash
# Copy example templates
cp agents/agent-orchestrator/CLAUDE.md.example agents/agent-orchestrator/CLAUDE.md
cp agents/agent-data/CLAUDE.md.example agents/agent-data/CLAUDE.md
cp agents/agent-monitor/CLAUDE.md.example agents/agent-monitor/CLAUDE.md

# Create memory directories
mkdir -p agents/{agent-orchestrator,agent-data,agent-monitor}/memory

# Edit each CLAUDE.md to define your agent's role, personality, and instructions
```

### 4. Start the supervisor

```bash
# SDK version (production)
node synapse-sdk.js

# CLI version (development)
node synapse.js
```

Or install as a systemd service:

```bash
cp systemd/synapse.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now synapse.service
```

### 5. Test it

```bash
# Health check
curl http://localhost:18789/health

# Spawn an agent
curl -s http://localhost:18789/spawn/agent-orchestrator \
  -H "Content-Type: application/json" \
  -d '{"task": "Read your CLAUDE.md and introduce yourself."}'

# Spawn with budget limit (SDK version)
curl -s http://localhost:18789/spawn/agent-data \
  -H "Content-Type: application/json" \
  -d '{"task": "Run a data quality check.", "budget": "0.50"}'

# Send a webhook
curl -s http://localhost:18789/hooks/my-service \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -d '{"message": "New alert: disk usage at 90%", "agent": "agent-monitor"}'

# Check usage (SDK version)
curl -s http://localhost:18789/api/usage/summary | jq .
```

### 6. Set up scheduled tasks

```bash
# Copy and edit the example crontab
crontab crontab.example
# Customize schedules and prompts for your agents
```

## Directory Structure

```
~/
├── synapse-sdk.js                         # SDK supervisor (production)
├── synapse.js                             # CLI supervisor (development)
├── synapse-config.js                      # Agent definitions + config (gitignored)
├── synapse-config.example.js              # Config template (pushed)
├── .env                                   # API key + config (gitignored)
├── shared/
│   ├── FLEET-TASKS.json                   # Central task registry (auto-created)
│   └── tasks/                             # Task workspace (auto-created)
├── agents/
│   ├── agent-orchestrator/
│   │   ├── CLAUDE.md                      # Agent identity + instructions
│   │   ├── TASKS.md                       # Agent task queue (auto-generated)
│   │   ├── reports/                       # Task output files
│   │   └── memory/                        # Daily log files
│   │       └── 2026-03-18.md
│   ├── agent-data/
│   │   ├── CLAUDE.md
│   │   ├── TASKS.md
│   │   └── memory/
│   └── agent-monitor/
│       ├── CLAUDE.md
│       ├── TASKS.md
│       ├── memory/
│       └── scripts/                       # Agent-specific scripts
├── scripts/
│   ├── cron-runner.sh                     # Scheduled task runner
│   ├── heartbeat.sh                       # Silent heartbeat (alerts only on failure)
│   └── memory-search.sh                   # Cross-agent memory search
├── systemd/
│   └── synapse.service                    # systemd unit file
├── crontab.example                        # Example cron entries
├── hivelog/
│   ├── server.js                          # HiveLog dashboard server
│   ├── index.html                         # Dashboard UI
│   ├── package.json                       # Dependencies
│   ├── .env.example                       # Environment config template
│   ├── tasks.json                         # Local task board (auto-created)
│   └── query-log.db                       # Query log database (auto-created)
└── logs/                                  # Synapse logs (auto-created)
```

## Agent Delegation

The key feature. Agents can call each other synchronously during their execution:

```bash
# In your orchestrator's CLAUDE.md, tell it how to delegate:
#
# To query the database, spawn the data agent:
#   curl -s http://localhost:18789/spawn/agent-data \
#     -H "Content-Type: application/json" \
#     -d '{"task": "Query active records and return a summary"}'
#
# The result comes back in the same response.
```

This means your orchestrator can:
1. Receive a user message
2. Decide it needs a DB query
3. Spawn the data agent, get the result
4. Format and return the answer

All in one conversation turn. No polling. No file watching. No message queues.

## Memory

Each agent writes to daily memory files (`memory/YYYY-MM-DD.md`). Two levels:

**Supervisor level** — synapse automatically logs:
```
- [09:30:01] CRON START: Daily cross-check
- [09:30:45] CRON DONE: Daily cross-check
```

**Agent level** — Claude writes detailed notes (as instructed by CLAUDE.md):
```
## 09:30 Daily Cross-Check
- Queried active records — all stable
- Data quality: 98.5% coverage
- Flagged 3 records with missing values
```

**Cross-agent search:**
```bash
# Search all agent memories for a keyword
bash scripts/memory-search.sh "anomaly"

# Or agents just read each other's files directly:
cat ~/agents/agent-data/memory/2026-03-18.md
```

## Task System (v3)

The SDK version includes a full task management system. Tasks are the primary way to assign work to agents — they support scheduling, automatic retries, output file tracking, and escalation.

### Task Lifecycle

```
scheduled → pending → in_progress → completed
                 ↑                  → failed → (auto-retry up to 2x)
                 └────────────────────────────┘
                                    → failed (exhausted) → escalate to orchestrator
```

**States:**
- **scheduled** — Created with a future `scheduledDate`. The 60-second scheduler promotes these to `pending` when due.
- **pending** — Ready to run. Picked up by the next scheduler tick or executed immediately if created with `timeline: "immediate"`.
- **in_progress** — Currently being executed by an agent.
- **completed** — Done. Result text and any output files are recorded.
- **failed** — Execution failed. Automatically retried up to 2 times (3 total attempts). After exhausting retries, the task is escalated to the orchestrator agent via its memory log.

### TASKS.md

Each agent gets an auto-generated `TASKS.md` file in its workspace. This file is loaded as context before every agent execution, so agents are always aware of their task queue. It shows active tasks (pending, scheduled, in_progress, failed) and tasks completed today.

### Daily Rollover

On startup, synapse rolls incomplete tasks from previous days forward. Scheduled tasks with future dates are left alone; everything else (pending, failed with retries remaining) carries over.

### Escalation

When a task fails all retry attempts, synapse writes an `ESCALATION` entry to the orchestrator agent's memory log. This means the orchestrator sees it on its next run and can decide how to handle it — reassign, modify the prompt, or flag it for human review.

### Task Output Files

Tasks can request specific output formats (`xlsx`, `csv`, `pdf`, `md`, `json`, `png`). The agent is instructed to save files to its `reports/` directory. After completion, synapse checks for new files and records them on the task.

## API

### Task CRUD

#### `POST /api/tasks` — Create a task

```json
// Request
{
  "agent": "agent-data",
  "prompt": "Query all active records and generate a summary report",
  "format": "xlsx",
  "timeline": "immediate",
  "scheduledDate": null
}

// Response (201)
{
  "id": "TASK-20260319-001",
  "agent": "agent-data",
  "prompt": "Query all active records...",
  "status": "pending",
  "format": "xlsx",
  "timeline": "immediate",
  "created": "2026-03-19T09:00:00.000Z",
  "attempts": 0,
  "maxRetries": 2,
  ...
}
```

Set `timeline: "scheduled"` and provide a `scheduledDate` (ISO format, e.g. `"2026-03-20T09:00"`) to schedule for later.

#### `GET /api/tasks` — List tasks

```bash
# All tasks
curl http://localhost:18789/api/tasks

# Filter by agent
curl http://localhost:18789/api/tasks?agent=agent-data

# Filter by status
curl http://localhost:18789/api/tasks?status=pending

# Combine filters
curl http://localhost:18789/api/tasks?agent=agent-data&status=completed
```

#### `PUT /api/tasks/:id` — Update a task

Only tasks in `pending`, `scheduled`, or `failed` state can be edited. Editable fields: `prompt`, `agent`, `format`, `timeline`, `scheduledDate`, `status`.

```json
// Request
{"prompt": "Updated query with different parameters", "agent": "agent-orchestrator"}

// Response (200) — updated task object
```

#### `POST /api/tasks/:id/retry` — Retry a failed task

Resets attempts to 0 and re-executes. Only works on tasks in `failed` state.

```json
// Response (200)
{"status": "retrying", "taskId": "TASK-20260319-001"}
```

### Legacy Spawn

#### `POST /spawn/:agent`

Spawn an agent. Supports both synchronous (backward-compatible) and async callback modes. Creates a task record for tracking.

```json
// Synchronous — wait for result
{"task": "Run the daily health check", "timeout": 180000}

// Async callback — respond immediately, POST result to callbackUrl when done
{"task": "Generate the weekly report", "callbackUrl": "http://your-server/api/tasks/task-123/callback", "callbackTaskId": "task-123"}

// Sync response
{"agent": "agent-monitor", "status": "complete", "taskId": "TASK-20260319-002", "result": {"text": "All systems healthy...", "session_id": "..."}}

// Async response (immediate)
{"agent": "agent-data", "status": "accepted", "taskId": "TASK-20260319-003"}
```

The callback system eliminates dropped connections on long-running tasks. HiveLog uses callback mode by default — synapse accepts the task, runs it in the background, and POSTs the result back to HiveLog when complete.

### Webhooks

#### `POST /hooks/:sender`

External webhook. Accepts tasks asynchronously (returns 202 immediately). Requires `Authorization: Bearer YOUR_HOOK_TOKEN`. Creates a task record internally.

```json
// Request
{"message": "Check the database for anomalies", "agent": "agent-data"}

// Response
{"status": "accepted", "agent": "agent-data"}
```

### Status & Usage

#### `GET /health`

```json
{"status": "ok", "runtime": "sdk-v3", "agents": ["agent-orchestrator","agent-data","agent-monitor"], "activeJobs": 1, "queueDepth": 0, "uptime": 3600}
```

#### `GET /agents`

List all registered agents with their workspace paths and descriptions.

#### `GET /api/usage/summary`

Token usage summary — today, this week, this month, plus recent entries.

#### `GET /api/usage`

Full token usage data with daily/monthly rollups and per-agent breakdowns.

#### `GET /api/models`

List available Claude models from the API (with fallback to known models).

## Configuration

### `.env`

```env
ANTHROPIC_API_KEY=sk-ant-...    # Required
HOOK_TOKEN=your-secure-token     # Required — for /hooks endpoint auth
PORT=18789                       # Supervisor port (default: 18789)
MAX_CONCURRENT=5                 # Max parallel agent executions
```

### `synapse-config.js`

All agent definitions, network addresses, and deployment-specific values live here (gitignored). See `synapse-config.example.js` for the template.

```js
export default {
  HIVELOG_URL: "http://your-hivelog-host:3000",
  orchestratorAgent: "agent-orchestrator",
  agents: {
    "agent-orchestrator": {
      workspace: "agents/agent-orchestrator",
      description: "Orchestrator — task routing, messaging",
      model: "sonnet",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    },
    "agent-data": {
      workspace: "agents/agent-data",
      description: "Data agent — queries, reports",
      model: "sonnet",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      mcpConfigKey: "my-mcp-server",  // optional
    },
  },
  formatInstructions: { xlsx: "Save as Excel...", csv: "Save as CSV..." },
};
```

### Adding a new agent

1. Create `agents/my-agent/CLAUDE.md` with the agent's identity and instructions
2. Create `agents/my-agent/memory/`
3. Add the agent to `synapse-config.js`:
   ```js
   "my-agent": {
     workspace: "agents/my-agent",
     description: "What this agent does",
     model: "sonnet", // or "opus", "haiku"
     allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
     mcpConfigKey: "my-mcp-server",  // optional: pass an MCP server from .claude.json
   }
   ```
4. Restart synapse
5. Add cron entries if the agent needs scheduled tasks

### MCP Server Passthrough

Agents can have MCP servers passed to their SDK sessions. Configure the MCP server in your project's `.claude.json` file, then reference it by key in `synapse-config.js`:

```js
// synapse-config.js
"my-agent": {
  workspace: "agents/my-agent",
  mcpConfigKey: "my-mcp-server",  // key from .claude.json mcpServers
  ...
}
```

Synapse reads the MCP server config (command, args, env) from `.claude.json` and passes it to the SDK's `mcpServers` option. The MCP server starts as a subprocess for each agent session, giving the agent access to custom tools alongside the standard Claude Code tools.

## Concurrency

Multiple agents can run simultaneously without issues:

- Each agent execution is independent with its own workspace
- `MAX_CONCURRENT` controls how many can run at once (default: 5 for SDK, 3 for CLI)
- Excess jobs are queued (up to 20) and drained as slots open
- One API key handles all agents — rate limiting is handled automatically

Example: a cron fires agent-monitor at 9:00 AM, you're chatting with the orchestrator, and the orchestrator spawns agent-data for a query — all three run concurrently.

## Conversation Threading

Synapse uses the SDK's `resume` option for conversation threading. When you reply to a task that has a session ID, HiveLog sends the reply through synapse with `resume: <session_id>`, which gives the agent full prior conversation context. New tasks (no session) start fresh.

This means you can have a multi-turn conversation with an agent — each reply picks up exactly where the last turn left off, with full context. No CLI dependency for threading.

## Agent Handoff

Reply to any task and hand it to a different agent with full context. The handoff includes:

- The original task prompt
- All prior agent results
- Any output files produced
- Your new instruction

The receiving agent gets a synthesized context summary so it can pick up where the previous agent left off. The original task thread records a handoff note (no execution — just a note), and a new task is created for the target agent. This prevents duplicate sends — the handoff is atomic: one note on the source thread, one new task on the target.

## Smart Heartbeat (v3)

The `heartbeat.sh` script is a multi-phase health check with per-agent failure tracking:

**Phase 1 — Bash pre-check (free):** Checks TASKS.md for NEW failed tasks (per-agent count tracking — only alerts on increase, not stale failures), synapse log for NEW callback/job failures, synapse /health, HiveLog reachability, FLEET-OPS.md for open escalations. All bash — no LLM cost.

**Phase 2 — LLM triage (only if NEW issues found):** Creates a HiveLog task tagged `source: "alert"` for the orchestrator to diagnose. Falls back to direct synapse spawn if HiveLog is unreachable.

If healthy, writes `HEARTBEAT_OK` to the orchestrator's memory and exits.

**Dedup throttle:** Synapse includes a spawn-level dedup throttle that fingerprints alert content (stripping timestamps) and suppresses identical alerts for 2 hours. This prevents runaway token burn if the heartbeat or any other alert script fires repeatedly on the same issue. Non-alert spawns are never throttled.

Configure via environment variables:
```bash
export HIVELOG_URL="http://your-hivelog:3000"
export ORCHESTRATOR_AGENT="agent-orchestrator"
export HEARTBEAT_AGENTS="agent-orchestrator agent-data agent-monitor"
```

```bash
# Typical cron entries
*/30 6-19 * * * bash ~/scripts/heartbeat.sh   # every 30 min during work hours
0 20,22,0,2,4 * * * bash ~/scripts/heartbeat.sh  # every 2 hours overnight
```

## Task Watchdog

HiveLog includes a background watchdog (runs every 30 seconds) that detects orphaned tasks — tasks stuck in "running" status after synapse has finished all active jobs.

This catches the edge case where synapse completes a task but the HTTP response is lost (network timeout, connection reset, etc.). The watchdog cross-references HiveLog's running tasks against synapse's active job count. If synapse reports zero active jobs and a HiveLog task has been "running" for 2+ minutes, the watchdog marks it as failed with a clear message: "Task orphaned — synapse completed but response was lost. Retry the task."

Combined with the callback system, orphaned tasks are now rare — but the watchdog catches any that slip through.

## File Output Rules

Agents follow strict file output rules to prevent duplicate files accumulating across retries and follow-ups:

- **Overwrite, don't duplicate** — When producing output files (reports, exports, charts), agents overwrite the previous version rather than creating timestamped copies
- **Consistent naming** — Output files use descriptive names based on the task, not timestamps
- **Reports directory** — All output files go to the agent's `reports/` directory
- **Auto-detection** — Synapse checks for new files in `reports/` after task completion and records them on the task

## Source Tagging

Tasks have a `source` field that tracks where they came from:

- **`user`** — Created manually via the HiveLog UI (default)
- **`cron`** — Created by a scheduled cron job via `cron-runner.sh`
- **`heartbeat`** — Created by heartbeat checks via `cron-runner.sh`
- **`alert`** — Created automatically by `heartbeat.sh` when failures are detected
- **`handoff`** — Created when a task is handed off to a different agent

### How it works

The `cron-runner.sh` script accepts an optional third argument for the source label:

```bash
# Cron task
cron-runner.sh agent-data "Run daily analysis..." cron

# Heartbeat (prefer heartbeat.sh instead — silent unless problems detected)
cron-runner.sh agent-orchestrator "Heartbeat check..." heartbeat
```

The script creates tasks via the HiveLog API first (with conversation threading), falling back to direct synapse dispatch if HiveLog is unavailable.

### Source filter in HiveLog

The Tasks tab includes a source filter dropdown: **All sources**, **My tasks**, **Cron tasks**, **Heartbeats**. Cron and heartbeat tasks appear in the same unified task list as manually created tasks — they get the same conversation threading, retry, and reply capabilities.

Source badges appear on task cards to visually distinguish cron, heartbeat, alert, and handoff tasks from user-created ones.

## HiveLog — Fleet Dashboard (v4.7)

HiveLog is a web dashboard for monitoring and interacting with your agent fleet. It connects to synapse via HTTP and to the fleet server via SSH.

### Tabs

- **Tasks** — Create, run, retry, and search tasks. Multi-agent conversations with @mention pipeline routing. Threaded replies, file attachments, output downloads. Date range filter, status filters, search. Empty task validation.
- **Logs** — Side-by-side daily memory logs for each agent, auto-refreshing.
- **Queries** — Database query log with bar charts (hourly/daily), drill-down chart (agent → tool → queries) with cost/count/duration metrics, client breakdown, V2 adoption %. Real-time ingest via `POST /api/query-log` from MCP servers.
- **History** — Interaction log (JSONL) — every agent call with full prompt/response, tokens, cost, duration. Filterable by agent and date.
- **Ops** — Escalations + approval queue with full lifecycle: pending → approved/rejected/acknowledged. Discussion threads, agent review ("Ask Agent"), edit pending approvals, agent selection on approve (pick who executes), access-aware context. Status + date filters. Acknowledged status for data quality issues (tracks workaround + root fix needed). Dedup prevention on similar submissions.
- **Baseline** — Query engine effectiveness tracking. 10 test queries with copy buttons, per-question scoring (0-10), weekly trend comparison, query detail with expandable rows. Auto-matches test questions against query log.
- **Summary** — Weekly fleet summary generated by the orchestrator agent.
- **Usage** — Token usage and cost tracking: today, this week, this month, by agent, by hour.
- **Metrics** — Live line charts for CPU, RAM, GPU VRAM, temperature, utilization. Client-side history accumulation. Service health grid.

### Key Features (v4.x)

- **Multi-agent conversations** — Check "Multi-Agent", select agents, use @mentions for sequential pipeline routing
- **Per-agent output format** — `@agent-data [xlsx] export the report`
- **Discussion rounds** — 1-5 rounds of autonomous agent discussion with $3 cost cap and consensus auto-stop
- **Streaming pipeline** — Agents respond one-by-one via incremental callbacks, messages appear as each finishes
- **Task lifecycle** — Active → Incomplete (carry-forward) → Closed (done). Incomplete tasks float to top regardless of date filter
- **Checkpoint recovery** — Agents checkpoint progress to memory. On retry, only re-runs the failed step, not the entire task
- **Smart retry** — UI retry button checks agent memory for completed work before re-running
- **Auto-escalation** — On exhausted retries, orchestrator agent wakes immediately (no heartbeat delay). When resolved, original task auto-updates to green ✓
- **Callback retry** — 3 attempts with exponential backoff before giving up
- **Callback dedup** — `in_progress` + `complete` callbacks don't create duplicate messages
- **Config-driven** — `config.js` (gitignored) holds all IPs and agent names. `/api/config` serves agent info to frontend dynamically
- **Mobile-optimized** — Tab dropdown selector, hidden sidebar, compact status bar, grid filters. iPhone 13+ tested.
- **Collapsible sidebar** — Click ◀ to collapse for more content space. State persists across refreshes.
- **Tab-aware auto-refresh** — Only refreshes the active tab, pauses on scroll/click, skips if detail rows are expanded. Pull-to-refresh preserves current tab via URL hash.
- **Copy buttons** — Discreet copy buttons on expanded content (synapse tasks, baseline queries, query detail). Text-selectable expanded areas.
- **Copy thread** — One-tap copy of entire conversation as formatted markdown
- **Client identity** — Query log tracks `MCP_CLIENT_ID` and `MCP_CLIENT_TYPE` per query. Filter by client (SDK, CLI, desktop, laptop) in Queries tab.
- **Spawn dedup throttle** — Synapse fingerprints alert content and suppresses identical alerts for 2 hours. Prevents token burn on repeated heartbeat alerts.
- **Time-aware agents** — Synapse injects current datetime (configurable timezone) into agent context

### Setup

```bash
cd hivelog
cp config.example.js config.js
# Edit config.js — set your IPs, agent names, GPU service URLs
npm install
node server.js
```

**Requires:**
- Synapse running on the fleet server
- SSH access to the fleet server (for logs, crons, file downloads)
- Optional: node_exporter on fleet/GPU hosts for metrics
- Optional: nvidia-smi on GPU host for GPU metrics

### Architecture

HiveLog runs on a separate machine and proxies requests to synapse. It stores its own task board (threaded conversations), query log (SQLite), feedback, and interaction history locally.

```
Browser → HiveLog (:3000) → Synapse (:18789) → Agents
                          → SSH → Fleet server (logs, crons, files)
                          → SSH → GPU host (nvidia-smi)
                          → node_exporter (CPU/RAM metrics)
         Mobile (iOS) ────┘
```

## Related

- [claude-fleet](https://github.com/justfeltlikerunning/claude-fleet) — The distributed version (one agent per VM)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's CLI for Claude
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) — Anthropic's SDK for building agents

## License

MIT
