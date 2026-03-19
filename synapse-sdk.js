import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import http from "node:http";

// ── Config ───────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || homedir();
const PORT = parseInt(process.env.HOOK_PORT || "18789");
const HOOK_TOKEN = process.env.HOOK_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "5");
const TASKS_DIR = join(HOME, "shared", "tasks");
const FLEET_TASKS_FILE = join(HOME, "shared", "FLEET-TASKS.json");

mkdirSync(TASKS_DIR, { recursive: true });

// Load config from synapse-config.js (gitignored — never pushed)
let CFG = { agents: {}, orchestratorAgent: "agent", HIVELOG_URL: "", formatInstructions: {} };
try {
  CFG = (await import(join(HOME, "synapse-config.js"))).default;
} catch (e) {
  console.error("⚠️ synapse-config.js not found — copy synapse-config.example.js and configure");
}

// Build AGENTS from config, resolving MCP servers from .claude.json
const AGENTS = {};
for (const [name, cfg] of Object.entries(CFG.agents)) {
  const agent = {
    workspace: join(HOME, cfg.workspace),
    description: cfg.description,
    model: cfg.model || "sonnet",
    allowedTools: cfg.allowedTools || ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  };

  // Load MCP server config if specified
  if (cfg.mcpConfigKey) {
    try {
      const claudeJson = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
      const mcpCfg = claudeJson.projects?.[join(HOME, cfg.workspace)]?.mcpServers?.[cfg.mcpConfigKey];
      if (mcpCfg) {
        agent.mcpServers = { [cfg.mcpConfigKey]: { command: mcpCfg.command, args: mcpCfg.args, env: { ...mcpCfg.env, ...(cfg.mcpEnvOverrides || {}) } } };
      }
    } catch { /* no MCP config — agent falls back to CLI tools */ }
  }

  AGENTS[name] = agent;
}

// ── State ────────────────────────────────────────────────────────────────────
let activeJobs = 0;
const jobQueue = [];
const MAX_JOB_QUEUE = 20;

// ── Spawn Dedup Throttle ────────────────────────────────────────────────────
// Prevents duplicate alert spawns from burning tokens on the same issue.
// Fingerprints the issue content (strips timestamps/dates), throttles identical
// fingerprints for THROTTLE_WINDOW_MS. Changed or escalated issues always pass.
const THROTTLE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const spawnFingerprints = new Map(); // fingerprint → { lastSpawned, count }

function getSpawnFingerprint(agent, prompt) {
  // Strip timestamps, dates, and task IDs to get the issue essence
  const normalized = prompt
    .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
    .replace(/\d{2}:\d{2}:\d{2}/g, "TIME")
    .replace(/TASK-\w+/g, "TASK")
    .replace(/\d+ callback failure/g, "N callback failure")
    .replace(/\d+ failed task/g, "N failed task")
    .replace(/\d+ NEW/g, "N NEW")
    .replace(/total: \d+/g, "total: N")
    .replace(/\s+/g, " ")
    .trim();
  // Simple hash
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `${agent}:${hash}`;
}

function shouldThrottleSpawn(agent, prompt, source) {
  // Never throttle non-alert spawns (user tasks, cron jobs, etc)
  if (source !== "alert" && source !== "heartbeat") return false;
  // Never throttle if prompt doesn't look like an alert
  if (!/ALERT|HEARTBEAT|failed|failure|error|down|unreachable/i.test(prompt)) return false;

  const fp = getSpawnFingerprint(agent, prompt);
  const existing = spawnFingerprints.get(fp);
  const now = Date.now();

  if (existing && (now - existing.lastSpawned) < THROTTLE_WINDOW_MS) {
    existing.count++;
    logSynapse(`[${agent}] Spawn THROTTLED (same alert fingerprint, ${existing.count} dupes in ${Math.round((now - existing.lastSpawned) / 60000)}min)`);
    return true;
  }

  spawnFingerprints.set(fp, { lastSpawned: now, count: 0 });
  // Cleanup old fingerprints
  for (const [k, v] of spawnFingerprints) {
    if (now - v.lastSpawned > THROTTLE_WINDOW_MS * 2) spawnFingerprints.delete(k);
  }
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function localDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA");
  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  return { date, time, iso: now.toISOString() };
}

function flockAppend(file, content) {
  const lockFile = `/tmp/synapse-${file.replace(/[^a-z0-9]/gi, "-")}.lock`;
  try {
    execSync(`flock "${lockFile}" -c 'cat >> "${file}"' <<'FEOF'\n${content}\nFEOF`, { timeout: 5000 });
  } catch {
    appendFileSync(file, content + "\n");
  }
}

function logToMemory(agentName, message) {
  const { date, time } = localDateTime();
  const memDir = join(AGENTS[agentName]?.workspace || HOME, "memory");
  mkdirSync(memDir, { recursive: true });
  const file = join(memDir, `${date}.md`);
  if (!existsSync(file)) writeFileSync(file, `# ${date} — ${agentName} Daily Log\n\n`);
  flockAppend(file, `- [${time}] ${message}`);
}

function logSynapse(message) {
  const { date, time } = localDateTime();
  const logDir = join(HOME, "logs");
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, `synapse-${date}.log`), `[${time}] ${message}\n`);
  console.log(`[${time}] ${message}`);
}

function logInteraction(agent, prompt, response, meta = {}) {
  const { date, iso } = localDateTime();
  const logDir = join(HOME, "logs", "interactions");
  mkdirSync(logDir, { recursive: true });
  const entry = {
    ts: iso, agent,
    prompt: prompt.substring(0, 10000),
    response: response.substring(0, 50000),
    tokens_in: meta.input || 0, tokens_out: meta.output || 0,
    cost: meta.cost || 0, model: meta.model || "unknown",
    duration_ms: meta.duration_ms || 0, num_turns: meta.num_turns || 0,
    session_id: meta.session_id || null, source: meta.source || "synapse",
    status: meta.status || "success",
  };
  flockAppend(join(logDir, `${date}.jsonl`), JSON.stringify(entry));
}

