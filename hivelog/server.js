import express from "express";
import multer from "multer";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config — copy config.example.js → config.js and fill in your values
let CFG;
try { CFG = (await import("./config.js")).default; }
catch { CFG = (await import("./config.example.js")).default; }

const app = express();
const PORT = 3000;
const HIVELOG_HOST = CFG.HIVELOG_HOST;
const FLEET_SSH = CFG.FLEET_SSH;
const AGENT_DIR = "$HOME/agents";
const SYNAPSE_URL = `http://${CFG.FLEET_HOST}:${CFG.SYNAPSE_PORT}`;
const GPU_SSH = CFG.GPU_SSH;
const AGENTS = CFG.agents.map(a => a.id);
const AGENT_MAP = Object.fromEntries(CFG.agents.map(a => [a.id, a]));
const UPLOAD_DIR = join(__dirname, "uploads");
const MAX_HISTORY = 180;

const FLEET_METRICS = CFG.FLEET_METRICS;
const GPU_METRICS_URL = CFG.GPU_METRICS;

mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `${ts}-${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Metrics History ──
const metrics = {
  fleet: { cpu: [], ramUsedGB: [], ramTotalGB: 0, timestamps: [] },
  gpu0: { vramUsedMB: [], vramTotalMB: 0, temp: [], util: [], name: "", timestamps: [] },
  gpu1: { vramUsedMB: [], vramTotalMB: 0, temp: [], util: [], name: "", timestamps: [] },
  gpuHost: { cpu: [], ramUsedGB: [], ramTotalGB: 0, timestamps: [] }
};

// Previous CPU idle for delta calc
let prevCpuIdle = { fleet: null, gpuHost: null };

// ── Parse node_exporter metrics ──
async function fetchNodeMetrics(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const text = await resp.text();
    const get = (name) => {
      const m = text.match(new RegExp(`^${name}\\s+([\\d.e+]+)`, "m"));
      return m ? parseFloat(m[1]) : null;
    };
    // CPU: sum idle seconds across all cores
    const idleMatches = [...text.matchAll(/^node_cpu_seconds_total\{.*mode="idle".*\}\s+([\d.e+]+)/gm)];
    const totalMatches = [...text.matchAll(/^node_cpu_seconds_total\{.*\}\s+([\d.e+]+)/gm)];
    const idleTotal = idleMatches.reduce((s, m) => s + parseFloat(m[1]), 0);
    const allTotal = totalMatches.reduce((s, m) => s + parseFloat(m[1]), 0);

    return {
      memTotalBytes: get("node_memory_MemTotal_bytes"),
      memAvailBytes: get("node_memory_MemAvailable_bytes"),
      cpuIdleTotal: idleTotal,
      cpuAllTotal: allTotal,
      loadAvg1: get("node_load1")
    };
  } catch { return null; }
}

// ── GPU metrics via SSH ──
async function fetchGpuMetrics() {
  try {
    const output = execSync(
      `ssh -o ConnectTimeout=5 ${GPU_SSH} "nvidia-smi --query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu --format=csv,noheader,nounits" 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    return output.split("\n").map(line => {
      const [name, used, total, temp, util] = line.split(", ").map(s => s.trim());
      return { name, usedMB: parseFloat(used), totalMB: parseFloat(total), temp: parseFloat(temp), util: parseFloat(util) };
    });
  } catch { return null; }
}

// ── Collect all metrics ──
async function collectMetrics() {
  const ts = Date.now();

  // Fleet host
  const f = await fetchNodeMetrics(FLEET_METRICS);
  if (f) {
    const ramTotalGB = f.memTotalBytes / 1073741824;
    const ramUsedGB = (f.memTotalBytes - f.memAvailBytes) / 1073741824;
    metrics.fleet.ramTotalGB = ramTotalGB;
    metrics.fleet.ramUsedGB.push(parseFloat(ramUsedGB.toFixed(1)));

    // CPU % from delta
    if (prevCpuIdle.fleet !== null) {
      const idleDelta = f.cpuIdleTotal - prevCpuIdle.fleet.idle;
      const totalDelta = f.cpuAllTotal - prevCpuIdle.fleet.total;
      const cpuPct = totalDelta > 0 ? ((1 - idleDelta / totalDelta) * 100) : 0;
      metrics.fleet.cpu.push(parseFloat(Math.max(0, cpuPct).toFixed(1)));
    } else {
      // First sample - use load average as rough estimate
      const cores = 8;
      metrics.fleet.cpu.push(parseFloat(((f.loadAvg1 / cores) * 100).toFixed(1)));
    }
    prevCpuIdle.fleet = { idle: f.cpuIdleTotal, total: f.cpuAllTotal };

    metrics.fleet.timestamps.push(ts);
    while (metrics.fleet.cpu.length > MAX_HISTORY) {
      metrics.fleet.cpu.shift(); metrics.fleet.ramUsedGB.shift(); metrics.fleet.timestamps.shift();
    }
  }

  // GPU host host metrics
  const b = await fetchNodeMetrics(GPU_METRICS_URL);
  if (b) {
    const ramTotalGB = b.memTotalBytes / 1073741824;
    const ramUsedGB = (b.memTotalBytes - b.memAvailBytes) / 1073741824;
    metrics.gpuHost.ramTotalGB = ramTotalGB;
    metrics.gpuHost.ramUsedGB.push(parseFloat(ramUsedGB.toFixed(1)));

    if (prevCpuIdle.gpuHost !== null) {
      const idleDelta = b.cpuIdleTotal - prevCpuIdle.gpuHost.idle;
      const totalDelta = b.cpuAllTotal - prevCpuIdle.gpuHost.total;
      const cpuPct = totalDelta > 0 ? ((1 - idleDelta / totalDelta) * 100) : 0;
      metrics.gpuHost.cpu.push(parseFloat(Math.max(0, cpuPct).toFixed(1)));
    } else {
      metrics.gpuHost.cpu.push(parseFloat(((b.loadAvg1 / 32) * 100).toFixed(1)));
    }
    prevCpuIdle.gpuHost = { idle: b.cpuIdleTotal, total: b.cpuAllTotal };

    metrics.gpuHost.timestamps.push(ts);
    while (metrics.gpuHost.cpu.length > MAX_HISTORY) {
      metrics.gpuHost.cpu.shift(); metrics.gpuHost.ramUsedGB.shift(); metrics.gpuHost.timestamps.shift();
    }
  }

  // GPUs
  const gpus = await fetchGpuMetrics();
  if (gpus) {
    gpus.forEach((gpu, i) => {
      const key = `gpu${i}`;
      if (!metrics[key]) return;
      metrics[key].name = gpu.name;
      metrics[key].vramTotalMB = gpu.totalMB;
      metrics[key].vramUsedMB.push(gpu.usedMB);
      metrics[key].temp.push(gpu.temp);
      metrics[key].util.push(gpu.util);
      metrics[key].timestamps.push(ts);
      while (metrics[key].vramUsedMB.length > MAX_HISTORY) {
        metrics[key].vramUsedMB.shift(); metrics[key].temp.shift();
        metrics[key].util.shift(); metrics[key].timestamps.shift();
      }
    });
  }
}

collectMetrics();
setInterval(collectMetrics, 60000);

// ── SSH helper ──
function sshCmd(host, cmd, timeout = 10000) {
  try {
    return execSync(`ssh -o ConnectTimeout=5 ${host} '${cmd.replace(/'/g, "'\\''")}'`, { encoding: "utf-8", timeout }).trim();
  } catch { return null; }
}

// ── API: Metrics ──
app.get("/api/metrics", (req, res) => res.json(metrics));

