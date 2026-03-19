import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// ── Config ───────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || homedir();
const CLAUDE_BIN = existsSync(join(HOME, ".local/bin/claude"))
  ? join(HOME, ".local/bin/claude")
  : join(HOME, ".nvm/versions/node/current/bin/claude"); // adjust to your node version

const PORT = parseInt(process.env.PORT || "18789");
const HOOK_TOKEN = process.env.HOOK_TOKEN;
if (!HOOK_TOKEN) {
  console.error("HOOK_TOKEN environment variable is required");
  process.exit(1);
}
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3");

// Agent definitions — customize for your setup
const AGENTS = {
  "agent-orchestrator": {
    workspace: join(HOME, "agents/agent-orchestrator"),
    description: "Orchestrator — user-facing, task routing, messaging",
    model: null, // uses default
  },
  "agent-data": {
    workspace: join(HOME, "agents/agent-data"),
    description: "Knowledge/DB agent — SQL queries, data analysis",
    model: null,
  },
  "agent-monitor": {
    workspace: join(HOME, "agents/agent-monitor"),
    description: "Remote host monitor — scheduled tasks, alerts",
    model: null,
  }
};

// ── State ────────────────────────────────────────────────────────────────────
let activeJobs = 0;
const jobQueue = [];
const MAX_JOB_QUEUE = 20;

// ── Helpers ──────────────────────────────────────────────────────────────────
function localDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD local TZ
  const time = now.toLocaleTimeString("en-GB", { hour12: false }); // HH:MM:SS
  return { date, time };
}

function logToMemory(agentName, message) {
  const { date, time } = localDateTime();
  const memDir = join(AGENTS[agentName]?.workspace || HOME, "memory");
  mkdirSync(memDir, { recursive: true });
  const file = join(memDir, `${date}.md`);
  if (!existsSync(file)) {
    writeFileSync(file, `# ${date} — ${agentName} Daily Log\n\n`);
  }
  appendFileSync(file, `- [${time}] ${message}\n`);
}

function logSynapse(message) {
  const { date, time } = localDateTime();
  const logDir = join(HOME, "logs");
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, `synapse-${date}.log`);
  appendFileSync(file, `[${time}] ${message}\n`);
  console.log(`[${time}] ${message}`);
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

function trackUsage(agent, result) {
  const data = loadUsage();
  const now = new Date();
  const ts = now.toISOString();
  const day = now.toLocaleDateString("en-CA");
  const month = day.substring(0, 7);
  const hour = now.toLocaleTimeString("en-GB", { hour12: false }).substring(0, 2);

  const cost = result.total_cost_usd || 0;
  const input = result.usage?.input_tokens || 0;
  const output = result.usage?.output_tokens || 0;
  const cacheRead = result.usage?.cache_read_input_tokens || 0;
  const cacheCreate = result.usage?.cache_creation_input_tokens || 0;
  const model = Object.keys(result.modelUsage || {})[0] || "unknown";

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
  return { cost, input, output, cacheRead, cacheCreate, model };
}