// ── Task System ──────────────────────────────────────────────────────────────
function loadTasks() {
  try { return JSON.parse(readFileSync(FLEET_TASKS_FILE, "utf-8")); }
  catch { return []; }
}

function saveTasks(tasks) {
  writeFileSync(FLEET_TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function generateTaskId() {
  const { date } = localDateTime();
  const seq = String(loadTasks().filter(t => t.id.startsWith(`TASK-${date.replace(/-/g, "")}`)).length + 1).padStart(3, "0");
  return `TASK-${date.replace(/-/g, "")}-${seq}`;
}

function createTask({ agent, prompt, format, timeline, source, scheduledDate, parentTaskId }) {
  const tasks = loadTasks();
  const { iso } = localDateTime();
  const task = {
    id: generateTaskId(),
    agent,
    prompt,
    format: format || "text",
    timeline: timeline || "immediate",
    source: source || "api",
    status: timeline === "immediate" ? "pending" : "scheduled",
    scheduledDate: scheduledDate || null,
    created: iso,
    started: null,
    completed: null,
    result: null,
    error: null,
    attempts: 0,
    maxRetries: 2,
    cost: 0,
    parentTaskId: parentTaskId || null,
    files: [],
  };
  tasks.push(task);
  saveTasks(tasks);
  writeAgentTasksFile(agent);
  logSynapse(`[${agent}] Task created: ${task.id} — ${prompt.substring(0, 100)}`);
  return task;
}

function updateTask(taskId, updates) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  Object.assign(tasks[idx], updates);
  saveTasks(tasks);
  writeAgentTasksFile(tasks[idx].agent);
  return tasks[idx];
}

function writeAgentTasksFile(agentName) {
  const agent = AGENTS[agentName];
  if (!agent) return;
  const tasks = loadTasks();
  const { date } = localDateTime();
  const agentTasks = tasks.filter(t => t.agent === agentName);
  const pending = agentTasks.filter(t => ["pending", "scheduled", "in_progress", "failed"].includes(t.status));
  const incomplete = agentTasks.filter(t => t.status === "incomplete");
  const deferred = agentTasks.filter(t => t.status === "deferred");
  const completedToday = agentTasks.filter(t => t.status === "completed" && t.completed?.startsWith(date));

  let md = `# Tasks — ${agentName} (${date})\n\n`;

  if (incomplete.length) {
    md += `## Carry-Forward (Incomplete)\n\n`;
    for (const t of incomplete) {
      md += `### ${t.id} | incomplete | ${t.source}\n`;
      md += `- Created: ${t.created}\n`;
      md += `- Prompt: ${(t.prompt || "").substring(0, 300)}\n`;
      if (t.result) md += `- Last result: ${t.result.substring(0, 200)}\n`;
      md += `\n`;
    }
  }
  if (deferred.length) {
    md += `## Deferred\n\n`;
    for (const t of deferred) {
      md += `### ${t.id} | deferred | ${t.source}\n`;
      md += `- Created: ${t.created}\n`;
      md += `- Prompt: ${(t.prompt || "").substring(0, 300)}\n`;
      md += `\n`;
    }
  }
  if (pending.length) {
    md += `## Active\n\n`;
    for (const t of pending) {
      md += `### ${t.id} | ${t.status} | ${t.source}\n`;
      md += `- Created: ${t.created}\n`;
      md += `- Prompt: ${(t.prompt || "").substring(0, 300)}\n`;
      md += `- Format: ${t.format}\n`;
      md += `- Timeline: ${t.timeline}${t.scheduledDate ? ` (${t.scheduledDate})` : ""}\n`;
      md += `- Attempts: ${t.attempts}/${t.maxRetries + 1}\n`;
      if (t.error) md += `- Last error: ${t.error.substring(0, 200)}\n`;
      md += `\n`;
    }
  }
  if (completedToday.length) {
    md += `## Completed Today\n\n`;
    for (const t of completedToday) {
      md += `### ${t.id} | completed | ${t.source}\n`;
      md += `- Prompt: ${t.prompt.substring(0, 150)}\n`;
      md += `- Result: ${(t.result || "").substring(0, 200)}\n`;
      md += `- Cost: $${(t.cost || 0).toFixed(4)}\n\n`;
    }
  }
  if (!pending.length && !completedToday.length) md += `No active tasks.\n`;

  const tasksFile = join(agent.workspace, "TASKS.md");
  writeFileSync(tasksFile, md);
}

// Roll incomplete tasks from previous days
function rolloverTasks() {
  const tasks = loadTasks();
  const { date } = localDateTime();
  let rolled = 0;
  for (const t of tasks) {
    if (["pending", "scheduled", "failed"].includes(t.status) && t.created && !t.created.startsWith(date)) {
      // Check if scheduled for future — don't roll those
      if (t.status === "scheduled" && t.scheduledDate && t.scheduledDate > date) continue;
      // Roll it forward
      t.status = t.status === "failed" && t.attempts < t.maxRetries ? "pending" : t.status;
      rolled++;
    }
  }
  if (rolled > 0) {
    saveTasks(tasks);
    logSynapse(`Rolled over ${rolled} incomplete tasks to today`);
  }
}

// Check for scheduled tasks that are due
function checkScheduledTasks() {
  const tasks = loadTasks();
  const now = new Date();
  const nowISO = now.toISOString();
  for (const t of tasks) {
    if (t.status === "scheduled" && t.scheduledDate && t.scheduledDate <= nowISO.substring(0, 16)) {
      t.status = "pending";
      logSynapse(`[${t.agent}] Scheduled task ${t.id} is now pending`);
    }
  }
  saveTasks(tasks);

  // Process any pending tasks
  const pendingTasks = tasks.filter(t => t.status === "pending");
  for (const t of pendingTasks) {
    if (activeJobs < MAX_CONCURRENT) {
      executeTask(t);
    }
  }
}

async function executeTask(task) {
  const { iso } = localDateTime();
  updateTask(task.id, { status: "in_progress", started: iso, attempts: task.attempts + 1 });

  // Build prompt with task context
  let prompt = task.prompt;
  if (task.format && task.format !== "text") {
    const formatInstructions = CFG.formatInstructions || {};
    if (formatInstructions[task.format]) {
      prompt += `\n\nOutput format: ${formatInstructions[task.format]}`;
    }
  }
  prompt += `\n\nAfter completing, clearly state what you did, what you found, and the path to any output files.`;
  prompt += `\nStart your response with a short title on the first line (max 60 chars, no markdown), then a blank line, then your full response.`;

  const job = {
    agent: task.agent,
    prompt,
    options: { model: null },
    resolve: (result) => {
      const { iso: completedAt } = localDateTime();
      // Check for output files
      let files = [];
      try {
        const reportsDir = join(AGENTS[task.agent].workspace, "reports");
        if (existsSync(reportsDir)) {
          const recent = readdirSync(reportsDir)
            .map(f => ({ name: f, path: join(reportsDir, f), mtime: require("fs").statSync(join(reportsDir, f)).mtime }))
            .filter(f => f.mtime > new Date(task.started))
            .map(f => f.name);
          files = recent;
        }
      } catch {}

      updateTask(task.id, {
        status: "completed",
        completed: completedAt,
        result: result.text?.substring(0, 10000) || "",
        cost: result.raw?.total_cost_usd || 0,
        files,
      });
      logSynapse(`[${task.agent}] Task ${task.id} completed`);

      // If this task resolved a parent (escalation/checkpoint), mark parent complete too
      if (task.parentTaskId) {
        updateTask(task.parentTaskId, {
          status: "completed",
          completed: completedAt,
          result: `Resolved by ${task.agent} via ${task.id}`,
        });
        logSynapse(`[${task.agent}] Parent task ${task.parentTaskId} marked complete (resolved by ${task.id})`);
      }
    },
    reject: (err) => {
      const { iso: failedAt } = localDateTime();
      const willRetry = task.attempts < task.maxRetries;
      updateTask(task.id, {
        status: "failed",
        error: err.message?.substring(0, 500) || "Unknown error",
        completed: willRetry ? null : failedAt,
      });
      logSynapse(`[${task.agent}] Task ${task.id} failed (attempt ${task.attempts + 1}/${task.maxRetries + 1}): ${err.message?.substring(0, 200)}`);

      if (willRetry) {
        // Smart retry — check for checkpoint before blindly re-running
        smartRetryTask(task, err.message).then(action => {
          if (action === "recovered" || action === "checkpoint") {
            logSynapse(`[${task.agent}] Task ${task.id} handled via ${action} — no full re-run needed`);
          } else {
            // Genuine retry needed — schedule with delay
            logSynapse(`[${task.agent}] Task ${task.id} scheduling retry in 60s`);
            setTimeout(() => executeTask({ ...task, attempts: task.attempts }), 60000);
          }
        });
      } else {
        // Exhausted retries — wake orchestrator immediately (don't wait for heartbeat)
        logSynapse(`[${task.agent}] Task ${task.id} exhausted retries — waking orchestrator NOW`);
        logToMemory(CFG.orchestratorAgent, `ESCALATION: Task ${task.id} for ${task.agent} failed ${task.maxRetries + 1} times. Error: ${err.message?.substring(0, 300)}. Prompt was: ${task.prompt.substring(0, 200)}`);

        // Auto-wake orchestrator with diagnosis context
        const wakePrompt = `TASK FAILURE — immediate attention needed.

Task ${task.id} for ${task.agent} failed ${task.maxRetries + 1} times.
Error: ${err.message?.substring(0, 500)}
Original prompt: ${task.prompt?.substring(0, 500)}

1. Check ${task.agent}'s memory for today — did any partial work complete?
2. If results exist in memory or reports/, recover them and mark the task as checkpoint-recovered
3. If the error is a prompt issue (wrong column, bad query), create a corrected task
4. If it's infrastructure (service down, SSH fail), write to ~/shared/FLEET-OPS.md
5. Do NOT re-run expensive queries if the data is already in memory`;

        // Mark original as being handled, link to escalation
        updateTask(task.id, { status: "failed", error: `Escalated → orchestrator (auto-wake)`, escalatedTo: null });

        const originalTaskId = task.id;
        const wakeTask = createTask({ agent: CFG.orchestratorAgent, prompt: wakePrompt, timeline: "immediate", source: "auto-escalation", parentTaskId: originalTaskId });
        updateTask(task.id, { escalatedTo: wakeTask.id });
        executeTask(wakeTask);
      }
    }
  };

  if (activeJobs < MAX_CONCURRENT) {
    processJob(job);
  } else {
    enqueueJob(job);
  }
}

// ── Token Usage Tracking ─────────────────────────────────────────────────────
const USAGE_FILE = join(HOME, "logs", "usage.json");

function loadUsage() {
  try { return JSON.parse(readFileSync(USAGE_FILE, "utf-8")); }
  catch { return { entries: [], daily: {}, monthly: {} }; }
}

function saveUsage(data) {
  mkdirSync(join(HOME, "logs"), { recursive: true });
  writeFileSync(USAGE_FILE, JSON.stringify(data));
}

function trackUsage(agent, cost, input, output, cacheRead, cacheCreate, model) {
  const data = loadUsage();
  const now = new Date();
  const ts = now.toISOString();
  const day = now.toLocaleDateString("en-CA");
  const month = day.substring(0, 7);
  const hour = now.toLocaleTimeString("en-GB", { hour12: false }).substring(0, 2);

  data.entries.push({ ts, agent, cost, input, output, cacheRead, cacheCreate, model, day, hour });
  if (data.entries.length > 1000) data.entries = data.entries.slice(-1000);

  if (!data.daily[day]) data.daily[day] = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0, byAgent: {}, byHour: {} };
  const d = data.daily[day];
  d.cost += cost; d.input += input; d.output += output; d.cacheRead += cacheRead; d.cacheCreate += cacheCreate; d.calls++;
  if (!d.byAgent[agent]) d.byAgent[agent] = { cost: 0, calls: 0, input: 0, output: 0 };
  d.byAgent[agent].cost += cost; d.byAgent[agent].calls++; d.byAgent[agent].input += input; d.byAgent[agent].output += output;
  if (!d.byHour[hour]) d.byHour[hour] = { cost: 0, calls: 0 };
  d.byHour[hour].cost += cost; d.byHour[hour].calls++;

  if (!data.monthly[month]) data.monthly[month] = { cost: 0, input: 0, output: 0, calls: 0, byAgent: {} };
  const m = data.monthly[month];
  m.cost += cost; m.input += input; m.output += output; m.calls++;
  if (!m.byAgent[agent]) m.byAgent[agent] = { cost: 0, calls: 0 };
  m.byAgent[agent].cost += cost; m.byAgent[agent].calls++;

  const cutoff = new Date(now - 90 * 86400000).toLocaleDateString("en-CA");
  for (const k of Object.keys(data.daily)) { if (k < cutoff) delete data.daily[k]; }
  saveUsage(data);
  return { cost, input, output };
}