// ── API: Services ──
app.get("/api/services", async (req, res) => {
  const svc = {};
  try {
    const r = await fetch(`${SYNAPSE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    svc.synapse = await r.json();
  } catch { svc.synapse = { status: "down" }; }

  const fleetSvc = sshCmd(FLEET_SSH, "systemctl --user is-active synapse.service 2>/dev/null; echo '|'; crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l");
  if (fleetSvc) { const p = fleetSvc.split("|").map(s=>s.trim()); svc.fleetSynapse = p[0]; svc.fleetCrons = parseInt(p[1])||0; }

  const bcSvc = sshCmd(GPU_SSH, "systemctl --user is-active qwen-tts.service image-gen.service whisper-stt.service embedding-api.service tts-openai-wrapper.service 2>/dev/null");
  if (bcSvc) {
    const states = bcSvc.split("\n");
    ["tts","imageGen","whisper","embedding","ttsWrapper"].forEach((n,i) => { svc[`bc_${n}`] = states[i]||"unknown"; });
  }

  // Health endpoint checks
  const gpuUrls = CFG.gpuHealthUrls || {};
  for (const [key, url] of [["bc_tts_h",gpuUrls.tts_voices],["bc_img_h",gpuUrls.img_health],
    ["bc_whisper_h",gpuUrls.whisper_health],["bc_embed_h",gpuUrls.embed_health]].filter(e => e[1])) {
    try { svc[key] = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json(); }
    catch { svc[key] = { status: "unreachable" }; }
  }
  res.json(svc);
});

// ── API: Logs ──
app.get("/api/logs/:agent/{:date}", (req, res) => {
  const { agent } = req.params;
  if (!AGENTS.includes(agent)) return res.status(404).json({ error: "Unknown agent" });
  const date = req.params.date || new Date().toLocaleDateString("en-CA");
  const content = sshCmd(FLEET_SSH, `cat ${AGENT_DIR}/${agent}/memory/${date}.md 2>/dev/null || echo 'No log for ${date}'`, 15000) || "Error";
  res.json({ agent, date, content });
});

app.get("/api/logs", (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString("en-CA");
  const logs = {};
  for (const agent of AGENTS) {
    logs[agent] = sshCmd(FLEET_SSH, `cat ${AGENT_DIR}/${agent}/memory/${date}.md 2>/dev/null || echo 'No log for ${date}'`, 15000) || "Error";
  }
  res.json({ date, logs });
});

app.get("/api/dates/:agent", (req, res) => {
  const { agent } = req.params;
  if (!AGENTS.includes(agent)) return res.status(404).json({ error: "Unknown agent" });
  const output = sshCmd(FLEET_SSH, `ls ${AGENT_DIR}/${agent}/memory/*.md 2>/dev/null | xargs -n1 basename | sed 's/.md//' | sort -r | head -30`);
  res.json({ agent, dates: (output||"").split("\n").filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) });
});

app.get("/api/interactions", async (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString("en-CA");
  const agent = req.query.agent || "";
  try {
    const url = `${SYNAPSE_URL}/api/interactions?date=${date}${agent ? `&agent=${agent}` : ""}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    res.json(await resp.json());
  } catch (e) {
    res.status(502).json({ error: e.message, entries: [], available_dates: [] });
  }
});

// Public config for frontend — agent names, colors (no secrets)
app.get("/api/config", (req, res) => {
  res.json({ agents: CFG.agents });
});

app.get("/api/health", async (req, res) => {
  try { res.json(await (await fetch(`${SYNAPSE_URL}/health`, { signal: AbortSignal.timeout(5000) })).json()); }
  catch (e) { res.json({ status: "unreachable", error: e.message }); }
});

app.post("/api/spawn/:agent", async (req, res) => {
  const { agent } = req.params;
  if (!AGENTS.includes(agent)) return res.status(404).json({ error: "Unknown agent" });
  const { task, timeout } = req.body;
  if (!task) return res.status(400).json({ error: "task required" });
  try {
    const r = await fetch(`${SYNAPSE_URL}/spawn/${agent}`, { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ task, timeout: timeout||180000 }) });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({ filename: req.file.filename, size: req.file.size, url: `/uploads/${req.file.filename}` });
});

app.get("/api/uploads", (req, res) => {
  try {
    const files = readdirSync(UPLOAD_DIR).map(f => {
      const stat = statSync(join(UPLOAD_DIR, f));
      return { name: f, size: stat.size, modified: stat.mtime, url: `/uploads/${f}` };
    }).sort((a,b) => b.modified - a.modified);
    res.json(files);
  } catch { res.json([]); }
});

app.get("/api/files/:agent", (req, res) => {
  const { agent } = req.params;
  const subpath = req.query.path || "";
  if (!AGENTS.includes(agent)) return res.status(404).json({ error: "Unknown agent" });
  res.json({ agent, path: subpath, listing: sshCmd(FLEET_SSH, `ls -la ${AGENT_DIR}/${agent}/${subpath} 2>/dev/null`) });
});

app.get("/api/download/:agent/{*filepath}", (req, res) => {
  const { agent, filepath } = req.params;
  if (!AGENTS.includes(agent) || filepath.includes("..")) return res.status(400).json({ error: "Bad request" });
  try {
    const content = execSync(`ssh -o ConnectTimeout=5 ${FLEET_SSH} "cat '${AGENT_DIR}/${agent}/${filepath}'"`, { timeout: 15000 });
    const ext = extname(filepath).toLowerCase();
    const types = {".md":"text/markdown",".json":"application/json",".log":"text/plain",".txt":"text/plain",
      ".sh":"text/x-shellscript",".js":"application/javascript",".png":"image/png",".jpg":"image/jpeg",
      ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".csv":"text/csv",".pdf":"application/pdf",".html":"text/html",
      ".py":"text/x-python",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation"};
    res.set("Content-Type", types[ext]||"application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${basename(filepath)}"`);
    res.send(content);
  } catch { res.status(404).json({ error: "Not found" }); }
});

app.get("/api/gpu", async (req, res) => {
  const gpus = await fetchGpuMetrics();
  res.json({ host: "gpu-host", gpus: gpus || [] });
});


// ── API: Usage proxy (from synapse) ──
app.get("/api/usage/summary", async (req, res) => {
  try {
    const r = await fetch(`${SYNAPSE_URL}/api/usage/summary`, { signal: AbortSignal.timeout(5000) });
    res.json(await r.json());
  } catch (e) { res.json({ today: { cost: 0, calls: 0 }, week: { cost: 0, calls: 0 }, month: { cost: 0, calls: 0 }, recent: [] }); }
});

app.get("/api/usage/full", async (req, res) => {
  try {
    const r = await fetch(`${SYNAPSE_URL}/api/usage`, { signal: AbortSignal.timeout(5000) });
    res.json(await r.json());
  } catch (e) { res.json({ entries: [], daily: {}, monthly: {} }); }
});


// ── API: Models proxy (from synapse → Anthropic API) ──
app.get("/api/models", async (req, res) => {
  try {
    const r = await fetch(`${SYNAPSE_URL}/api/models`, { signal: AbortSignal.timeout(10000) });
    res.json(await r.json());
  } catch (e) {
    res.json([
      { id: "sonnet", name: "Sonnet (latest)" },
      { id: "opus", name: "Opus (latest)" },
      { id: "haiku", name: "Haiku (latest)" }
    ]);
  }
});

app.get("/", (req, res) => res.sendFile(join(__dirname, "index.html")));
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HiveLog running on :${PORT}`);

  // Task watchdog — every 30s, check for stuck "running" tasks
  setInterval(async () => {
    try {
      const tasks = loadTasks();
      const running = tasks.filter(t => t.status === "running");
      if (!running.length) return;

      // Check synapse for active jobs
      let synapseActive = 0;
      try {
        const h = await (await fetch(`${SYNAPSE_URL}/health`, { signal: AbortSignal.timeout(5000) })).json();
        synapseActive = h.activeJobs || 0;
      } catch {}

      // If synapse has no active jobs but HiveLog has running tasks, they're orphaned
      if (synapseActive === 0) {
        for (const t of running) {
          const runningFor = Date.now() - new Date(t.messages[t.messages.length - 1]?.timestamp || t.createdAt).getTime();
          if (runningFor > 120000) { // 2+ minutes with no synapse activity
            t.status = "failed";
            t.error = "Task orphaned — synapse completed but response was lost. Retry the task.";
            t.messages.push({ role: "agent", content: "Task timed out — synapse finished but the response was lost. Please retry.", files: [], timestamp: new Date().toISOString() });
            console.log(`Watchdog: marked ${t.id} as failed (orphaned)`);
          }
        }
        saveTasks(tasks);
      }
    } catch {}
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════
// TASK BOARD
// ═══════════════════════════════════════════════════════════════════

const TASKS_FILE = join(__dirname, "tasks.json");

function loadTasks() {
  try { return JSON.parse(readFileSync(TASKS_FILE, "utf-8")); }
  catch { return []; }
}
function saveTasks(tasks) { writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); }

// List tasks
app.get("/api/tasks", (req, res) => {
  const tasks = loadTasks();
  const status = req.query.status; // filter: pending, running, complete, failed
  res.json(status ? tasks.filter(t => t.status === status) : tasks);
});

// Create task
app.post("/api/tasks", (req, res) => {
  const { title, description, agent, attachments, outputFormat, model, timeline, scheduledDate, source, mode, agents, rounds } = req.body;
  if (!agent) return res.status(400).json({ error: "agent required" });
  if (!AGENTS.includes(agent)) return res.status(400).json({ error: "Unknown agent" });

  const tasks = loadTasks();
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    title: title || "",
    agent,
    outputFormat: outputFormat || "text",
    model: model || null,
    source: source || "user",
    status: timeline === "scheduled" ? "scheduled" : (mode === "conversation" ? "active" : "pending"),
    timeline: timeline || "immediate",
    scheduledDate: scheduledDate || null,
    sessionId: null,
    attempts: 0,
    maxRetries: 2,
    mode: mode || "task",
    agents: agents || [agent],
    messages: [{
      role: "user",
      content: description || title || "",
      attachments: attachments || [],
      timestamp: new Date().toISOString()
    }],
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null
  };
  tasks.unshift(task);
  saveTasks(tasks);

  res.json(task);

  if (mode === "conversation") {
    // Send first message to the conversation pipeline (runs in background after response)
    const firstMessage = description || title || "";
    const taskId = task.id;
    const taskAgent = task.agent;
    const taskRounds = rounds || 1;
    console.log(`[conv] Starting conversation ${taskId} → agent=${taskAgent}, rounds=${taskRounds}`);
    (async () => {
    try {
      const convResp = await fetch(`${SYNAPSE_URL}/api/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: firstMessage, rounds: taskRounds }),
        signal: AbortSignal.timeout(600000),
      });
      const data = await convResp.json();
      console.log(`[conv] Got response for ${taskId}: ${JSON.stringify(data).substring(0, 200)}`);
      let ts = loadTasks();
      const idx = ts.findIndex(x => x.id === taskId);
      if (idx >= 0) {
        if (data.responses && Array.isArray(data.responses)) {
          for (const r of data.responses) {
            ts[idx].messages.push({ role: "agent", agent: r.agent, content: r.response, timestamp: new Date().toISOString(), cost: r.cost || 0, round: r.round });
            if (ts[idx].agents && !ts[idx].agents.includes(r.agent)) ts[idx].agents.push(r.agent);
          }
        } else if (data.response) {
          ts[idx].messages.push({ role: "agent", agent: data.agent || taskAgent, content: data.response, timestamp: new Date().toISOString(), cost: data.cost || 0 });
        }
        ts[idx].status = "active";
        ts[idx].agent = data.pipeline ? data.pipeline[data.pipeline.length - 1] : (data.agent || taskAgent);
        if (!ts[idx].title) {
          const firstAgent = ts[idx].messages.find(m => m.role === "agent");
          if (firstAgent) ts[idx].title = firstAgent.content.split("\n")[0].replace(/[*#_]/g, "").substring(0, 60);
        }
        saveTasks(ts);
      }
    } catch (e) {
      console.error(`[conv] Error for ${taskId}: ${e.message}`);
      let ts = loadTasks();
      const idx = ts.findIndex(x => x.id === taskId);
      if (idx >= 0) {
        ts[idx].messages.push({ role: "error", content: `Conversation failed: ${e.message}`, timestamp: new Date().toISOString() });
        ts[idx].status = "failed";
        saveTasks(ts);
      }
    }
    })();
  }
});

// Edit task (pending/scheduled/failed only)
app.put("/api/tasks/:id", (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  // Allow close/reopen on any task, but other edits only on pending/scheduled/failed
  const isStatusChange = ["closed", "active", "incomplete", "deferred", "complete"].includes(req.body.status);
  if (!isStatusChange && !["pending", "scheduled", "failed"].includes(task.status)) {
    return res.status(400).json({ error: `Cannot edit task in ${task.status} state` });
  }
  const allowed = ["title", "agent", "outputFormat", "model", "timeline", "scheduledDate", "status"];
  for (const k of allowed) { if (req.body[k] !== undefined) task[k] = req.body[k]; }
  if (req.body.prompt) {
    task.messages[0].content = req.body.prompt;
  }
  saveTasks(tasks);
  res.json(task);
});

// Add a note to a task (no execution)
app.post("/api/tasks/:id/note", (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  task.messages.push({ role: "user", content: req.body.content || "", timestamp: new Date().toISOString() });
  saveTasks(tasks);
  res.json({ ok: true });
});

// Retry failed task
app.post("/api/tasks/:id/retry", (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!["failed", "incomplete"].includes(task.status)) return res.status(400).json({ error: "Only failed/incomplete tasks can be retried" });

  // Get original prompt from first user message
  const originalPrompt = (task.messages || []).find(m => m.role === "user")?.content || "";
  const lastError = task.error || "unknown";

  // Smart retry: tell agent to check memory first, only redo what's missing
  const smartPrompt = `SMART RETRY — check your memory before re-doing work.

Original task: ${originalPrompt}

Last error: ${lastError}

BEFORE doing anything:
1. Read your memory for today (memory/$(date +%Y-%m-%d).md)
2. Check if you already completed part of this task — look for query results, file paths, intermediate data
3. If prior work exists, SKIP those steps and only finish what's missing
4. If no prior work found, run the full task from scratch

After completing, clearly state what you did, what you reused from memory, and what you re-ran.
Start your response with a short title on the first line (max 60 chars, no markdown), then a blank line, then your full response.`;

  task.status = "pending";
  task.error = null;
  // Replace last message prompt with smart retry version
  if (task.messages && task.messages.length > 0) {
    task.messages.push({ role: "user", content: "[Smart Retry] Retrying with checkpoint awareness", timestamp: new Date().toISOString() });
  }
  saveTasks(tasks);
  res.json(task);
});

// Get cron schedule
app.get("/api/crons", (req, res) => {
  try {
    const crontab = execSync(`ssh -o ConnectTimeout=5 ${FLEET_SSH} "crontab -l 2>/dev/null"`, { timeout: 10000 }).toString();
    const lines = crontab.split("\n");
    const crons = [];
    let currentComment = "";
    for (const line of lines) {
      if (line.startsWith("#") && !line.startsWith("# ===")) {
        currentComment = line.replace(/^#\s*/, "");
      } else if (line.trim() && !line.startsWith("#")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const schedule = parts.slice(0, 5).join(" ");
          const command = parts.slice(5).join(" ");
          // Determine agent from command
          let agent = "system";
          if (command.includes("agent-monitor")) agent = "agent-monitor";
          else if (command.includes("agent-data")) agent = "agent-data";
          else if (command.includes("agent-orchestrator")) agent = "agent-orchestrator";
          crons.push({ name: currentComment || command.substring(0, 60), schedule, agent, command: command.substring(0, 200) });
        }
        currentComment = "";
      }
    }
    res.json(crons);
  } catch (e) {
    res.json([]);
  }
});

