// HiveLog Configuration Example
// Copy to config.js and fill in your values
export default {
  // Network
  HIVELOG_HOST: "YOUR_HIVELOG_IP",
  FLEET_HOST: "YOUR_FLEET_IP",
  GPU_HOST: "YOUR_GPU_IP",
  FLEET_SSH: "user@YOUR_FLEET_IP",
  GPU_SSH: "user@YOUR_GPU_IP",
  FLEET_METRICS: "http://YOUR_FLEET_IP:9100/metrics",
  GPU_METRICS: "http://YOUR_GPU_IP:9100/metrics",
  SYNAPSE_PORT: 18789,

  // Agents — customize names, colors, roles
  agents: [
    { id: "agent-orchestrator", name: "Agent-Orchestrator", color: "#4ecdc4", initials: "AO", role: "Orchestrator" },
    { id: "agent-data", name: "Agent-Data", color: "#60a5fa", initials: "AD", role: "Data/DB agent" },
    { id: "agent-monitor", name: "Agent-Monitor", color: "#e8a838", initials: "AM", role: "Monitor agent" },
  ],

  // GPU services to monitor
  gpuServices: [
    { key: "tts", name: "TTS", checkUrl: null },
    { key: "imageGen", name: "ImageGen", checkUrl: null },
    { key: "whisper", name: "Whisper", checkUrl: "http://YOUR_GPU_IP:9803/health" },
    { key: "embedding", name: "Embedding", checkUrl: "http://YOUR_GPU_IP:9804/health" },
  ],
  gpuHealthUrls: {
    tts_voices: "http://YOUR_GPU_IP:9800/voices",
    img_health: "http://YOUR_GPU_IP:9801/health",
    whisper_health: "http://YOUR_GPU_IP:9803/health",
    embed_health: "http://YOUR_GPU_IP:9804/health",
  },
};