// ── SDK Agent Runner ─────────────────────────────────────────────────────────
async function runAgent(agentName, prompt, options = {}) {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  // Load CLAUDE.md + TASKS.md as context
  const claudeMdPath = join(agent.workspace, "CLAUDE.md");
  const tasksMdPath = join(agent.workspace, "TASKS.md");
  let context = "";
  if (existsSync(claudeMdPath)) context += readFileSync(claudeMdPath, "utf8") + "\n\n";
  if (existsSync(tasksMdPath)) context += "# Current Task Queue\n" + readFileSync(tasksMdPath, "utf8") + "\n\n";

  // Inject current time so agents are time-aware
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
  const timeContext = `Current time: ${timeStr} (Central Time)\n\n`;

  const fullPrompt = context
    ? `<context>\n${timeContext}${context}</context>\n\n${prompt}`
    : `<context>\n${timeContext}</context>\n\n${prompt}`;

  const queryOptions = {
    allowedTools: agent.allowedTools || ["Read", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    cwd: agent.workspace,
    model: options.model || agent.model || "sonnet",
    // MCP servers for this agent (if configured in synapse-config.js)
    ...(agent.mcpServers ? { mcpServers: agent.mcpServers } : {}),
    // Session continuation via SDK — resume prior conversation if sessionId provided
    ...(options.sessionId ? { resume: options.sessionId } : {}),
  };

  let resultText = "";
  let totalCost = 0;
  let numTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;
  let subtype = "success";

  for await (const message of query({ prompt: fullPrompt, options: queryOptions })) {
    if (message.type === "result") {
      resultText = message.result || "";
      totalCost = message.total_cost_usd || 0;
      numTurns = message.num_turns || 0;
      sessionId = message.session_id || null;
      subtype = message.subtype || "success";
      if (message.usage) {
        inputTokens = message.usage.input_tokens || 0;
        outputTokens = message.usage.output_tokens || 0;
      }
    }
  }

  return {
    type: "result", subtype, result: resultText, total_cost_usd: totalCost,
    num_turns: numTurns, session_id: sessionId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [queryOptions.model]: { costUSD: totalCost, inputTokens, outputTokens } }
  };
}

