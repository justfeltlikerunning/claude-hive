// Synapse Configuration — NOT committed to repo
// Copy synapse-config.example.js → synapse-config.js and fill in your values
export default {
  // HiveLog callback URL (where task results are posted)
  HIVELOG_URL: "http://YOUR_HIVELOG_IP:3000",

  // Agent definitions
  agents: {
    // Add your agents here. Each needs: workspace, description, model, allowedTools
    // Example:
    // myagent: {
    //   workspace: "agents/myagent",  // relative to HOME
    //   description: "What this agent does",
    //   model: "sonnet",
    //   allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    //   mcpConfigKey: "mssql-server",  // optional: key in .claude.json mcpServers to pass to SDK
    // },
  },

  // Default orchestrator agent (receives escalations, default @mention target)
  orchestratorAgent: "myagent",

  // File format output instructions (referenced by agent prompts)
  formatInstructions: {
    xlsx: "Save results as an Excel file (.xlsx) in your reports/ directory.",
    csv: "Save results as a CSV file (.csv) in your reports/ directory.",
    pdf: "Save results as a PDF file (.pdf) in your reports/ directory.",
    md: "Format results as clean markdown.",
    json: "Return results as valid JSON.",
    py: "Write a Python script to your scripts/ directory.",
    html: "Generate an HTML file in your reports/ directory.",
    png: "Save results as a PNG chart (.png) in your reports/ directory.",
    pptx: "Save results as a PowerPoint (.pptx) in your reports/ directory.",
    docx: "Save results as a Word document (.docx) in your reports/ directory.",
  },
};