// ── Claude Code Runner (CLI) ─────────────────────────────────────────────────
// NOTE: This spawns the Claude Code CLI (`claude -p`). This uses your Claude
// subscription, NOT the API key. Intended for development/testing only.
// For production, use synapse-sdk.js which calls the Claude Agent SDK directly.
function runClaude(agentName, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const agent = AGENTS[agentName];
    if (!agent) {
      reject(new Error(`Unknown agent: ${agentName}`));
      return;
    }

    const args = [
      "-p", prompt,
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--max-budget-usd", options.budget || "1.00"
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    // Continue session for heartbeats (cheaper, maintains context)
    if (options.continueSession) {
      args.push("--continue", "--fork-session");
    }

    const env = {
      ...process.env,
      HOME,
      CI: "1",
    };
    if (ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: agent.workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    const timeout = options.timeout || 300000; // 5 min default
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Agent ${agentName} timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errMsg = stderr.substring(0, 500) || `exit code ${code}`;
        logSynapse(`[${agentName}] ERROR (code ${code}): ${errMsg}`);
        logToMemory(agentName, `Synapse error (code ${code}): ${errMsg.substring(0, 200)}`);
        reject(new Error(errMsg));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        resolve({ result: stdout });
      }
    });
  });
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
  logSynapse(`[${agent}] Starting job (${activeJobs} active)`);
  logToMemory(agent, `Task started: ${prompt.substring(0, 500)}`);

  try {
    const result = await runClaude(agent, prompt, options);
    let responseText = result.result || "";
    if (!responseText && result.type === "result") {
      if (result.subtype === "error_max_turns") {
        responseText = `[Agent ran out of turns (${result.num_turns}). Cost: $${(result.total_cost_usd||0).toFixed(4)}. The task may be partially complete — check agent memory for progress.]`;
      } else {
        responseText = JSON.stringify(result);
      }
    }
    if (result && typeof result.total_cost_usd === "number") {
      const usg = trackUsage(agent, result);
      logSynapse(`[${agent}] Job complete (${responseText.length} chars, $${usg.cost.toFixed(4)}, ${usg.input}in+${usg.output}out)`);
    } else {
      logSynapse(`[${agent}] Job complete (${responseText.length} chars)`);
    }
    logToMemory(agent, `Task complete: ${prompt.substring(0, 300)}`);
    if (jobResolve) jobResolve({ text: responseText, session_id: result.session_id || null, raw: result });
  } catch (err) {
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
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      runtime: "cli",
      agents: Object.keys(AGENTS),
      activeJobs,
      queueDepth: jobQueue.length,
      uptime: process.uptime()
    }));
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/spawn/")) {
    const agentName = req.url.split("/spawn/")[1];
    if (!AGENTS[agentName]) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Unknown agent: ${agentName}` }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const { task, model, budget, timeout } = payload;
    if (!task) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "task is required" }));
      return;
    }

    logSynapse(`[${agentName}] Spawn request: ${task.substring(0, 300)}`);

    try {
      const result = await new Promise((resolve, reject) => {
        const job = {
          agent: agentName,
          prompt: task,
          options: { model, budget: budget || "1.00", timeout: timeout || 300000 },
          resolve,
          reject
        };

        if (activeJobs < MAX_CONCURRENT) {
          processJob(job);
        } else {
          const qResult = enqueueJob(job);
          if (qResult === "dropped") reject(new Error("Queue full"));
        }
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agent: agentName, status: "complete", result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agent: agentName, status: "error", error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/hooks/")) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${HOOK_TOKEN}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const sender = req.url.split("/hooks/")[1];
    const { message, agent: targetAgent } = payload;
    const target = targetAgent || "agent-orchestrator";

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", agent: target }));

    const prompt = `Incoming message from "${sender}":\n${message}\n\nRespond concisely with results. Write important findings to memory.`;

    const job = {
      agent: target,
      prompt,
      options: { budget: "0.25", timeout: 180000 },
      resolve: (result) => logSynapse(`[${target}] Hook from ${sender} complete`),
      reject: (err) => logSynapse(`[${target}] Hook from ${sender} failed: ${err.message}`)
    };

    if (activeJobs < MAX_CONCURRENT) processJob(job);
    else enqueueJob(job);
    return;
  }

  // Usage summary
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ today: todayData, week, month: monthData, recent }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/usage") {
    const data = loadUsage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.method === "GET" && req.url === "/api/models") {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }
      });
      const data = await resp.json();
      const models = (data.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(models));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "sonnet", name: "Sonnet (latest)" },
        { id: "opus", name: "Opus (latest)" },
        { id: "haiku", name: "Haiku (latest)" }
      ]));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/agents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(
      Object.entries(AGENTS).map(([name, cfg]) => ({
        name, workspace: cfg.workspace, description: cfg.description
      }))
    ));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  logSynapse(`Synapse v2 (CLI) listening on :${PORT}`);
  logSynapse(`Runtime: Claude Code CLI (subscription-based)`);
  logSynapse(`Agents: ${Object.keys(AGENTS).join(", ")}`);
  logSynapse(`Max concurrent: ${MAX_CONCURRENT}`);
  logSynapse(`Health: http://localhost:${PORT}/health`);
  logSynapse(`Spawn: POST http://localhost:${PORT}/spawn/{agent}`);
  logSynapse(`Hooks: POST http://localhost:${PORT}/hooks/{sender}`);
});