// ── Callback with retry ──────────────────────────────────────────────────────
async function deliverCallback(url, payload, agent, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (attempt > 1) logSynapse(`[${agent}] Callback delivered on attempt ${attempt}`);
      return true;
    } catch (e) {
      logSynapse(`[${agent}] Callback attempt ${attempt}/${maxRetries} failed: ${e.message}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, attempt * 2000)); // backoff: 2s, 4s, 6s
    }
  }
  logSynapse(`[${agent}] Callback failed after ${maxRetries} attempts`);
  return false;
}

// ── Smart retry — checks memory for partial work before re-running ──────────
async function smartRetryTask(task, error) {
  const { date } = localDateTime();
  const memDir = join(AGENTS[task.agent]?.workspace || HOME, "memory");
  const memFile = join(memDir, `${date}.md`);
  let memoryContent = "";
  try { memoryContent = readFileSync(memFile, "utf-8"); } catch {}

  // Check if agent produced results in memory despite the "failure"
  const taskMentioned = memoryContent.includes(task.id) || memoryContent.includes(task.prompt?.substring(0, 50));
  const hasResults = memoryContent.includes("Task complete") || memoryContent.includes("Query returned") || memoryContent.includes("report");

  // Check if output files were created
  let hasFiles = false;
  try {
    const reportsDir = join(AGENTS[task.agent]?.workspace || HOME, "reports");
    if (existsSync(reportsDir) && task.started) {
      const recent = readdirSync(reportsDir)
        .filter(f => require("fs").statSync(join(reportsDir, f)).mtime > new Date(task.started));
      hasFiles = recent.length > 0;
    }
  } catch {}

  if (taskMentioned && (hasResults || hasFiles)) {
    // Work was done — don't re-run the whole thing
    logSynapse(`[${task.agent}] Task ${task.id} has partial/complete results in memory — skipping full re-run`);

    // If there are files, mark as completed with those files
    if (hasFiles) {
      const reportsDir = join(AGENTS[task.agent]?.workspace || HOME, "reports");
      const files = readdirSync(reportsDir)
        .filter(f => require("fs").statSync(join(reportsDir, f)).mtime > new Date(task.started));
      updateTask(task.id, { status: "completed", result: "Auto-recovered from checkpoint — files already generated", files, completed: localDateTime().iso });
      logSynapse(`[${task.agent}] Task ${task.id} auto-recovered from checkpoint (${files.length} files found)`);
      return "recovered";
    }

    // Has results in memory but no files — create a lightweight follow-up
    const followUpPrompt = `Your previous run for task ${task.id} produced results (check your memory for today). The task failed with: ${error}. If the work is already done, summarize what you found. If something is incomplete, finish just that part. Do NOT re-run queries or re-do work that's already in your memory.`;
    const followUp = createTask({ agent: task.agent, prompt: followUpPrompt, format: task.format, timeline: "immediate", source: "checkpoint-recovery" });
    updateTask(task.id, { status: "completed", result: `Checkpoint recovery → ${followUp.id}` });
    executeTask(followUp);
    logSynapse(`[${task.agent}] Task ${task.id} checkpoint recovery → ${followUp.id}`);
    return "checkpoint";
  }

  // No partial results — genuine failure, standard retry
  return "retry";
}