// Execute task (run it now)
// Reply to a task thread — uses CLI --continue for true session resumption
app.post("/api/tasks/:id/reply", async (req, res) => {
  let tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status === "running") return res.status(409).json({ error: "Already running" });

  const { content, attachments, model } = req.body;
  if (!content) return res.status(400).json({ error: "content required" });

  // Add user message to thread
  task.messages.push({
    role: "user",
    content,
    attachments: attachments || [],
    timestamp: new Date().toISOString()
  });
  task.status = "running";
  saveTasks(tasks);

  res.json({ status: "running", taskId: task.id });

  let prompt = content;

  // Handle attachments
  if (attachments && attachments.length > 0) {
    const uploadedPaths = [];
    for (const att of attachments) {
      const localPath = join(UPLOAD_DIR, att.filename);
      const remotePath = `$HOME/agents/${task.agent}/inbox/${att.filename}`;
      try {
        execSync(`ssh ${FLEET_SSH} "mkdir -p $HOME/agents/${task.agent}/inbox"`, { timeout: 5000 });
        execSync(`scp "${localPath}" ${FLEET_SSH}:"${remotePath}"`, { timeout: 30000 });
        uploadedPaths.push(remotePath);
      } catch {}
    }
    if (uploadedPaths.length > 0) {
      prompt += `\n\nNew attached files:\n${uploadedPaths.map(p => `- ${p}`).join("\n")}`;
    }
  }

  prompt += "\n\nAfter completing, clearly state what you did and the path to any output files.\nStart your response with a short title on the first line (max 60 chars, no markdown), then a blank line, then your full response.";

  try {
    let rawResult = "";
    let newSessionId = null;

    // Build context from conversation history
    const originalRequest = (task.messages.find(m => m.role === "user") || {}).content || "";
    const agentResults = task.messages.filter(m => m.role === "agent" && !m.content.startsWith("Error:") && !m.content.startsWith("{")).map(m => m.content.substring(0, 500)).join("\n---\n");
    const files = task.messages.flatMap(m => (m.files || []).map(f => f.path || f.name)).filter(Boolean);

    let fullPrompt = `Original task: ${originalRequest}\n`;
    if (agentResults) fullPrompt += `\nPrevious results:\n${agentResults.substring(0, 2000)}\n`;
    if (files.length) fullPrompt += `\nFiles produced:\n${files.map(f => "- " + f).join("\n")}\n`;
    fullPrompt += `\nNew instruction: ${prompt}`;

    // SDK session resume via synapse — passes sessionId for conversation continuation
    {
      const callbackUrl = `http://${HIVELOG_HOST}:${PORT}/api/tasks/${task.id}/callback`;
      const spawnPayload = {
        task: fullPrompt, timeout: 900000,
        model: model || task.model || null,
        callbackUrl, callbackTaskId: task.id,
      };
      // Pass sessionId for SDK resume if we have one
      if (task.sessionId) spawnPayload.sessionId = task.sessionId;
      await fetch(`${SYNAPSE_URL}/spawn/${task.agent}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spawnPayload),
        signal: AbortSignal.timeout(15000)
      });
      return; // Callback will handle the result
    }

    // Only reaches here if CLI --continue succeeded directly
    rawResult = String(rawResult || "");
    processTaskResult(task.id, task.agent, { text: rawResult, session_id: newSessionId });
  } catch (e) {
    tasks = loadTasks();
    const t = tasks.find(x => x.id === task.id);
    if (t) {
      t.messages.push({ role: "agent", content: `Error: ${e.message}`, files: [], timestamp: new Date().toISOString() });
      t.status = "failed";
      t.error = e.message;
      saveTasks(tasks);
    }
  }
});

// Conversation message — routes to synapse for multi-agent threads
app.post("/api/tasks/:id/message", (req, res) => {
  const { message, agent: targetAgent, rounds } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const taskId = req.params.id;

  // Add user message and upgrade to conversation mode if needed
  let tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.messages.push({ role: "user", content: message, timestamp: new Date().toISOString() });
    task.status = "in_progress";
    if (task.mode !== "conversation") {
      task.mode = "conversation";
      if (!task.agents) task.agents = [task.agent];
      // Backfill agent field on old messages that don't have one
      for (const m of task.messages) {
        if (m.role === "agent" && !m.agent) m.agent = task.agents[0] || task.agent;
      }
    }
    saveTasks(tasks);
  }

  // Return immediately — frontend polls for updates
  res.json({ status: "accepted", taskId });

  // Run pipeline in background
  (async () => {
    try {
      console.log(`[conv] Message in ${taskId} → synapse`);
      const resp = await fetch(`${SYNAPSE_URL}/api/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, rounds }),
        signal: AbortSignal.timeout(600000),
      });
      const data = await resp.json();
      console.log(`[conv] Response for ${taskId}: pipeline=${data.pipeline?.join("→")}, responses=${data.responses?.length || 0}`);

      // Synapse updates its own task record incrementally during the pipeline.
      // But we also need to sync the final state to hivelog's local tasks.
      tasks = loadTasks();
      const t = tasks.find(x => x.id === taskId);
      if (t) {
        if (data.responses && Array.isArray(data.responses)) {
          for (const r of data.responses) {
            // Only add if not already there (synapse might have added via updateTask)
            const exists = t.messages.some(m => m.role === "agent" && m.agent === r.agent && (m.content || "").substring(0, 100) === (r.response || "").substring(0, 100));
            if (!exists) {
              t.messages.push({ role: "agent", agent: r.agent, content: r.response, timestamp: new Date().toISOString(), cost: r.cost || 0, round: r.round });
              if (t.agents && !t.agents.includes(r.agent)) t.agents.push(r.agent);
            }
          }
          t.agent = data.responses[data.responses.length - 1]?.agent || t.agent;
        } else if (data.response) {
          t.messages.push({ role: "agent", agent: data.agent || targetAgent || t.agent, content: data.response, timestamp: new Date().toISOString(), cost: data.cost || 0 });
          t.agent = data.agent || targetAgent || t.agent;
        }
        t.status = "active";
        if (!t.title && t.messages.length > 1) {
          const firstAgent = t.messages.find(m => m.role === "agent");
          if (firstAgent) t.title = firstAgent.content.split("\n")[0].replace(/[*#_]/g, "").substring(0, 60);
        }
        saveTasks(tasks);
      }
    } catch (e) {
      console.error(`[conv] Error for ${taskId}: ${e.message}`);
      tasks = loadTasks();
      const t = tasks.find(x => x.id === taskId);
      if (t) {
        t.messages.push({ role: "error", content: `Pipeline error: ${e.message}`, timestamp: new Date().toISOString() });
        t.status = "active";
        saveTasks(tasks);
      }
    }
  })();
});