// ── Job Queue ────────────────────────────────────────────────────────────────
function enqueueJob(job) {
  if (jobQueue.length >= MAX_JOB_QUEUE) {
    logSynapse(`Queue full, dropping job for ${job.agent}`);
    return "dropped";
  }
  jobQueue.push(job);
  logSynapse(`Queued job for ${job.agent} (${jobQueue.length} pending)`);
  return "queued";
}

function drainQueue() {
  while (jobQueue.length > 0 && activeJobs < MAX_CONCURRENT) {
    const job = jobQueue.shift();
    processJob(job);
  }
}

async function processJob(job) {
  activeJobs++;
  const { agent, prompt, options, resolve: jobResolve, reject: jobReject } = job;
  const jobStart = Date.now();
  logSynapse(`[${agent}] Starting job (${activeJobs} active)`);
  logToMemory(agent, `Task started: ${prompt.substring(0, 500)}`);

  try {
    const result = await runAgent(agent, prompt, options);
    let responseText = result.result || "";

    if (!responseText && result.subtype !== "success") {
      responseText = `[Agent finished with status: ${result.subtype}. Cost: $${(result.total_cost_usd||0).toFixed(4)}.]`;
    }

    const usg = trackUsage(
      agent, result.total_cost_usd || 0,
      result.usage?.input_tokens || 0, result.usage?.output_tokens || 0,
      result.usage?.cache_read_input_tokens || 0, result.usage?.cache_creation_input_tokens || 0,
      Object.keys(result.modelUsage || {})[0] || "unknown"
    );
    logInteraction(agent, prompt, responseText, {
      input: result.usage?.input_tokens || 0, output: result.usage?.output_tokens || 0,
      cost: result.total_cost_usd || 0, model: Object.keys(result.modelUsage || {})[0] || "unknown",
      duration_ms: Date.now() - jobStart, num_turns: result.num_turns || 0,
      session_id: result.session_id || null, source: options?.source || "synapse",
      status: result.subtype || "success",
    });
    logSynapse(`[${agent}] Job complete (${responseText.length} chars, $${usg.cost.toFixed(4)}, ${usg.input}in+${usg.output}out)`);
    logToMemory(agent, `Task complete: ${prompt.substring(0, 300)}`);
    if (jobResolve) jobResolve({ text: responseText, session_id: result.session_id || null, raw: result });
  } catch (err) {
    logInteraction(agent, prompt, err.message || "unknown error", {
      duration_ms: Date.now() - jobStart, source: options?.source || "synapse", status: "error",
    });
    logSynapse(`[${agent}] Job failed: ${err.message}`);
    logToMemory(agent, `Task failed: ${err.message.substring(0, 500)}`);
    if (jobReject) jobReject(err);
  } finally {
    activeJobs--;
    drainQueue();
  }
}

// ── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // Health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({ status: "ok", runtime: "sdk-v3", agents: Object.keys(AGENTS), activeJobs, queueDepth: jobQueue.length, uptime: process.uptime() }));
    return;
  }

  // ── Interactions API ───────────────────────────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/api/interactions")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const date = url.searchParams.get("date") || new Date().toLocaleDateString("en-CA");
    const agent = url.searchParams.get("agent");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 1000);
    const logFile = join(HOME, "logs", "interactions", `${date}.jsonl`);
    let entries = [];
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
      entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (agent && agent !== "all") entries = entries.filter(e => e.agent === agent);
      entries = entries.slice(-limit);
    }
    const interDir = join(HOME, "logs", "interactions");
    let dates = [];
    if (existsSync(interDir)) {
      dates = readdirSync(interDir).filter(f => f.endsWith(".jsonl")).map(f => f.replace(".jsonl", "")).sort().reverse();
    }
    res.writeHead(200, cors);
    res.end(JSON.stringify({ date, entries, total: entries.length, available_dates: dates }));
    return;
  }

  // ── Task CRUD API ──────────────────────────────────────────────────────────

  // List all tasks
  if (req.method === "GET" && req.url.startsWith("/api/tasks")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const agent = url.searchParams.get("agent");
    const status = url.searchParams.get("status");
    let tasks = loadTasks();
    if (agent && agent !== "all") tasks = tasks.filter(t => t.agent === agent);
    if (status && status !== "all") tasks = tasks.filter(t => t.status === status);
    // Most recent first
    tasks.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    res.writeHead(200, cors);
    res.end(JSON.stringify({ tasks, total: tasks.length }));
    return;
  }

  // Create task
  if (req.method === "POST" && req.url === "/api/tasks") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const { agent, prompt, format, timeline, scheduledDate } = payload;
    if (!agent || !prompt) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "agent and prompt required" })); return; }
    if (!AGENTS[agent]) { res.writeHead(404, cors); res.end(JSON.stringify({ error: `Unknown agent: ${agent}` })); return; }

    const task = createTask({ agent, prompt, format, timeline, source: "hivelog", scheduledDate });

    // If immediate, execute now
    if (task.status === "pending") {
      executeTask(task);
    }

    res.writeHead(201, cors);
    res.end(JSON.stringify(task));
    return;
  }

  // Update task (edit prompt, reschedule, reassign)
  if (req.method === "PUT" && req.url.match(/^\/api\/tasks\/TASK-/)) {
    const taskId = req.url.split("/api/tasks/")[1];
    let body = "";
    for await (const chunk of req) body += chunk;
    let updates;
    try { updates = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const tasks = loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) { res.writeHead(404, cors); res.end(JSON.stringify({ error: "Task not found" })); return; }

    // Conversations can be edited while active (add agents, update title)
    if (task.mode !== "conversation" && !["pending", "scheduled", "failed"].includes(task.status)) {
      res.writeHead(400, cors); res.end(JSON.stringify({ error: `Cannot edit task in ${task.status} state` })); return;
    }

    // Whitelist editable fields — conversations also allow agents/title updates
    const allowed = ["prompt", "agent", "format", "timeline", "scheduledDate", "status", "agents", "title"];
    const safeUpdates = {};
    for (const k of allowed) { if (updates[k] !== undefined) safeUpdates[k] = updates[k]; }

    const updated = updateTask(taskId, safeUpdates);
    res.writeHead(200, cors);
    res.end(JSON.stringify(updated));
    return;
  }

  // Retry a failed task
  if (req.method === "POST" && req.url.match(/^\/api\/tasks\/TASK-.*\/retry/)) {
    const taskId = req.url.split("/api/tasks/")[1].replace("/retry", "");
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) { res.writeHead(404, cors); res.end(JSON.stringify({ error: "Task not found" })); return; }
    if (task.status !== "failed") { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Only failed tasks can be retried" })); return; }

    updateTask(taskId, { status: "pending", error: null, attempts: 0 });
    executeTask({ ...task, status: "pending", error: null, attempts: 0 });

    res.writeHead(200, cors);
    res.end(JSON.stringify({ status: "retrying", taskId }));
    return;
  }

  // ── Spawn (legacy, still works — creates a task and executes immediately) ──
  if (req.method === "POST" && req.url.startsWith("/spawn/")) {
    const agentName = req.url.split("/spawn/")[1];
    if (!AGENTS[agentName]) { res.writeHead(404, cors); res.end(JSON.stringify({ error: `Unknown agent: ${agentName}` })); return; }

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const { task: taskPrompt, model, timeout, format, callbackUrl, callbackTaskId, sessionId: resumeSessionId, source: spawnSource } = payload;
    if (!taskPrompt || taskPrompt.trim().length < 3) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "task is required" })); return; }

    logSynapse(`[${agentName}] Spawn request${callbackUrl ? " (async callback)" : ""}${resumeSessionId ? " (resume: "+resumeSessionId.substring(0,8)+"...)" : ""}: ${taskPrompt.substring(0, 300)}`);

    // Dedup throttle — block duplicate alert spawns
    if (shouldThrottleSpawn(agentName, taskPrompt, spawnSource || "spawn")) {
      res.writeHead(429, cors);
      res.end(JSON.stringify({ agent: agentName, status: "throttled", message: "Duplicate alert suppressed (same issue within 2hr window)" }));
      return;
    }

    // Create task record for tracking
    const task = createTask({ agent: agentName, prompt: taskPrompt, format: format || "text", timeline: "immediate", source: spawnSource || "spawn" });

    const job = {
      agent: agentName,
      prompt: taskPrompt,
      options: { model, sessionId: resumeSessionId },
      resolve: (r) => {
        const { iso } = localDateTime();
        updateTask(task.id, { status: "completed", completed: iso, result: r.text?.substring(0, 10000), cost: r.raw?.total_cost_usd || 0, sessionId: r.session_id });
        // Fire callback with retry
        if (callbackUrl) {
          deliverCallback(callbackUrl, { taskId: callbackTaskId || task.id, synapseTaskId: task.id, agent: agentName, status: "complete", result: r }, agentName);
        }
      },
      reject: (e) => {
        updateTask(task.id, { status: "failed", error: e.message?.substring(0, 500), attempts: task.attempts + 1 });
        if (callbackUrl) {
          deliverCallback(callbackUrl, { taskId: callbackTaskId || task.id, synapseTaskId: task.id, agent: agentName, status: "error", error: e.message }, agentName);
        }
      }
    };

    if (callbackUrl) {
      // Async mode — respond immediately, callback when done
      if (activeJobs < MAX_CONCURRENT) processJob(job);
      else { const q = enqueueJob(job); if (q === "dropped") { res.writeHead(503, cors); res.end(JSON.stringify({ error: "Queue full" })); return; } }
      res.writeHead(202, cors);
      res.end(JSON.stringify({ agent: agentName, status: "accepted", taskId: task.id }));
    } else {
      // Sync mode — wait for result (backward compatible)
      try {
        const result = await new Promise((resolve, reject) => {
          job.resolve = (r) => { const { iso } = localDateTime(); updateTask(task.id, { status: "completed", completed: iso, result: r.text?.substring(0, 10000), cost: r.raw?.total_cost_usd || 0 }); resolve(r); };
          job.reject = (e) => { updateTask(task.id, { status: "failed", error: e.message?.substring(0, 500), attempts: task.attempts + 1 }); reject(e); };
          if (activeJobs < MAX_CONCURRENT) processJob(job);
          else { const q = enqueueJob(job); if (q === "dropped") reject(new Error("Queue full")); }
        });
        res.writeHead(200, cors);
        res.end(JSON.stringify({ agent: agentName, status: "complete", taskId: task.id, result }));
      } catch (err) {
        res.writeHead(500, cors);
        res.end(JSON.stringify({ agent: agentName, status: "error", taskId: task.id, error: err.message }));
      }
    }
    return;
  }

  // ── Conversation message ───────────────────────────────────────────────────
  if (req.method === "POST" && req.url.match(/^\/api\/tasks\/[^/]+\/message$/)) {
    const taskId = req.url.split("/api/tasks/")[1].replace("/message", "");

    // Parse body first so we have targetAgent for auto-create
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const { message, agent: targetAgent, rounds: requestedRounds } = payload;

    const tasks = loadTasks();
    let task = tasks.find(t => t.id === taskId);

    // Auto-create conversation task if it doesn't exist (created by hivelog)
    if (!task) {
      const defaultAgent = targetAgent || CFG.orchestratorAgent;
      task = { id: taskId, mode: "conversation", agent: defaultAgent, agents: [defaultAgent], messages: [], status: "active", created: localDateTime().iso, prompt: "" };
      tasks.push(task);
      saveTasks(tasks);
    }
    if (task.mode !== "conversation") {
      task.mode = "conversation";
      if (!task.agents) task.agents = [task.agent];
      if (!task.messages) task.messages = [];
    }
    if (!message || message.trim().length < 3) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "message required (min 3 chars)" })); return; }

    // Parse rounds from message [rounds:N] or payload
    const roundsMatch = message.match(/\[rounds?:?\s*(\d+)\]/i);
    const MAX_ROUNDS = 5;
    const COST_CAP = 3.00;
    const rounds = Math.min(parseInt(roundsMatch?.[1] || requestedRounds || "1") || 1, MAX_ROUNDS);

    // Parse ALL @mentions with optional [format] tags: @agent [xlsx] do the thing
    const agentIds = Object.keys(AGENTS).join("|");
    const mentionRegex = new RegExp(`@(${agentIds})(?:\\s*\\[(text|xlsx|csv|pdf|md|json|py|html|png|pptx|docx)\\])?`, "gi");
    const allMentions = [...message.matchAll(mentionRegex)].map(m => ({ agent: m[1].toLowerCase(), format: m[2]?.toLowerCase() || null }));
    // Dedupe by agent while preserving order, keep first format seen
    const seen = new Set();
    const pipelineWithFormats = [];
    for (const m of (targetAgent ? [{ agent: targetAgent, format: null }] : allMentions)) {
      if (!seen.has(m.agent)) { seen.add(m.agent); pipelineWithFormats.push(m); }
    }
    if (pipelineWithFormats.length === 0) {
      // Default to last agent who responded in the thread
      const lastAgentMsg = [...(task.messages || [])].reverse().find(m => m.role === "agent" && m.agent);
      const fallbackAgent = lastAgentMsg?.agent || task.agent;
      pipelineWithFormats.push({ agent: fallbackAgent, format: null });
    }
    const pipeline = pipelineWithFormats.map(p => p.agent);
    const pipelineFormats = Object.fromEntries(pipelineWithFormats.filter(p => p.format).map(p => [p.agent, p.format]));

    // Validate all agents
    for (const a of pipeline) {
      if (!AGENTS[a]) { res.writeHead(400, cors); res.end(JSON.stringify({ error: `Unknown agent: ${a}` })); return; }
    }

    // Auto-add agents to conversation
    if (!task.agents) task.agents = [task.agent];
    for (const a of pipeline) {
      if (!task.agents.includes(a)) {
        task.agents.push(a);
        logSynapse(`[${taskId}] Agent ${a} joined conversation`);
      }
    }

    // Add user message to conversation history
    if (!task.messages) task.messages = [];
    const { iso } = localDateTime();
    task.messages.push({ role: "user", content: message, ts: iso });
    updateTask(taskId, { messages: task.messages, status: "in_progress", agent: pipeline[0] });

    logSynapse(`[${taskId}] Pipeline: ${pipeline.join(" → ")} × ${rounds} rounds for: ${message.substring(0, 200)}`);

    // Consensus phrases that signal an agent has nothing to add
    const SKIP_PATTERNS = /\b(agreed|nothing to add|looks good|no changes|i concur|no objections|lgtm|all good|no further)\b/i;

    // Helper to build context prompt for an agent
    function buildPrompt(agentName, msgs, pipelineAgents, round, totalRounds) {
      let parts = [`You are "${agentName}" in a multi-agent conversation. Agents in this thread: ${(task.agents || []).join(", ")}.`];
      if (totalRounds > 1) {
        parts.push(`This is round ${round} of ${totalRounds}.`);
        if (round === totalRounds) {
          parts.push(`This is the FINAL round. Converge on a conclusion or action plan. If you agree with what's been said, say so briefly.`);
        } else if (round > 1) {
          parts.push(`Review what was said in prior rounds. Build on it, correct mistakes, or add new insight. If you fully agree and have nothing to add, just say "agreed".`);
        }
      }
      if (pipelineAgents.length > 1) {
        const myIdx = pipelineAgents.indexOf(agentName);
        if (myIdx === pipelineAgents.length - 1 && round === 1) {
          parts.push(`You are the FINAL agent in this pipeline (${pipelineAgents.join(" → ")}). Review what the other agents said and take action or synthesize.`);
        } else if (round === 1) {
          parts.push(`You are agent ${myIdx + 1} of ${pipelineAgents.length} in this pipeline (${pipelineAgents.join(" → ")}). Answer from your perspective.`);
        }
      }
      parts.push(`\nConversation so far:`);
      for (const msg of msgs) {
        if (msg.role === "user") parts.push(`\nUSER: ${msg.content}`);
        else if (msg.role === "system") parts.push(`\nSYSTEM: ${msg.content}`);
        else parts.push(`\n${(msg.agent || "agent").toUpperCase()}: ${msg.content}`);
      }
      // Per-agent output format instructions
      const fmt = pipelineFormats[agentName];
      const formatInstructions = CFG.formatInstructions || {};
      if (fmt && formatInstructions[fmt]) {
        parts.push(`\nOUTPUT FORMAT: ${formatInstructions[fmt]}`);
        parts.push(`After completing, state the file path clearly so it can be downloaded.`);
      }
      parts.push(`\nYou are ${agentName}. Respond concisely and actionably.`);
      return parts.join("\n");
    }

    // Run pipeline with rounds
    const responses = [];
    let totalCost = 0;
    const skippedAgents = new Set(); // agents that said "agreed" / "nothing to add"
    try {
      for (let round = 1; round <= rounds; round++) {
        if (rounds > 1) {
          const { iso: roundIso } = localDateTime();
          task.messages.push({ role: "system", content: `── Round ${round} of ${rounds} ──`, ts: roundIso });
          updateTask(taskId, { messages: task.messages });
          logSynapse(`[${taskId}] Round ${round}/${rounds}`);
        }

        let activeThisRound = 0;
        for (const agent of pipeline) {
          // Skip agents that reached consensus
          if (skippedAgents.has(agent)) {
            logSynapse(`[${agent}] Skipped in round ${round} (consensus)`);
            continue;
          }

          // Cost cap check
          if (totalCost >= COST_CAP) {
            const { iso: capIso } = localDateTime();
            task.messages.push({ role: "system", content: `Cost cap reached ($${totalCost.toFixed(2)} / $${COST_CAP.toFixed(2)}). Stopping.`, ts: capIso });
            updateTask(taskId, { messages: task.messages });
            logSynapse(`[${taskId}] Cost cap hit at $${totalCost.toFixed(2)}`);
            round = rounds + 1; // break outer loop
            break;
          }

          const fullPrompt = buildPrompt(agent, task.messages, pipeline, round, rounds);
          logSynapse(`[${agent}] Round ${round} step in ${taskId}`);

          const result = await new Promise((resolve, reject) => {
            const job = {
              agent, prompt: fullPrompt, options: { source: "conversation" },
              resolve: (r) => resolve(r),
              reject: (e) => reject(e),
            };
            if (activeJobs < MAX_CONCURRENT) processJob(job);
            else { const q = enqueueJob(job); if (q === "dropped") reject(new Error("Queue full")); }
          });

          const responseText = result.text?.substring(0, 10000) || "";
          const cost = result.raw?.total_cost_usd || 0;
          totalCost += cost;
          activeThisRound++;

          // Check for consensus skip
          if (round > 1 && SKIP_PATTERNS.test(responseText) && responseText.length < 200) {
            skippedAgents.add(agent);
          }

          const { iso: stepIso } = localDateTime();
          task.messages.push({ role: "agent", agent, content: responseText, ts: stepIso, cost, round });
          updateTask(taskId, { messages: task.messages, status: "in_progress", agent });
          responses.push({ agent, response: responseText, cost, round });

          // Push incremental update to HiveLog
          deliverCallback((CFG.HIVELOG_URL || "http://localhost:3000") + "/api/tasks/" + taskId + "/callback",
            { agent, content: responseText, cost, round, status: "in_progress" }, agent, 2);

        }

        // If all agents skipped (consensus reached), stop early
        if (activeThisRound === 0) {
          const { iso: conIso } = localDateTime();
          task.messages.push({ role: "system", content: `All agents reached consensus. Ending early at round ${round}.`, ts: conIso });
          updateTask(taskId, { messages: task.messages });
          logSynapse(`[${taskId}] Consensus reached at round ${round}`);
          break;
        }
      }

      const { iso: doneIso } = localDateTime();
      updateTask(taskId, { messages: task.messages, status: "active", lastActivity: doneIso });

      res.writeHead(200, cors);
      res.end(JSON.stringify({ taskId, pipeline, rounds, responses, totalCost, messageCount: task.messages.length }));
    } catch (err) {
      task.messages.push({ role: "error", agent: pipeline[0], content: err.message, ts: localDateTime().iso });
      updateTask(taskId, { messages: task.messages, status: "active" });
      res.writeHead(500, cors);
      res.end(JSON.stringify({ taskId, pipeline, rounds, responses, error: err.message }));
    }
    return;
  }

  // ── Hooks (external webhook) ───────────────────────────────────────────────
  if (req.method === "POST" && req.url.startsWith("/hooks/")) {
    if (HOOK_TOKEN && (req.headers.authorization || "") !== `Bearer ${HOOK_TOKEN}`) {
      res.writeHead(401, cors); res.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const sender = req.url.split("/hooks/")[1];
    const { message, agent: targetAgent } = payload;
    const target = targetAgent || CFG.orchestratorAgent;

    res.writeHead(202, cors);
    res.end(JSON.stringify({ status: "accepted", agent: target }));

    const prompt = `Incoming message from "${sender}":\n${message}\n\nRespond concisely. Write important findings to memory.`;
    const task = createTask({ agent: target, prompt, timeline: "immediate", source: `hook:${sender}` });
    executeTask(task);
    return;
  }

  // ── Usage APIs ─────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/usage/summary") {
    const data = loadUsage();
    const today = new Date().toLocaleDateString("en-CA");
    const month = today.substring(0, 7);
    const todayData = data.daily[today] || { cost: 0, calls: 0, byAgent: {}, byHour: {} };
    const monthData = data.monthly[month] || { cost: 0, calls: 0, byAgent: {} };
    const week = { cost: 0, calls: 0 };
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000).toLocaleDateString("en-CA");
      if (data.daily[d]) { week.cost += data.daily[d].cost; week.calls += data.daily[d].calls; }
    }
    const recent = (data.entries || []).slice(-20).reverse();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ today: todayData, week, month: monthData, recent }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/usage") {
    const data = loadUsage();
    res.writeHead(200, cors);
    res.end(JSON.stringify(data));
    return;
  }

  if (req.method === "GET" && req.url === "/api/models") {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } });
      const data = await resp.json();
      res.writeHead(200, cors);
      res.end(JSON.stringify((data.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }))));
    } catch {
      res.writeHead(200, cors);
      res.end(JSON.stringify([{ id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }, { id: "haiku", name: "Haiku" }]));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/agents") {
    res.writeHead(200, cors);
    res.end(JSON.stringify(Object.entries(AGENTS).map(([name, cfg]) => ({ name, workspace: cfg.workspace, description: cfg.description }))));
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, { ...cors, "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

// ── Startup ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  logSynapse(`Synapse v3 (SDK + Tasks) listening on :${PORT}`);
  logSynapse(`Agents: ${Object.keys(AGENTS).join(", ")} | Max concurrent: ${MAX_CONCURRENT}`);

  // Rollover incomplete tasks from yesterday
  rolloverTasks();

  // Write initial TASKS.md for each agent
  for (const name of Object.keys(AGENTS)) writeAgentTasksFile(name);

  // Check scheduled tasks every 60 seconds
  setInterval(checkScheduledTasks, 60000);

  logSynapse(`Task scheduler active (60s interval)`);
});