app.post("/api/tasks/:id/run", async (req, res) => {
  let tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status === "running") return res.status(409).json({ error: "Already running" });

  task.status = "running";
  saveTasks(tasks);

  // Acknowledge immediately — don't wait for synapse
  res.json({ status: "running", taskId: task.id });

  // Build prompt — check if this is a smart retry
  const isSmartRetry = task.messages?.some(m => m.content?.includes("[Smart Retry]"));
  const lastUserMsg = [...task.messages].reverse().find(m => m.role === "user" && !m.content?.includes("[Smart Retry]"));
  const originalPrompt = lastUserMsg ? lastUserMsg.content : task.title;
  let prompt;

  if (isSmartRetry) {
    // Smart retry: tell agent to check memory checkpoints before re-doing work
    const lastError = task.error || task.messages?.filter(m => m.role === "error").pop()?.content || "unknown";
    prompt = `SMART RETRY — check your memory before re-doing work.

Original task: ${originalPrompt}

Last error: ${lastError}

BEFORE doing anything:
1. Read your memory for today
2. Check if you already completed part of this task — look for query results, file paths, intermediate data
3. If prior work exists, SKIP those steps and only finish what's missing
4. If no prior work found, run the full task from scratch

After completing, clearly state what you reused from memory vs what you re-ran.`;
  } else {
    prompt = originalPrompt;
  }

  // If there are attachments on the last user message, copy them
  const attachments = lastUserMsg?.attachments || [];
  if (attachments.length > 0) {
    const uploadedPaths = [];
    for (const att of attachments) {
      const localPath = join(UPLOAD_DIR, att.filename);
      const remotePath = `$HOME/agents/${task.agent}/inbox/${att.filename}`;
      try {
        execSync(`ssh ${FLEET_SSH} "mkdir -p $HOME/agents/${task.agent}/inbox"`, { timeout: 5000 });
        execSync(`scp "${localPath}" ${FLEET_SSH}:"${remotePath}"`, { timeout: 30000 });
        uploadedPaths.push(remotePath);
      } catch (e) {
        console.error(`Failed to copy ${att.filename}:`, e.message);
      }
    }
    if (uploadedPaths.length > 0) {
      prompt += `\n\nAttached files (on disk, read them):\n${uploadedPaths.map(p => `- ${p}`).join("\n")}`;
    }
  }

  // Output format instructions
  if (task.outputFormat && task.outputFormat !== "text") {
    const fmtInstructions = {
      xlsx: "Save results as an Excel file (.xlsx) in your reports/ directory. Use openpyxl or pandas with the venv at $HOME/agents/agent-data/venv. Include a summary sheet with formatting.",
      csv: "Save results as a CSV file in your reports/ directory using pandas or csv module with the venv.",
      pdf: "Save results as a PDF file (.pdf) in your reports/ directory. Use fpdf2 with the venv at $HOME/agents/agent-data/venv. Include a title, headers, and formatted tables.",
      md: "Save results as a Markdown file (.md) in your reports/ directory. Use proper markdown formatting with headers, tables, code blocks as appropriate.",
      py: "Save results as a Python script (.py) in your reports/ directory. Include docstrings, comments, and make it runnable.",
      json: "Save results as a formatted JSON file (.json) in your reports/ directory. Use proper indentation.",
      html: "Save results as a standalone HTML file (.html) in your reports/ directory. Include inline CSS for styling, make it presentable.",
      png: "Save results as a PNG image (.png) in your reports/ directory. Use matplotlib with the venv at $HOME/agents/agent-data/venv to create charts/visualizations.",
      pptx: "Save results as a PowerPoint file (.pptx) in your reports/ directory. Use python-pptx with the venv at $HOME/agents/agent-data/venv. Include title slide and content slides.",
      docx: "Save results as a Word document (.docx) in your reports/ directory. Use python-docx with the venv at $HOME/agents/agent-data/venv. Include headers and formatted content.",
      txt: "Save results as a plain text file (.txt) in your reports/ directory."
    };
    prompt += `\n\nOutput format: ${fmtInstructions[task.outputFormat] || "Return as text."}`;
  }

  prompt += "\n\nAfter completing, clearly state what you did, what you found, and the path to any output files.\nStart your response with a short title on the first line (max 60 chars, no markdown), then a blank line, then your full response.";

  // Execute via callback — synapse calls us back when done
  try {
    const callbackUrl = `http://${HIVELOG_HOST}:${PORT}/api/tasks/${task.id}/callback`;
    const resp = await fetch(`${SYNAPSE_URL}/spawn/${task.agent}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: prompt, timeout: 900000, callbackUrl, callbackTaskId: task.id }),
      signal: AbortSignal.timeout(15000) // Just needs to accept, not finish
    });
    const data = await resp.json();
    if (data.status !== "accepted" && data.status !== "complete") {
      throw new Error(data.error || "Synapse rejected task");
    }
    // If sync response came back (backward compat), process it
    if (data.status === "complete" && data.result) {
      processTaskResult(task.id, task.agent, data.result);
    }
  } catch (e) {
    const updatedTasks = loadTasks();
    const updatedTask = updatedTasks.find(t => t.id === task.id);
    if (updatedTask) {
      updatedTask.status = "failed";
      updatedTask.error = e.message;
      updatedTask.completedAt = new Date().toISOString();
      saveTasks(updatedTasks);
    }
  }
});

// Delete task
app.delete("/api/tasks/:id", (req, res) => {
  let tasks = loadTasks();
  tasks = tasks.filter(t => t.id !== req.params.id);
  saveTasks(tasks);
  res.json({ ok: true });
});

// Download result file from agent
app.get("/api/tasks/:id/download/:filename", (req, res) => {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  // Search all messages for the file
  let file = null;
  for (const msg of task.messages || []) {
    const f = (msg.files || []).find(f => f.name === req.params.filename);
    if (f) { file = f; break; }
  }
  if (!file) return res.status(404).json({ error: "File not found" });

  try {
    const content = execSync(`ssh -o ConnectTimeout=5 ${FLEET_SSH} "cat '${file.path}'"`, { timeout: 30000 });
    const ext = extname(file.name).toLowerCase();
    const types = { ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".csv": "text/csv", ".pdf": "application/pdf", ".json": "application/json",
      ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html",
      ".py": "text/x-python", ".png": "image/png", ".jpg": "image/jpeg",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
    res.set("Content-Type", types[ext] || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${file.name}"`);
    res.send(content);
  } catch { res.status(500).json({ error: "Download failed" }); }
});

// ═══════════════════════════════════════════════════════════════════
// TASK CALLBACK — synapse calls this when a task completes
// ═══════════════════════════════════════════════════════════════════

function processTaskResult(taskId, agentName, resultData) {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  const resultObj = typeof resultData === "object" ? resultData : { text: String(resultData) };
  const rawResult = String(resultObj?.text || resultObj || "");
  const lines = rawResult.split("\n");
  let msgTitle = "";
  let msgContent = rawResult;
  if (lines.length > 1 && lines[0].length <= 80 && lines[0].length > 0) {
    msgTitle = lines[0].replace(/^#+\s*/, "").trim();
    msgContent = lines.slice(1).join("\n").trim();
  }

  // Check for new files
  let newFiles = [];
  try {
    const filesOutput = sshCmd(FLEET_SSH,
      `find $HOME/agents/${agentName}/reports/ -newer $HOME/agents/${agentName}/reports/.last_check -type f 2>/dev/null; touch $HOME/agents/${agentName}/reports/.last_check`);
    if (filesOutput) {
      newFiles = filesOutput.split("\n").filter(Boolean).map(f => ({ path: f, name: f.split("/").pop() }));
    }
  } catch {}

  // Dedup: if in_progress already added this content, update it instead of pushing new
  const existingIdx = task.messages.findIndex(m => m.role === "agent" && m.content && msgContent && m.content.substring(0, 200) === msgContent.substring(0, 200));
  if (existingIdx >= 0) {
    // Update existing message with title, files, and final content
    task.messages[existingIdx] = { ...task.messages[existingIdx], title: msgTitle, content: msgContent, files: newFiles, timestamp: new Date().toISOString() };
  } else {
    task.messages.push({ role: "agent", title: msgTitle, content: msgContent, files: newFiles, timestamp: new Date().toISOString() });
  }
  if (!task.title && msgTitle) task.title = msgTitle;
  else if (!task.title) task.title = rawResult.substring(0, 60).split("\n")[0];
  if (resultObj?.session_id) task.sessionId = resultObj.session_id;
  task.status = "complete";
  task.completedAt = new Date().toISOString();
  saveTasks(tasks);
  console.log(`Callback: task ${taskId} completed for ${agentName}`);
}

app.post("/api/tasks/:id/callback", (req, res) => {
  const taskId = req.params.id;
  const { agent, status, result, error, content, cost, round } = req.body;

  if (status === "in_progress" && content) {
    // Incremental pipeline update — agent just responded
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      // Only add if not already there
      const exists = task.messages.some(m => m.role === "agent" && m.agent === agent && m.content === content);
      if (!exists) {
        task.messages.push({ role: "agent", agent, content, cost: cost || 0, round, timestamp: new Date().toISOString() });
        if (task.agents && !task.agents.includes(agent)) task.agents.push(agent);
        task.status = "in_progress";
        task.agent = agent;
        if (!task.title) task.title = content.split("\n")[0].replace(/[*#_]/g, "").substring(0, 60);
        saveTasks(tasks);
      }
    }
    res.json({ ok: true });
  } else if (status === "complete" && result) {
    processTaskResult(taskId, agent, result);
    res.json({ ok: true });
  } else if (status === "error") {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      task.messages.push({ role: "agent", content: `Error: ${error || "Unknown error"}`, files: [], timestamp: new Date().toISOString() });
      task.status = "failed";
      task.error = error || "Unknown error";
      saveTasks(tasks);
    }
    res.json({ ok: true });
  } else {
    res.json({ ok: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SCHEMA REFRESH (on-demand)
// ═══════════════════════════════════════════════════════════════════

app.post("/api/schema/refresh", async (req, res) => {
  res.json({ status: "started", message: "Schema refresh dispatched to Agent-Data" });
  try {
    await fetch(`${SYNAPSE_URL}/spawn/agent-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "Refresh the schema documentation. For each view in docs/views/, query the database to verify column names are still correct. Update any files that have changed. Write a summary of changes to memory.",
        
        timeout: 600000
      })
    });
  } catch {}
});

// ── Query Log API ──────────────────────────────────────────────────────────
function getQueryLogDb() {
  const dbPath = join(__dirname, "query-log.db");
  if (!existsSync(dbPath)) return null;
  try { return new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return null; }
}

app.get("/api/query-log", (req, res) => {
  const db = getQueryLogDb();
  if (!db) return res.json({ queries: [], total: 0, page: 1, limit: 50 });
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const total = db.prepare("SELECT COUNT(*) as c FROM query_log").get().c;
    const queries = db.prepare("SELECT * FROM query_log ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
    db.close();
    res.json({ queries, total, page, limit });
  } catch (e) {
    try { db.close(); } catch {}
    res.json({ queries: [], total: 0, page: 1, limit: 50, error: String(e) });
  }
});

app.get("/api/query-log/:id", (req, res) => {
  const db = getQueryLogDb();
  if (!db) return res.json({ error: "No query log" });
  try {
    const row = db.prepare("SELECT * FROM query_log WHERE id = ?").get(req.params.id);
    db.close();
    res.json(row || { error: "Not found" });
  } catch (e) {
    try { db.close(); } catch {}
    res.json({ error: String(e) });
  }
});

app.get("/api/query-stats", (req, res) => {
  const db = getQueryLogDb();
  if (!db) return res.json({ today: {}, week: {}, month: {}, by_tool: [], by_client: [], hourly: [], daily: [], clients: [] });
  try {
    const cid = req.query.client_id;
    const cf = cid ? ` AND client_id = '${cid.replace(/'/g, "")}'` : "";
    const today = db.prepare(`SELECT COUNT(*) as count, COALESCE(AVG(duration_ms),0) as avg_duration,
      COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0),0) as success_rate
      FROM query_log WHERE timestamp >= date('now','start of day')${cf}`).get();
    const week = db.prepare(`SELECT COUNT(*) as count, COALESCE(AVG(duration_ms),0) as avg_duration
      FROM query_log WHERE timestamp >= date('now','weekday 0','-7 days')${cf}`).get();
    const month = db.prepare(`SELECT COUNT(*) as count, COALESCE(AVG(duration_ms),0) as avg_duration
      FROM query_log WHERE timestamp >= date('now','start of month')${cf}`).get();
    const by_tool = db.prepare(`SELECT tool_name, COUNT(*) as count, COALESCE(AVG(duration_ms),0) as avg_duration
      FROM query_log WHERE 1=1${cf} GROUP BY tool_name ORDER BY count DESC`).all();
    const by_client = db.prepare(`SELECT COALESCE(client_id,'default') as client_id, COALESCE(client_type,'unknown') as client_type,
      COUNT(*) as count, COALESCE(AVG(duration_ms),0) as avg_duration
      FROM query_log GROUP BY client_id, client_type ORDER BY count DESC`).all();
    const hourly = db.prepare(`SELECT strftime('%Y-%m-%dT%H:00', timestamp) as hour, COUNT(*) as count,
      COALESCE(AVG(duration_ms),0) as avg_duration FROM query_log
      WHERE timestamp >= datetime('now','-24 hours')${cf} GROUP BY hour ORDER BY hour`).all();
    const daily = db.prepare(`SELECT date(timestamp) as date, COUNT(*) as count
      FROM query_log WHERE timestamp >= date('now','-30 days')${cf} GROUP BY date ORDER BY date`).all();
    const clients = db.prepare(`SELECT DISTINCT COALESCE(client_id,'default') as client_id, COALESCE(client_type,'unknown') as client_type FROM query_log`).all();
    db.close();
    res.json({ today, week, month, by_tool, by_client, hourly, daily, clients });
  } catch (e) {
    try { db.close(); } catch {}
    res.json({ today: {}, week: {}, month: {}, by_tool: [], by_client: [], hourly: [], daily: [], clients: [], error: String(e) });
  }
});


// ── Baseline Test API ─────────────────────────────────────────────────────
app.get("/api/baseline", (req, res) => {
  const db = getQueryLogDb();
  if (!db) return res.json({ dates: [], history: [] });
  try {
    // Get all dates with queries
    const dates = db.prepare("SELECT DISTINCT date(timestamp) as date FROM query_log ORDER BY date DESC LIMIT 30").all().map(r => r.date);
    
    // Build stats per date
    const history = [];
    for (const date of dates) {
      const total = db.prepare("SELECT COUNT(*) as c FROM query_log WHERE date(timestamp) = ?").get(date).c;
      const tools = db.prepare("SELECT tool_name, COUNT(*) as count, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) as ok FROM query_log WHERE date(timestamp) = ? GROUP BY tool_name").all(date);
      const clients = db.prepare("SELECT DISTINCT COALESCE(client_id,'default') as client_id, COALESCE(client_type,'unknown') as client_type FROM query_log WHERE date(timestamp) = ?").all(date);
      const fails = db.prepare("SELECT COUNT(*) as c FROM query_log WHERE date(timestamp) = ? AND success=0").get(date).c;
      const avgMs = db.prepare("SELECT COALESCE(AVG(duration_ms),0) as avg FROM query_log WHERE date(timestamp) = ?").get(date).avg;
      
      const toolMap = {};
      for (const t of tools) toolMap[t.tool_name] = { count: t.count, success: t.ok };
      
      history.push({
        date,
        total,
        tools: toolMap,
        clients: clients.map(c => c.client_id + "/" + c.client_type),
        failures: fails,
        avgDuration: Math.round(avgMs),
        v2Pct: Math.round(
          (tools.filter(t => ["build_query","raw_query","find_relevant_schema","find_similar_queries","query_template","query_lab_pivot","query_feedback","describe_view","list_views","search_technical_docs"].includes(t.tool_name))
            .reduce((s, t) => s + t.count, 0) / Math.max(total, 1)) * 100
        ),
      });
    }
    
    db.close();
    res.json({ dates, history });
  } catch (e) {
    try { db.close(); } catch {}
    res.json({ dates: [], history: [], error: String(e) });
  }
});

app.get("/api/baseline/date/:date", (req, res) => {
  const db = getQueryLogDb();
  if (!db) return res.json({ queries: [] });
  try {
    const queries = db.prepare(`
      SELECT tool_name, success, duration_ms, row_count, query_text, error_message,
        COALESCE(client_id,'default') as client_id, COALESCE(client_type,'unknown') as client_type, timestamp
      FROM query_log WHERE date(timestamp) = ? ORDER BY id
    `).all(req.params.date);
    db.close();
    res.json({ date: req.params.date, queries, total: queries.length });
  } catch (e) {
    try { db.close(); } catch {}
    res.json({ queries: [], error: String(e) });
  }
});


// ── Baseline Scoring ──────────────────────────────────────────────────────
app.get("/api/baseline/score/:date", (req, res) => {
  const db = getQueryLogDb();
  if (!db) return res.json({ matched: 0, results: [] });

  const QUESTIONS = [
    { id: 1, name: "Truly active wells", keywords: ["truly active", "records", "district"] },
    { id: 2, name: "Active IPs on wells", keywords: ["injection", "active", "records", "district"] },
    { id: 3, name: "Bacteria lab data", keywords: ["audit", "log", "department"] },
    { id: 4, name: "Corrosion measurements", keywords: ["performance", "latency", "district"] },
    { id: 5, name: "Lab samples per well", keywords: ["orders", "samples", "department", "users"] },
    { id: 6, name: "Suspended treatments", keywords: ["suspended", "14 days", "schedule"] },
    { id: 7, name: "Top chemical products", keywords: ["top", "products", "usage"] },
    { id: 8, name: "Dark tanks", keywords: ["no data", "dark", "devices", "30 days"] },
    { id: 9, name: "Treatment status breakdown", keywords: ["schedule", "status", "breakdown"] },
    { id: 10, name: "H2S concerns", keywords: ["compliance", "concerns", "department"] },
  ];

  function matchQ(text) {
    const lower = text.toLowerCase();
    let best = null, bestScore = 0;
    for (const q of QUESTIONS) {
      const hits = q.keywords.filter(k => lower.includes(k));
      if (hits.length >= 2 && hits.length > bestScore) { bestScore = hits.length; best = q; }
    }
    return best;
  }

  try {
    const date = req.params.date;
    const allQ = db.prepare("SELECT id, tool_name, success, duration_ms, row_count, query_text, error_message, client_id, timestamp FROM query_log WHERE date(timestamp) = ? ORDER BY id").all(date);
    const schemaLinks = allQ.filter(q => q.tool_name === "find_relevant_schema");
    const results = [];
    const matchedIds = new Set();

    for (const sl of schemaLinks) {
      const question = (sl.query_text || "").replace("SCHEMA_LINK: ", "");
      const match = matchQ(question);
      if (!match || matchedIds.has(match.id)) continue;
      matchedIds.add(match.id);
      const slTime = new Date(sl.timestamp).getTime();
      const followUp = allQ.filter(q => {
        const qt = new Date(q.timestamp).getTime();
        return qt >= slTime && qt <= slTime + 300000 && q.id > sl.id &&
          ["build_query","raw_query","read_data","query_template","query_lab_pivot","query_feedback","describe_view"].includes(q.tool_name);
      });
      const dataQ = followUp.filter(q => ["build_query","raw_query","read_data","query_template"].includes(q.tool_name));
      const ok = dataQ.filter(q => q.success);
      const fails = dataQ.filter(q => !q.success);
      const usedBuild = dataQ.some(q => q.tool_name === "build_query" && q.success);
      const usedRaw = dataQ.some(q => q.tool_name === "raw_query" && q.success);
      const usedTemplate = dataQ.some(q => q.tool_name === "query_template" && q.success);
      const usedReadData = dataQ.some(q => q.tool_name === "read_data");
      const totalMs = dataQ.reduce((s, q) => s + (q.duration_ms || 0), 0);
      const firstTry = fails.length === 0 && ok.length > 0;
      const gotResults = ok.some(q => (q.row_count || 0) > 0);
      let score = 0;
      if (gotResults) score += 3;
      if (firstTry) score += 2;
      if (usedBuild || usedTemplate) score += 2;
      if (!usedReadData) score += 1;
      if (fails.length === 0) score += 1;
      if (dataQ.length <= 2) score += 1;
      const tool = usedTemplate ? "template" : usedBuild ? "build" : usedRaw ? "raw" : usedReadData ? "read_data" : "?";
      results.push({ id: match.id, name: match.name, score, queries: dataQ.length, fails: fails.length, tool, firstTry, totalMs, gotResults });
    }

    // Also match directly against SQL
    for (const bq of QUESTIONS) {
      if (matchedIds.has(bq.id)) continue;
      const dm = allQ.filter(q => ["build_query","raw_query","query_template"].includes(q.tool_name) && bq.keywords.filter(k => (q.query_text||"").toLowerCase().includes(k)).length >= 2);
      if (dm.length > 0) {
        matchedIds.add(bq.id);
        const ok = dm.filter(q => q.success);
        const fails = dm.filter(q => !q.success);
        const totalMs = dm.reduce((s, q) => s + (q.duration_ms || 0), 0);
        let score = 0;
        if (ok.some(q => (q.row_count||0) > 0)) score += 3;
        if (fails.length === 0) score += 3;
        if (!dm.some(q => q.tool_name === "read_data")) score += 2;
        if (dm.length <= 2) score += 1;
        score = Math.min(score, 10);
        const tool = dm.some(q => q.tool_name === "query_template") ? "template" : dm.some(q => q.tool_name === "build_query") ? "build" : "raw";
        results.push({ id: bq.id, name: bq.name, score, queries: dm.length, fails: fails.length, tool, firstTry: fails.length === 0, totalMs, gotResults: ok.some(q => (q.row_count||0) > 0) });
      }
    }

    results.sort((a, b) => a.id - b.id);
    const totalScore = results.reduce((s, r) => s + r.score, 0);
    const maxScore = results.length * 10;
    db.close();
    res.json({ date, matched: results.length, results, totalScore, maxScore });
  } catch (e) {
    try { db.close(); } catch {}
    res.json({ matched: 0, results: [], error: String(e) });
  }
});

// ── Fleet Ops API ─────────────────────────────────────────────────────────
app.get("/api/fleet-ops", (req, res) => {
  try {
    const ops = execSync(`ssh -o ConnectTimeout=5 ${FLEET_SSH} "cat $HOME/shared/FLEET-OPS.md 2>/dev/null"`, { timeout: 10000 }).toString();
    res.json({ content: ops });
  } catch {
    res.json({ content: "# Fleet Ops\n\nNo escalations." });
  }
});

// ── Synapse Task Proxy (for task list from synapse) ──────────────────────
app.get("/api/synapse-tasks", async (req, res) => {
  try {
    const r = await fetch(`${SYNAPSE_URL}/api/tasks?${new URL(req.url, "http://localhost").search.substring(1)}`);
    res.json(await r.json());
  } catch {
    res.json({ tasks: [], total: 0 });
  }
});

// ── Approvals API ─────────────────────────────────────────────────────────
function loadApprovals() {
  try { return JSON.parse(sshCmd(FLEET_SSH, "cat $HOME/shared/approvals.json 2>/dev/null") || "[]"); }
  catch { return []; }
}

function saveApprovals(approvals) {
  try {
    const tmpFile = "/tmp/approvals-sync.json";
    writeFileSync(tmpFile, JSON.stringify(approvals));
    execSync("scp " + tmpFile + " " + FLEET_SSH + ":shared/approvals.json", { timeout: 10000 });
  } catch (e) { console.error("saveApprovals failed:", e.message); }
}


app.get("/api/approvals", (req, res) => {
  res.json(loadApprovals());
});

app.post("/api/approvals", (req, res) => {
  const { agent, type, target, description, reason, diff, proposedAction } = req.body;
  if (!agent || !description) return res.status(400).json({ error: "agent and description required" });
  const approvals = loadApprovals();

  // Dedup: check if a similar pending approval already exists from this agent
  const pending = approvals.filter(a => a.status === "pending" && a.agent === agent);
  const descLower = description.toLowerCase();
  const targetLower = (target || "").toLowerCase();
  const dupe = pending.find(a => {
    const existDesc = (a.description || "").toLowerCase();
    const existTarget = (a.target || "").toLowerCase();
    // Same target, or descriptions share >60% of words
    if (existTarget && targetLower && existTarget === targetLower) return true;
    const words1 = new Set(descLower.split(/\s+/).filter(w => w.length > 3));
    const words2 = new Set(existDesc.split(/\s+/).filter(w => w.length > 3));
    const overlap = [...words1].filter(w => words2.has(w)).length;
    const maxLen = Math.max(words1.size, words2.size, 1);
    return overlap / maxLen > 0.6;
  });
  if (dupe) return res.status(409).json({ error: "Similar pending approval already exists", existingId: dupe.id, existingTarget: dupe.target });
  const approval = {
    id: `APR-${Date.now()}`,
    agent,
    type: type || "script-edit",
    target: target || "",
    description,
    reason: reason || "",
    diff: diff || "",
    proposedAction: proposedAction || "",
    status: "pending",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
  approvals.unshift(approval);
  saveApprovals(approvals);
  res.json(approval);
});

app.post("/api/approvals/:id/approve", async (req, res) => {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === req.params.id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  if (approval.status !== "pending") return res.status(400).json({ error: "Already resolved" });

  const executeAs = req.body.executeAs || approval.agent;

  approval.status = "approved";
  approval.resolvedAt = new Date().toISOString();
  approval.resolvedBy = "admin";
  approval.executedBy = executeAs;
  saveApprovals(approvals);

  if (approval.proposedAction) {
    const callbackUrl = `http://${HIVELOG_HOST}:${PORT}/api/approvals/${approval.id}/result`;

    // Include access context so the agent knows what it can/can't do
    const accessNote = {
      orchestrator: "You have access to: fleet filesystem, synapse, all agent workspaces, SSH to configured hosts",
      data: "You have access to: database (read-only), reports dir, Python venv",
      monitor: "You have access to: monitored VM via SSH, monitor scripts, local logs",
    }[executeAs] || "";

    const task = `APPROVED CHANGE (executing on behalf of ${approval.agent}):\n${approval.proposedAction}\n\nTarget: ${approval.target}\nReason: ${approval.reason}\n\n${accessNote}\n\nIf you don't have access to make this change, explain what's needed and who should do it instead. Don't attempt changes outside your access scope.`;

    try {
      await fetch(`${SYNAPSE_URL}/spawn/${executeAs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          callbackUrl,
          callbackTaskId: approval.id,
          timeout: 300000,
          source: "approval",
        }),
        signal: AbortSignal.timeout(15000)
      });
    } catch {}
  }
  res.json(approval);
});

app.post("/api/approvals/:id/reject", (req, res) => {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === req.params.id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  approval.status = "rejected";
  approval.resolvedAt = new Date().toISOString();
  approval.resolvedBy = "admin";
  approval.rejectReason = req.body.reason || "";
  saveApprovals(approvals);
  res.json(approval);
});


app.post("/api/approvals/:id/acknowledge", (req, res) => {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === req.params.id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  approval.status = "acknowledged";
  approval.resolvedAt = new Date().toISOString();
  approval.resolvedBy = "admin";
  approval.workaround = req.body.workaround || "";
  approval.rootFixNeeded = req.body.rootFixNeeded || "";
  saveApprovals(approvals);
  res.json(approval);
});

app.post("/api/approvals/:id/result", (req, res) => {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === req.params.id);
  if (approval) {
    approval.executionResult = req.body.result?.text || req.body.error || "Done";
    saveApprovals(approvals);
  }
  res.json({ ok: true });
});


// ── Approval Discussion Thread ────────────────────────────────────────────
app.post("/api/approvals/:id/discuss", (req, res) => {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === req.params.id);
  if (!approval) return res.status(404).json({ error: "Not found" });

  const { from, message, agent } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  if (!approval.discussion) approval.discussion = [];
  const comment = {
    id: Date.now(),
    from: from || "admin",
    message,
    timestamp: new Date().toISOString(),
  };
  approval.discussion.push(comment);
  saveApprovals(approvals);

  // If 'agent' specified, spawn that agent to weigh in
  if (agent) {
    const prompt = "APPROVAL DISCUSSION — " + approval.id + "\n" +
      "Original request from " + approval.agent + ": " + approval.description + "\n" +
      "Target: " + (approval.target || "N/A") + "\n" +
      "Proposed action: " + (approval.proposedAction || "N/A") + "\n" +
      "New comment from " + (from || "admin") + ": " + message + "\n\n" +
      "Review this approval request. Give your assessment — should it be approved, rejected, or modified? Be concise.";

    fetch(SYNAPSE_URL + "/spawn/" + agent, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: prompt, source: "approval-discussion" }),
      signal: AbortSignal.timeout(300000),
    }).then(async (r) => {
      try {
        const result = await r.json();
        const agentResponse = result.result?.text || result.result?.result || "No response";
        approval.discussion.push({
          id: Date.now(),
          from: agent,
          message: agentResponse.substring(0, 2000),
          timestamp: new Date().toISOString(),
          isAgent: true,
        });
        saveApprovals(approvals);
      } catch {}
    }).catch(() => {});
  }

  res.json({ ok: true, comment, discussionLength: approval.discussion.length });
});


app.put("/api/approvals/:id", (req, res) => {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === req.params.id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  if (approval.status !== "pending") return res.status(400).json({ error: "Cannot edit resolved approvals" });

  const allowed = ["description", "reason", "proposedAction", "target", "type", "diff"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) approval[key] = req.body[key];
  }
  approval.lastEditedAt = new Date().toISOString();
  approval.lastEditedBy = req.body.editedBy || "admin";
  saveApprovals(approvals);
  res.json(approval);
});

// ── Weekly Summary API ────────────────────────────────────────────────────
app.get("/api/weekly-summary", (req, res) => {
  try {
    const summary = sshCmd(FLEET_SSH, "cat $HOME/shared/weekly-summary.md 2>/dev/null");
    res.json({ content: summary || "No weekly summary yet. Runs every Friday at 4PM CT." });
  } catch {
    res.json({ content: "No weekly summary yet." });
  }
});

app.post("/api/weekly-summary/generate", async (req, res) => {
  res.json({ status: "generating" });
  try {
    const callbackUrl = `http://${HIVELOG_HOST}:${PORT}/api/tasks/weekly-summary/callback`;
    await fetch(`${SYNAPSE_URL}/spawn/agent-orchestrator`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "Generate the weekly fleet summary. Read all agents' memory files for this week. Compile: total tasks completed/failed, total cost from usage.json, key findings, data anomalies, reports generated, escalations. Format as a clean summary. Save to ~/shared/weekly-summary.md.",
        callbackUrl,
        timeout: 300000
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {}
});

// ── Fleet Docs API ────────────────────────────────────────────────────────
app.get("/api/fleet-docs", (req, res) => {
  try {
    const docs = sshCmd(FLEET_SSH, `cat ${AGENT_DIR}/agent-orchestrator/FLEET-DOCS.md 2>/dev/null`, 15000);
    res.json({ content: docs || "No fleet docs found. Generate from ~/agents/agent-orchestrator/FLEET-DOCS.md" });
  } catch {
    res.json({ content: "Error loading fleet docs." });
  }
});

// ── Feedback API (for test plan) ──────────────────────────────────────────
const FEEDBACK_FILE = join(__dirname, "feedback.json");

app.get("/api/feedback", (req, res) => {
  try { res.json(JSON.parse(readFileSync(FEEDBACK_FILE, "utf-8"))); }
  catch { res.json({}); }
});

app.post("/api/feedback", (req, res) => {
  try {
    writeFileSync(FEEDBACK_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Query Log Ingest (real-time from MCP servers) ─────────────────────────
app.post("/api/query-log", (req, res) => {
  const dbPath = join(__dirname, "query-log.db");
  let db;
  try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      query_text TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      row_count INTEGER DEFAULT 0,
      success INTEGER NOT NULL,
      error_message TEXT,
      caller TEXT DEFAULT 'mcp',
      client_id TEXT DEFAULT 'default',
      client_type TEXT DEFAULT 'unknown'
    );
    CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_query_log_client ON query_log(client_id);`);
    try { db.exec("ALTER TABLE query_log ADD COLUMN client_id TEXT DEFAULT 'default'"); } catch(e) {}
    try { db.exec("ALTER TABLE query_log ADD COLUMN client_type TEXT DEFAULT 'unknown'"); } catch(e) {}
  } catch (e) {
    return res.status(500).json({ error: "Failed to open query log DB: " + String(e) });
  }

  try {
    const { tool_name, query_text, duration_ms, row_count, success, error_message, caller, timestamp, client_id, client_type } = req.body;
    if (!tool_name || !query_text) {
      db.close();
      return res.status(400).json({ error: "tool_name and query_text required" });
    }
    const stmt = db.prepare(`INSERT INTO query_log (timestamp, tool_name, query_text, duration_ms, row_count, success, error_message, caller, client_id, client_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(
      timestamp || new Date().toISOString(),
      tool_name,
      query_text.substring(0, 5000),
      Math.round(duration_ms || 0),
      row_count || 0,
      success ? 1 : 0,
      error_message || null,
      caller || "mcp",
      client_id || "default",
      client_type || "unknown"
    );
    db.close();
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    try { db.close(); } catch {}
    res.status(500).json({ error: String(e) });
  }
});
