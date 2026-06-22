import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey, Key } from "@earendil-works/pi-tui";

interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}

type BackendName = "pi-subprocess";
type GateStatus = "approved" | "changes_requested" | "blocked" | "complete" | "incomplete" | string;

type StepDef = {
  id: string;
  agent: string;
  task: string;
  gate?: GateDef;
  output?: string;
  model?: string;
  tools?: string[];
};

type LoopMemoryDef = {
  observational?: boolean;
  compressAfterIterations?: number;
  observerAgent?: string;
  reflectorAgent?: string;
  messageTokensThreshold?: number;
  observationTokensThreshold?: number;
};

type LoopDef = {
  id: string;
  maxIterations: number;
  body: StepDef[];
  gateStep: string;
  passStatuses?: string[];
  retryStatuses?: string[];
  stopStatuses?: string[];
  onExhausted?: "stop" | "continue";
  memory?: LoopMemoryDef;
};

type WorkflowNode = StepDef | { loop: LoopDef };

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "..");

type WorkflowDef = {
  name: string;
  description?: string;
  version?: string;
  backend?: BackendName;
  defaults?: {
    maxIterations?: number;
    agentScope?: "user" | "project" | "both";
  };
  steps: WorkflowNode[];
};

type AgentDef = {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  source: string;
};

type StepResult = {
  id: string;
  agent: string;
  iteration?: number;
  output: string;
  json?: any;
  status?: GateStatus;
  artifactPath?: string;
  exitCode: number;
  stderr?: string;
};

type RunContext = {
  cwd: string;
  task: string;
  artifactsDir: string;
  outputs: Record<string, StepResult>;
  sequence: StepResult[];
  params: Record<string, any>;
};

type TuiState = {
  workflowName: string;
  task: string;
  activeAgent: string;
  activeStep: string;
  activeIteration: number;
  currentStatus: string;
  thoughtsLog: string[];
  agentLogs: Record<string, string[]>;
  selectedAgent: string | null;
  viewMode: "general" | "thoughts";
  sequence: StepResult[];
};

class LoopflowWidget implements Component {
  private state: TuiState;
  constructor(state: TuiState) {
    this.state = state;
  }
  render(width: number): string[] {
    const border = "─".repeat(width - 2);
    const stepStr = this.state.activeStep || "none";
    const agentStr = this.state.activeAgent || "none";
    const iterStr = this.state.activeIteration ? `Iteration: ${this.state.activeIteration}` : "none";
    
    const line1 = `Step: ${stepStr} | Agent: ${agentStr} | ${iterStr}`;
    const line2 = `Status: ${this.state.currentStatus}`;
    
    const cleanLine1 = line1.replace(/\x1b\[[0-9;]*m/g, "");
    const cleanLine2 = line2.replace(/\x1b\[[0-9;]*m/g, "");
    
    const lines = [
      `┌── Loopflow Status: ${this.state.workflowName} ` + "─".repeat(Math.max(0, width - 23 - this.state.workflowName.length)) + "┐",
      `│ Step: \x1b[32m${stepStr}\x1b[0m | Agent: \x1b[36m${agentStr}\x1b[0m | ${iterStr}` + " ".repeat(Math.max(0, width - 4 - cleanLine1.length)) + " │",
      `│ Status: \x1b[35m${this.state.currentStatus}\x1b[0m` + " ".repeat(Math.max(0, width - 4 - cleanLine2.length)) + " │",
      `└` + border + "┘"
    ];
    return lines;
  }
  invalidate() {}
}

class LoopflowOverlay implements Component {
  private state: TuiState;
  private onClose: () => void;
  private selectedAgentIndex: number = 0;
  private scrollTop: number = 0;
  
  constructor(state: TuiState, onClose: () => void) {
    this.state = state;
    this.onClose = onClose;
  }

  private ansiWordWrap(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let currentLine = "";
    let currentCleanLength = 0;
    let activeStyles: string[] = [];
    
    let i = 0;
    while (i < text.length) {
      if (text[i] === "\x1b" && text[i + 1] === "[") {
        let j = i + 2;
        while (j < text.length && text[j] !== "m") {
          j++;
        }
        if (j < text.length) {
          const sequence = text.slice(i, j + 1);
          currentLine += sequence;
          if (sequence === "\x1b[0m") {
            activeStyles = [];
          } else {
            activeStyles.push(sequence);
          }
          i = j + 1;
          continue;
        }
      }
      
      const char = text[i];
      if (char === "\n") {
        lines.push(currentLine + "\x1b[0m");
        currentLine = activeStyles.join("");
        currentCleanLength = 0;
      } else {
        currentLine += char;
        currentCleanLength++;
        
        if (currentCleanLength >= maxWidth) {
          lines.push(currentLine + "\x1b[0m");
          currentLine = activeStyles.join("");
          currentCleanLength = 0;
        }
      }
      i++;
    }
    
    if (currentCleanLength > 0 || currentLine.replace(/\x1b\[[0-9;]*m/g, "").length > 0) {
      lines.push(currentLine + "\x1b[0m");
    }
    
    return lines.length > 0 ? lines : [""];
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const border = "─".repeat(width - 2);
    
    // Title
    lines.push(`┌${border}┐`);
    const titleText = `Loopflow Live: ${this.state.workflowName}`;
    const cleanTitle = titleText.replace(/\x1b\[[0-9;]*m/g, "");
    lines.push(`│ \x1b[1m\x1b[33m${titleText}\x1b[0m` + " ".repeat(Math.max(0, width - 4 - cleanTitle.length)) + " │");
    lines.push(`├${border}┤`);

    // Active details
    const stepStr = this.state.activeStep || "none";
    const agentStr = this.state.activeAgent || "none";
    const iterStr = this.state.activeIteration ? `Iteration: ${this.state.activeIteration}` : "none";
    const detailText = `Step: ${stepStr} | Agent: ${agentStr} | ${iterStr}`;
    const cleanDetail = detailText.replace(/\x1b\[[0-9;]*m/g, "");
    lines.push(`│ Step: \x1b[32m${stepStr}\x1b[0m | Agent: \x1b[36m${agentStr}\x1b[0m | ${iterStr}` + " ".repeat(Math.max(0, width - 4 - cleanDetail.length)) + " │");
    
    const statusText = `Status: ${this.state.currentStatus}`;
    const cleanStatus = statusText.replace(/\x1b\[[0-9;]*m/g, "");
    lines.push(`│ Status: \x1b[35m${this.state.currentStatus}\x1b[0m` + " ".repeat(Math.max(0, width - 4 - cleanStatus.length)) + " │");
    lines.push(`├${border}┤`);

    // Tab Header
    const isGen = this.state.viewMode === "general";
    const tab1 = isGen ? "\x1b[7m [1] GENERAL MAP \x1b[27m" : " [1] GENERAL MAP ";
    const tab2 = !isGen ? "\x1b[7m [2] AGENT THOUGHTS \x1b[27m" : " [2] AGENT THOUGHTS ";
    const tabsUnstyled = " [1] GENERAL MAP  [2] AGENT THOUGHTS ";
    lines.push(`│ ${tab1}${tab2}` + " ".repeat(Math.max(0, width - 4 - tabsUnstyled.length)) + " │");
    lines.push(`├${border}┤`);

    // Content area
    const contentWidth = width - 4;
    const maxLines = 14;
    
    if (this.state.viewMode === "general") {
      const mapLines: string[] = [];
      mapLines.push("\x1b[1m=== Workflow Steps & Statuses ===\x1b[0m");
      this.state.sequence.forEach((res, idx) => {
        const iterSuffix = res.iteration ? `#${res.iteration}` : "";
        const statusSuffix = res.status ? ` -> \x1b[33m${res.status}\x1b[0m` : "";
        const exitColor = res.exitCode === 0 ? "\x1b[32m" : "\x1b[31m";
        mapLines.push(`${idx + 1}. ${res.id}${iterSuffix} (${res.agent}) - ${exitColor}exit ${res.exitCode}\x1b[0m${statusSuffix}`);
      });
      
      while (mapLines.length < maxLines) {
        mapLines.push("");
      }
      
      mapLines.slice(0, maxLines).forEach(ln => {
        const plainLength = ln.replace(/\x1b\[[0-9;]*m/g, "").length;
        lines.push(`│ ${ln}` + " ".repeat(Math.max(0, contentWidth - plainLength)) + " │");
      });
    } else {
      // Thoughts mode
      if (this.state.selectedAgent === null) {
        // Select agent mode
        const mapLines: string[] = [];
        mapLines.push("\x1b[1m=== Select Agent to View Thoughts ===\x1b[0m");
        
        // Find unique agents that have run
        const uniqueAgents = ["global", ...new Set(this.state.sequence.map(s => s.agent).filter(Boolean))];
        
        uniqueAgents.forEach((agent, idx) => {
          const isSelected = idx === this.selectedAgentIndex;
          const indicator = isSelected ? "\x1b[33m► " : "  ";
          const highlight = isSelected ? "\x1b[7m" : "";
          const reset = isSelected ? "\x1b[27m\x1b[0m" : "";
          const logCount = agent === "global" ? this.state.thoughtsLog.length : (this.state.agentLogs[agent]?.length ?? 0);
          mapLines.push(`${indicator}${highlight}${agent} (${logCount} events)${reset}`);
        });

        // Save total unique agents for input handling
        (this as any)._uniqueAgentsCount = uniqueAgents.length;
        (this as any)._uniqueAgentsList = uniqueAgents;

        while (mapLines.length < maxLines) {
          mapLines.push("");
        }
        
        mapLines.slice(0, maxLines).forEach(ln => {
          const plainLength = ln.replace(/\x1b\[[0-9;]*m/g, "").length;
          lines.push(`│ ${ln}` + " ".repeat(Math.max(0, contentWidth - plainLength)) + " │");
        });
      } else {
        // View thoughts of selected agent mode
        const agentName = this.state.selectedAgent;
        const rawLogs = agentName === "global" ? this.state.thoughtsLog : (this.state.agentLogs[agentName] ?? []);
        
        // Wrap all lines beautifully to the content width
        const wrappedLogs: string[] = [];
        rawLogs.forEach(log => {
          wrappedLogs.push(...this.ansiWordWrap(log, contentWidth));
        });

        // Limit scrolling to valid range
        const maxScroll = Math.max(0, wrappedLogs.length - maxLines);
        if (this.scrollTop > maxScroll) this.scrollTop = maxScroll;

        const visibleLogs = wrappedLogs.slice(this.scrollTop, this.scrollTop + maxLines);
        
        while (visibleLogs.length < maxLines) {
          visibleLogs.push("");
        }

        const titleHeader = `=== Thoughts of ${agentName} (Scroll: ${this.scrollTop}/${maxScroll}) ===`;
        const cleanHeader = titleHeader.replace(/\x1b\[[0-9;]*m/g, "").length;
        lines.push(`│ \x1b[1m${titleHeader}\x1b[0m` + " ".repeat(Math.max(0, contentWidth - cleanHeader)) + " │");
        
        visibleLogs.slice(0, maxLines).forEach(ln => {
          const plainLength = ln.replace(/\x1b\[[0-9;]*m/g, "").length;
          lines.push(`│ ${ln}` + " ".repeat(Math.max(0, contentWidth - plainLength)) + " │");
        });
      }
    }

    lines.push(`├${border}┤`);
    let footerText = "";
    if (this.state.viewMode === "general") {
      footerText = "Press [Tab] for Thoughts | [Esc/q] to Close Panel";
    } else if (this.state.selectedAgent === null) {
      footerText = "Press [↑/↓] Navigate | [Enter] Select | [Tab] Map";
    } else {
      footerText = "Press [↑/↓] Scroll | [b/Esc] Back to List | [Tab] Map";
    }
    lines.push(`│ \x1b[2m${footerText}\x1b[0m` + " ".repeat(Math.max(0, width - 4 - footerText.length)) + " │");
    lines.push(`└${border}┘`);

    return lines;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.escape)) {
      if (this.state.viewMode === "thoughts" && this.state.selectedAgent !== null) {
        this.state.selectedAgent = null;
      } else {
        this.onClose();
      }
    } else if (matchesKey(data, "q")) {
      this.onClose();
    } else if (matchesKey(data, "b")) {
      if (this.state.viewMode === "thoughts" && this.state.selectedAgent !== null) {
        this.state.selectedAgent = null;
      }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, "1") || matchesKey(data, "2")) {
      this.state.viewMode = this.state.viewMode === "general" ? "thoughts" : "general";
    } else if (this.state.viewMode === "thoughts") {
      if (this.state.selectedAgent === null) {
        const count = (this as any)._uniqueAgentsCount ?? 0;
        const list = (this as any)._uniqueAgentsList ?? [];
        if (matchesKey(data, Key.up)) {
          this.selectedAgentIndex = Math.max(0, this.selectedAgentIndex - 1);
        } else if (matchesKey(data, Key.down)) {
          this.selectedAgentIndex = Math.min(count - 1, this.selectedAgentIndex + 1);
        } else if (matchesKey(data, Key.enter)) {
          if (list[this.selectedAgentIndex]) {
            this.state.selectedAgent = list[this.selectedAgentIndex];
            this.scrollTop = 9999; // Scroll to bottom initially
          }
        }
      } else {
        // Scroll thoughts
        if (matchesKey(data, Key.up)) {
          this.scrollTop = Math.max(0, this.scrollTop - 1);
        } else if (matchesKey(data, Key.down)) {
          this.scrollTop = this.scrollTop + 1;
        }
      }
    }
  }

  invalidate() {}
}

type GateDef = {
  type?: "json-status";
  passStatuses?: string[];
  retryStatuses?: string[];
  stopStatuses?: string[];
};

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseFrontmatter(md: string): { data: Record<string, any>; body: string } {
  if (!md.startsWith("---\n")) return { data: {}, body: md };
  const end = md.indexOf("\n---", 4);
  if (end < 0) return { data: {}, body: md };
  const raw = md.slice(4, end).trim();
  const body = md.slice(end + 4).replace(/^\n/, "");
  const data: Record<string, any> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value: any = m[2].trim();
    if (value === "") value = undefined;
    if (typeof value === "string" && value.includes(",")) {
      value = value.split(",").map((s) => s.trim()).filter(Boolean);
    }
    data[key] = value;
  }
  return { data, body };
}

function agentDirs(cwd: string, scope: "user" | "project" | "both"): string[] {
  const dirs: string[] = [];
  const add = (p: string) => { if (fs.existsSync(p)) dirs.push(p); };
  const pkg = path.join(getAgentDir(), "npm/node_modules/pi-subagents/agents");
  add(pkg);
  if (scope === "user" || scope === "both") add(path.join(getAgentDir(), "agents"));
  if (scope === "project" || scope === "both") {
    add(path.join(cwd, ".pi/agents"));
    add(path.join(cwd, ".agents"));
  }
  return dirs;
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMd(p));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function discoverAgents(cwd: string, scope: "user" | "project" | "both"): Map<string, AgentDef> {
  const map = new Map<string, AgentDef>();
  // Load lower priority first; later dirs override.
  for (const dir of agentDirs(cwd, scope)) {
    for (const file of walkMd(dir)) {
      const md = fs.readFileSync(file, "utf8");
      const { data, body } = parseFrontmatter(md);
      const name = typeof data.name === "string" ? data.name : path.basename(file, ".md");
      const pkg = typeof data.package === "string" ? data.package : undefined;
      const runtime = pkg ? `${pkg}.${name}` : name;
      const tools = Array.isArray(data.tools) ? data.tools : typeof data.tools === "string" ? data.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      map.set(runtime, {
        name: runtime,
        description: data.description,
        systemPrompt: body,
        model: typeof data.model === "string" ? data.model : undefined,
        tools,
        source: file,
      });
      if (!pkg) map.set(name, map.get(runtime)!);
    }
  }
  return map;
}

function workflowDirs(cwd: string): string[] {
  return [
    path.join(PACKAGE_ROOT, "loopflows"),
    path.join(getAgentDir(), "loopflows"),
    path.join(cwd, ".pi/loopflows"),
  ].filter((p) => fs.existsSync(p));
}

function discoverWorkflows(cwd: string): Map<string, { file: string; workflow: WorkflowDef }> {
  const map = new Map<string, { file: string; workflow: WorkflowDef }>();
  for (const dir of workflowDirs(cwd)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".loopflow.json"))) {
      const full = path.join(dir, file);
      const wf = readJsonFile<WorkflowDef>(full);
      if (wf?.name && Array.isArray(wf.steps)) map.set(wf.name, { file: full, workflow: wf });
    }
  }
  return map;
}

function renderTemplate(template: string, ctx: RunContext, iteration?: number): string {
  return template.replace(/\{([^}]+)\}/g, (_m, keyRaw) => {
    const key = String(keyRaw).trim();
    if (key === "task") return ctx.task;
    if (key === "artifactsDir") return ctx.artifactsDir;
    if (key === "previous") return ctx.sequence.at(-1)?.output ?? "";
    if (key === "loop.iteration") return String(iteration ?? "");
    if (key === "loop.observations") return String(ctx.params.observations ?? "");
    if (key === "loop.reflections") return String(ctx.params.reflections ?? "");
    if (key.startsWith("params.")) return String(ctx.params[key.slice(7)] ?? "");
    if (key.startsWith("outputs.")) {
      const rest = key.slice(8);
      const [id, prop] = rest.split(".");
      const res = ctx.outputs[id];
      if (!res) return "";
      if (!prop || prop === "output") return res.output;
      if (prop === "status") return String(res.status ?? "");
      if (prop === "json") return JSON.stringify(res.json ?? null, null, 2);
      return String((res as any)[prop] ?? res.json?.[prop] ?? "");
    }
    return "";
  });
}

function extractJson(text: string): any | undefined {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

function finalAssistantTextFromJsonLines(stdout: string): string {
  let final = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message;
    if (ev.type === "message_end" && msg?.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text") final = part.text;
      }
    }
  }
  return final;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript) && !currentScript.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writePrompt(agentName: string, prompt: string) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-loopflows-"));
  const file = path.join(dir, `prompt-${safeName(agentName)}.md`);
  await withFileMutationQueue(file, async () => fs.promises.writeFile(file, prompt, { mode: 0o600 }));
  return { dir, file };
}

interface ExecutorAdapter {
  runAgent(agent: string, task: string, options: { cwd: string; signal?: AbortSignal; model?: string; tools?: string[]; scope: "user" | "project" | "both"; overrideSystemPrompt?: string; onAgentEvent?: (event: any) => void }): Promise<{ output: string; exitCode: number; stderr: string }>;
}

class PiSubprocessAdapter implements ExecutorAdapter {
  async runAgent(agentName: string, task: string, options: { cwd: string; signal?: AbortSignal; model?: string; tools?: string[]; scope: "user" | "project" | "both"; overrideSystemPrompt?: string; onAgentEvent?: (event: any) => void }) {
    const agents = discoverAgents(options.cwd, options.scope);
    const agent = agents.get(agentName);
    if (!agent && !options.overrideSystemPrompt) {
      return { output: "", exitCode: 1, stderr: `Unknown agent ${agentName}. Available: ${[...agents.keys()].sort().join(", ")}` };
    }
    const args = ["--mode", "json", "-p", "--no-session"];
    const model = options.model ?? agent?.model;
    const tools = options.tools ?? agent?.tools;
    if (model) args.push("--model", model);
    if (tools?.length) args.push("--tools", tools.join(","));
    
    const systemPrompt = options.overrideSystemPrompt ?? agent?.systemPrompt ?? "";
    const tmp = systemPrompt.trim() ? await writePrompt(agentName, systemPrompt) : undefined;
    if (tmp) args.push("--append-system-prompt", tmp.file);
    args.push(task);

    const invocation = getPiInvocation(args);
    let stdout = "";
    let stderr = "";
    
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      
      let buffer = "";
      proc.stdout.on("data", (d) => {
        const chunk = d.toString();
        stdout += chunk;
        buffer += chunk;
        
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (options.onAgentEvent) {
              options.onAgentEvent(ev);
            }
          } catch {
            // Incomplete line, keep buffering
          }
        }
      });
      
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => resolve(code ?? 0));
      proc.on("error", (err) => { stderr += String(err?.message ?? err); resolve(1); });
      if (options.signal) {
        const kill = () => { proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 3000); };
        if (options.signal.aborted) kill();
        else options.signal.addEventListener("abort", kill, { once: true });
      }
    });
    if (tmp) {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
    return { output: finalAssistantTextFromJsonLines(stdout) || stdout.trim(), exitCode, stderr };
  }
}

async function saveArtifact(ctx: RunContext, name: string, content: string): Promise<string> {
  const file = path.join(ctx.artifactsDir, name);
  await ensureDir(path.dirname(file));
  await fs.promises.writeFile(file, content, "utf8");
  return file;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

async function queryAgentMemory(task: string, cwd: string): Promise<string> {
  const agentmemoryUrl = process.env.AGENTMEMORY_URL || "http://127.0.0.1:3111";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);
    const response = await fetch(`${agentmemoryUrl}/agentmemory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: task, limit: 5 }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) return "";
    const data = await response.json() as any;
    if (!Array.isArray(data?.results) || data.results.length === 0) return "";
    return [
      "<relevant_project_memory>",
      ...data.results.slice(0, 5).map((r: any) => {
        const obs = r.observation ?? {};
        const title = obs.title || obs.subtitle || "Memory";
        const body = obs.narrative || obs.text || JSON.stringify(obs);
        return `- [${obs.timestamp || "Recall"}] ${title}: ${body}`;
      }),
      "</relevant_project_memory>\n\n"
    ].join("\n");
  } catch {
    return "";
  }
}

function parseObserverOutput(output: string) {
  let observations = "";
  let currentTask = "";
  let suggestedAction = "";

  const obsIndex = output.indexOf("### Observations");
  const taskIndex = output.indexOf("### Current Task");
  const nextIndex = output.indexOf("### Suggested Next Action");

  if (obsIndex >= 0) {
    const end = taskIndex >= 0 ? taskIndex : (nextIndex >= 0 ? nextIndex : output.length);
    observations = output.slice(obsIndex + "### Observations".length, end).trim();
  } else {
    // If no heading is found, try to find any list or use the whole text
    observations = output;
  }
  
  if (taskIndex >= 0) {
    const end = nextIndex >= 0 ? nextIndex : output.length;
    currentTask = output.slice(taskIndex + "### Current Task".length, end).trim();
  }
  
  if (nextIndex >= 0) {
    suggestedAction = output.slice(nextIndex + "### Suggested Next Action".length).trim();
  }

  return {
    observations: observations || output,
    currentTask: currentTask || "Continuing loopflow execution.",
    suggestedNextAction: suggestedAction || "Proceed to the next planned step."
  };
}

async function runStep(def: StepDef, ctx: RunContext, adapter: ExecutorAdapter, scope: "user" | "project" | "both", signal: AbortSignal | undefined, iteration?: number, onAgentEvent?: (event: any) => void): Promise<StepResult> {
  let task = renderTemplate(def.task, ctx, iteration);
  
  // Auto-inject agentmemory context (CLI-first via API)
  const memoryContext = await queryAgentMemory(task, ctx.cwd);
  if (memoryContext) {
    task = memoryContext + task;
  }

  const run = await adapter.runAgent(def.agent, task, { cwd: ctx.cwd, signal, model: def.model, tools: def.tools, scope, onAgentEvent });
  const json = def.gate ? extractJson(run.output) : undefined;
  const status = json?.status;
  const artifactName = def.output ? renderTemplate(def.output, ctx, iteration) : `${safeName(def.id)}${iteration ? `-${iteration}` : ""}.${def.gate ? "json" : "md"}`;
  const artifactPath = await saveArtifact(ctx, artifactName, def.gate ? JSON.stringify(json ?? { parse_error: true, raw: run.output }, null, 2) : run.output);
  const result: StepResult = { id: def.id, agent: def.agent, iteration, output: run.output, json, status, artifactPath, exitCode: run.exitCode, stderr: run.stderr };
  ctx.outputs[def.id] = result;
  ctx.outputs[iteration ? `${def.id}_${iteration}` : def.id] = result;
  ctx.sequence.push(result);
  return result;
}

function statusIn(status: GateStatus | undefined, values: string[] | undefined, fallback: string[]) {
  return !!status && (values ?? fallback).includes(status);
}

async function runOMCompression(
  loop: LoopDef,
  ctx: RunContext,
  adapter: ExecutorAdapter,
  scope: "user" | "project" | "both",
  signal: AbortSignal | undefined,
  currentIteration: number,
  tuiState?: TuiState,
  triggerRender?: () => void
) {
  const compressAfter = loop.memory?.compressAfterIterations ?? 2;
  const lastObservedIndex = ctx.params.lastObservedIndex ?? 0;
  const unobservedSteps = ctx.sequence.slice(lastObservedIndex);
  
  const debugLines: string[] = [
    `currentIteration: ${currentIteration}`,
    `compressAfter: ${compressAfter}`,
    `lastObservedIndex: ${lastObservedIndex}`,
    `unobservedSteps count: ${unobservedSteps.length}`
  ];

  if (unobservedSteps.length === 0) {
    debugLines.push("No unobserved steps. Returning early.");
    await saveArtifact(ctx, `om-debug-${currentIteration}.txt`, debugLines.join("\n"));
    return;
  }

  const unobservedIterations = new Set(unobservedSteps.map(s => s.iteration).filter(Boolean));
  const completedIterations = unobservedIterations.size;
  const unobservedTokens = unobservedSteps.reduce((sum, s) => sum + estimateTokens(s.output), 0);
  const tokenThreshold = loop.memory?.messageTokensThreshold ?? 10000;

  debugLines.push(`completedIterations: ${completedIterations}`);
  debugLines.push(`unobservedTokens: ${unobservedTokens}`);
  debugLines.push(`tokenThreshold: ${tokenThreshold}`);

  const trigger = completedIterations >= compressAfter || unobservedTokens >= tokenThreshold;
  debugLines.push(`trigger: ${trigger}`);

  if (trigger) {
    const observerAgent = loop.memory?.observerAgent ?? "planner";
    debugLines.push(`observerAgent: ${observerAgent}`);
    
    if (tuiState) {
      tuiState.activeStep = "OM Observer";
      tuiState.activeAgent = observerAgent;
      tuiState.currentStatus = "Compressing past iterations' raw logs...";
      tuiState.thoughtsLog.push("[Observer] Compression triggered due to limit.");
      triggerRender?.();
    }

    const rawLogToObserve = unobservedSteps.map(step => {
      return `### Step: ${step.id} (Iteration: ${step.iteration ?? "none"}, Agent: ${step.agent})
Exit Code: ${step.exitCode}
Status: ${step.status ?? "none"}
Output:
${step.output}
`;
    }).join("\n---\n\n");

    const previousObservations = ctx.params.observations ?? "No previous observations.";

    const observerTask = `Original Task:
${ctx.task}

Previous Observation Log:
${previousObservations}

Raw Execution Log of Recent Steps to Observe:
${rawLogToObserve}

Analyze these raw execution outputs and update the observation log. Output your response strictly matching the specified format.`;

    const observerSystemPrompt = `You are an Execution Observer. Your task is to analyze the raw execution outputs of the recent workflow steps and append new, concise chronological observations to the existing observation log.

=== CONCISE GUIDELINES ===
- Be specific: "Step 'build' failed with ReferenceError: x is not defined" not "Step failed" (too vague).
- Use terse language: write dense sentences without unnecessary filler words to save tokens.
- Do not repeat observations that have already been captured in the log.
- When steps execute commands or tools, observe what was executed, why, and what was learned.
- Include exact line numbers, paths, or return statuses when observing file changes or command execution.

=== OUTPUT FORMAT ===
Your response must strictly follow this format:

### Observations
- [Iteration X] Step Y: <Observation 1>
- [Iteration X] Step Y: <Observation 2>

### Current Task
<A concise single-sentence summary of the active objective or roadblock being addressed.>

### Suggested Next Action
<A single-sentence instruction for what the next step/agent should focus on.>`;

    try {
      debugLines.push("Invoking runAgent on observer...");
      const observerRun = await adapter.runAgent(observerAgent, observerTask, {
        cwd: ctx.cwd,
        signal,
        overrideSystemPrompt: observerSystemPrompt,
        scope
      });

      debugLines.push(`Observer exitCode: ${observerRun.exitCode}`);
      debugLines.push(`Observer output: ${observerRun.output.slice(0, 200)}...`);

      if (observerRun.exitCode === 0) {
        const parsed = parseObserverOutput(observerRun.output);
        const existingObs = ctx.params.observations ? ctx.params.observations + "\n" : "";
        ctx.params.observations = existingObs + parsed.observations;
        ctx.params.currentTask = parsed.currentTask;
        ctx.params.suggestedNextAction = parsed.suggestedNextAction;
        
        debugLines.push(`Parsed observations count: ${estimateTokens(parsed.observations)} tokens`);
        
        if (tuiState) {
          tuiState.thoughtsLog.push("[Observer] Compression completed successfully.");
          triggerRender?.();
        }

        // Context Swapping: Prune observed steps' outputs to save tokens
        for (const step of unobservedSteps) {
          step.output = `[Archived in loop.observations]`;
          if (step.json) {
            step.json = { archived: true, status: step.status };
          }
        }
        
        ctx.params.lastObservedIndex = ctx.sequence.length;
        await saveArtifact(ctx, `om-observations-${currentIteration}.md`, `### Updated Observations\n${ctx.params.observations}\n\n### Current Task\n${ctx.params.currentTask}\n\n### Suggested Next Action\n${ctx.params.suggestedNextAction}`);
      } else {
        debugLines.push(`Observer failed. Stderr: ${observerRun.stderr}`);
        const fallbackObs = `\n- [Iteration ${currentIteration - 1}] Fallback: Steps completed without Observer compression.`;
        ctx.params.observations = (ctx.params.observations ?? "") + fallbackObs;
        ctx.params.lastObservedIndex = ctx.sequence.length;
      }
    } catch (err: any) {
      debugLines.push(`Observer exception: ${err?.message || err}`);
      const fallbackObs = `\n- [Iteration ${currentIteration - 1}] Fallback: Steps completed without Observer compression.`;
      ctx.params.observations = (ctx.params.observations ?? "") + fallbackObs;
      ctx.params.lastObservedIndex = ctx.sequence.length;
    }

    // Check Reflector threshold
    const observationTokens = estimateTokens(ctx.params.observations ?? "");
    const reflectionThreshold = loop.memory?.observationTokensThreshold ?? 15000;
    debugLines.push(`observationTokens: ${observationTokens}`);
    debugLines.push(`reflectionThreshold: ${reflectionThreshold}`);
    
    if (observationTokens >= reflectionThreshold) {
      debugLines.push("Triggering Reflector...");
      const reflectorSystemPrompt = `You are an Execution Reflector. Your task is to consolidate and compress a long, redundant log of workflow observations into a high-level summary of reflections, patterns, and current progress.

=== GUIDELINES ===
- Merge repetitive, circular, or redundant steps into a single, high-level summary statement.
- Identify persistent patterns, systemic roadblocks, or key lessons learned across the entire execution history.
- Clearly state the definitive current progress relative to the ultimate goal.
- Output only dense, high-impact bullet points. Do not add conversational framing or filler words.

=== OUTPUT FORMAT ===
### Consolidated Reflections
- <Reflection 1>
- <Reflection 2>

### Systemic Roadblocks & Lessons
- <Roadblock/Lesson 1>

### Current Goals Status
- <Status 1>`;

      const reflectorTask = `Original Task:
${ctx.task}

Observation Log to Consolidate:
${ctx.params.observations}

Compress and reflect on these observations strictly matching the specified format.`;

      const reflectorAgentName = loop.memory?.reflectorAgent ?? loop.memory?.observerAgent ?? "planner";
      
      if (tuiState) {
        tuiState.activeStep = "OM Reflector";
        tuiState.activeAgent = reflectorAgentName;
        tuiState.currentStatus = "Consolidating observations into reflections...";
        tuiState.thoughtsLog.push("[Reflector] Reflection triggered due to threshold.");
        triggerRender?.();
      }

      try {
        const reflectorRun = await adapter.runAgent(reflectorAgentName, reflectorTask, {
          cwd: ctx.cwd,
          signal,
          overrideSystemPrompt: reflectorSystemPrompt,
          scope
        });

        debugLines.push(`Reflector exitCode: ${reflectorRun.exitCode}`);

        if (reflectorRun.exitCode === 0) {
          ctx.params.reflections = reflectorRun.output;
          ctx.params.observations = "Consolidated into reflections.\n\n" + (ctx.params.observations.slice(-4000));
          
          if (tuiState) {
            tuiState.thoughtsLog.push("[Reflector] Reflection completed successfully.");
            triggerRender?.();
          }

          await saveArtifact(ctx, `om-reflections-${currentIteration}.md`, ctx.params.reflections);
        } else {
          debugLines.push(`Reflector failed. Stderr: ${reflectorRun.stderr}`);
        }
      } catch (err: any) {
        debugLines.push(`Reflector exception: ${err?.message || err}`);
      }
    }
  }

  await saveArtifact(ctx, `om-debug-${currentIteration}.txt`, debugLines.join("\n"));
}

async function runLoop(loop: LoopDef, ctx: RunContext, adapter: ExecutorAdapter, scope: "user" | "project" | "both", signal: AbortSignal | undefined, tuiState?: TuiState, triggerRender?: () => void): Promise<StepResult> {
  await saveArtifact(ctx, `loop-debug.json`, JSON.stringify(loop, null, 2));
  const max = Math.max(1, loop.maxIterations);
  let lastGate: StepResult | undefined;
  for (let i = 1; i <= max; i++) {
    // Run Observational Memory compression if enabled
    if (i > 1 && loop.memory?.observational) {
      await runOMCompression(loop, ctx, adapter, scope, signal, i, tuiState, triggerRender);
    }

    await saveArtifact(ctx, `${safeName(loop.id)}/iteration-${i}.txt`, `Starting iteration ${i}/${max}\n`);
    for (const step of loop.body) {
      if (tuiState) {
        tuiState.activeStep = step.id;
        tuiState.activeAgent = step.agent;
        tuiState.activeIteration = i;
        tuiState.currentStatus = `Running agent ${step.agent}...`;
        tuiState.sequence = [...ctx.sequence];
        tuiState.thoughtsLog.push(`[Workflow] Starting step: ${step.id} (Iteration: ${i})`);
        triggerRender?.();
      }

      const stepWithGate = step.id === loop.gateStep && !step.gate ? { ...step, gate: { type: "json-status" as const } } : step;
      
      const onAgentEvent = (ev: any) => {
        if (!tuiState) return;
        const agentName = step.agent;
        if (!tuiState.agentLogs[agentName]) tuiState.agentLogs[agentName] = [];
        
        if (ev.type === "thinking" && ev.text) {
          tuiState.thoughtsLog.push(`\x1b[2m[Thinking] ${ev.text}\x1b[0m`);
          tuiState.agentLogs[agentName].push(`\x1b[2m[Thinking] ${ev.text}\x1b[0m`);
          tuiState.currentStatus = `Thinking...`;
          triggerRender?.();
        } else if (ev.type === "tool_call" && ev.toolCall) {
          const inputStr = ev.toolCall.input ? JSON.stringify(ev.toolCall.input) : "";
          const logStr = `\x1b[33m[Tool Call] ${ev.toolCall.name}(${inputStr})\x1b[0m`;
          tuiState.thoughtsLog.push(logStr);
          tuiState.agentLogs[agentName].push(logStr);
          tuiState.currentStatus = `Calling tool: ${ev.toolCall.name}`;
          triggerRender?.();
        } else if (ev.type === "tool_result" && ev.toolCall) {
          let resStr = "";
          if (ev.result) {
            if (typeof ev.result === "string") resStr = ev.result;
            else if (ev.result.content && Array.isArray(ev.result.content)) {
              resStr = ev.result.content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
            } else {
              resStr = JSON.stringify(ev.result);
            }
          }
          if (resStr.length > 500) resStr = resStr.slice(0, 500) + "... [truncated]";
          const logStr = `\x1b[32m[Tool Result] ${ev.toolCall.name} -> ${resStr}\x1b[0m`;
          tuiState.thoughtsLog.push(logStr);
          tuiState.agentLogs[agentName].push(logStr);
          triggerRender?.();
        } else if (ev.type === "message_update" && ev.message?.content) {
          const content = ev.message.content;
          let text = "";
          if (Array.isArray(content)) {
            text = content.map((c: any) => c.type === "text" ? c.text : "").join("");
          } else if (typeof content === "string") {
            text = content;
          }
          if (text.trim()) {
            const logStr = `\x1b[36m[Response] ${text}\x1b[0m`;
            const logs = tuiState.agentLogs[agentName];
            const thoughts = tuiState.thoughtsLog;
            
            const lastLog = logs[logs.length - 1];
            if (lastLog && lastLog.startsWith("\x1b[36m[Response]")) {
              logs[logs.length - 1] = logStr;
            } else {
              logs.push(logStr);
            }
            
            const lastThought = thoughts[thoughts.length - 1];
            if (lastThought && lastThought.startsWith("\x1b[36m[Response]")) {
              thoughts[thoughts.length - 1] = logStr;
            } else {
              thoughts.push(logStr);
            }
            
            tuiState.currentStatus = `Responding...`;
            triggerRender?.();
          }
        }
      };

      const result = await runStep(stepWithGate, ctx, adapter, scope, signal, i, onAgentEvent);
      if (step.id === loop.gateStep) lastGate = result;
      
      if (tuiState) {
        tuiState.sequence = [...ctx.sequence];
        tuiState.thoughtsLog.push(`[Workflow] Completed step: ${step.id} (Exit Code: ${result.exitCode})`);
        triggerRender?.();
      }

      if (result.exitCode !== 0) return result;
    }
    const status = lastGate?.status;
    if (statusIn(status, loop.passStatuses, ["approved", "complete"])) return lastGate!;
    if (statusIn(status, loop.stopStatuses, ["blocked"])) return lastGate!;
    if (!statusIn(status, loop.retryStatuses, ["changes_requested", "incomplete"])) return lastGate!;
  }
  if (lastGate) {
    lastGate.status = `exhausted:${lastGate.status ?? "unknown"}`;
    await saveArtifact(ctx, `${safeName(loop.id)}/exhausted.json`, JSON.stringify(lastGate.json ?? { status: lastGate.status }, null, 2));
  }
  return lastGate ?? { id: loop.id, agent: "loop", output: "Loop had no gate result", exitCode: 1 };
}

let activeTuiState: TuiState | undefined = undefined;
let activeUiHandle: any = undefined;
let activeExtensionCtx: any = undefined;

async function runWorkflow(workflow: WorkflowDef, task: string, opts: { cwd: string; signal?: AbortSignal; params?: Record<string, any>; maxIterations?: number; extensionCtx?: any }) {
  const adapter = new PiSubprocessAdapter();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(workflow.name)}`;
  const artifactsDir = path.join(opts.cwd, ".pi/loopflows/runs", runId);
  await ensureDir(artifactsDir);
  const ctx: RunContext = { cwd: opts.cwd, task, artifactsDir, outputs: {}, sequence: [], params: opts.params ?? {} };
  const scope = workflow.defaults?.agentScope ?? "both";

  await saveArtifact(ctx, "workflow.json", JSON.stringify(workflow, null, 2));
  await saveArtifact(ctx, "task.md", task);

  const tuiState: TuiState | undefined = opts.extensionCtx ? {
    workflowName: workflow.name,
    task,
    activeAgent: "",
    activeStep: "",
    activeIteration: 0,
    currentStatus: "Starting workflow...",
    thoughtsLog: ["[Workflow] Initialized."],
    agentLogs: {},
    selectedAgent: null,
    viewMode: "general",
    sequence: []
  } : undefined;

  activeTuiState = tuiState;
  activeExtensionCtx = opts.extensionCtx;

  let uiHandle: any = undefined;
  const updateWidget = () => {
    if (!opts.extensionCtx || !tuiState) return;
    try {
      opts.extensionCtx.ui.setWidget("loopflow-status", (tui: any, theme: any) => {
        return new LoopflowWidget(tuiState);
      });
    } catch {
      // Ignore
    }
  };

  const triggerRender = () => {
    uiHandle?.requestRender?.();
    activeUiHandle?.requestRender?.();
    updateWidget();
  };

  if (opts.extensionCtx && tuiState) {
    try {
      updateWidget();
      uiHandle = opts.extensionCtx.ui.custom((tui: any, theme: any, keybindings: any, done: any) => {
        return new LoopflowOverlay(tuiState, () => {
          done();
          uiHandle = undefined;
          activeUiHandle = undefined;
        });
      }, {
        overlay: true,
        overlayOptions: {
          width: "95%",
          anchor: "center",
          margin: 1
        },
        onHandle: (h: any) => {
          uiHandle = h;
          activeUiHandle = h;
        }
      });
    } catch {
      // Ignore if not in interactive mode
    }
  }

  for (const node of workflow.steps) {
    if ("loop" in node) {
      const loop = { ...node.loop };
      if (opts.maxIterations) loop.maxIterations = opts.maxIterations;
      const result = await runLoop(loop, ctx, adapter, scope, opts.signal, tuiState, triggerRender);
      if (result.exitCode !== 0 || String(result.status ?? "").startsWith("exhausted") || statusIn(result.status, loop.stopStatuses, ["blocked"])) break;
    } else {
      if (tuiState) {
        tuiState.activeStep = node.id;
        tuiState.activeAgent = node.agent;
        tuiState.activeIteration = 0;
        tuiState.currentStatus = `Running agent ${node.agent}...`;
        tuiState.thoughtsLog.push(`[Workflow] Starting step: ${node.id}`);
        triggerRender();
      }

      const onAgentEvent = (ev: any) => {
        if (!tuiState) return;
        const agentName = node.agent;
        if (!tuiState.agentLogs[agentName]) tuiState.agentLogs[agentName] = [];
        
        if (ev.type === "thinking" && ev.text) {
          tuiState.thoughtsLog.push(`[Thinking] ${ev.text}`);
          tuiState.agentLogs[agentName].push(`[Thinking] ${ev.text}`);
          tuiState.currentStatus = `Thinking...`;
          triggerRender();
        } else if (ev.type === "tool_call" && ev.toolCall) {
          tuiState.thoughtsLog.push(`[Tool Call] ${ev.toolCall.name}`);
          tuiState.agentLogs[agentName].push(`[Tool Call] ${ev.toolCall.name}`);
          tuiState.currentStatus = `Calling tool: ${ev.toolCall.name}`;
          triggerRender();
        } else if (ev.type === "tool_result" && ev.toolCall) {
          tuiState.thoughtsLog.push(`[Tool Result] ${ev.toolCall.name} completed.`);
          tuiState.agentLogs[agentName].push(`[Tool Result] ${ev.toolCall.name} completed.`);
          triggerRender();
        }
      };

      const result = await runStep(node, ctx, adapter, scope, opts.signal, undefined, onAgentEvent);
      
      if (tuiState) {
        tuiState.sequence = [...ctx.sequence];
        tuiState.thoughtsLog.push(`[Workflow] Completed step: ${node.id} (Exit Code: ${result.exitCode})`);
        triggerRender();
      }

      if (result.exitCode !== 0) break;
      if (node.gate && statusIn(result.status, node.gate.stopStatuses, ["blocked", "incomplete"])) break;
    }
  }

  if (opts.extensionCtx) {
    try {
      opts.extensionCtx.ui.setWidget("loopflow-status", undefined);
      uiHandle?.close?.();
      activeUiHandle?.close?.();
    } catch {
      // Ignore
    }
  }

  activeTuiState = undefined;
  activeUiHandle = undefined;

  const summary = [
    `# Loopflow run: ${workflow.name}`,
    ``,
    `Task: ${task}`,
    `Artifacts: ${artifactsDir}`,
    ``,
    `## Steps`,
    ...ctx.sequence.map((r, idx) => `${idx + 1}. ${r.id}${r.iteration ? `#${r.iteration}` : ""} (${r.agent}) - exit ${r.exitCode}${r.status ? ` - status ${r.status}` : ""}${r.artifactPath ? ` - ${path.relative(opts.cwd, r.artifactPath)}` : ""}`),
  ].join("\n");
  const summaryPath = await saveArtifact(ctx, "summary.md", summary);
  return { artifactsDir, summaryPath, results: ctx.sequence, summary };
}

const RunParams = Type.Object({
  workflow: Type.String({ description: "Loopflow name, e.g. launch-control" }),
  task: Type.String({ description: "Task/spec/plan for the loopflow" }),
  maxIterations: Type.Optional(Type.Number({ description: "Override max iterations for loops" })),
  params: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "loopflow_run",
    label: "Loopflow Run",
    description: "Run a deterministic loopflow: subagent steps, gates, loops, artifacts, and max-iteration feedback cycles.",
    parameters: RunParams,
    promptSnippet: "Run deterministic subagent loop workflows with gates and feedback loops.",
    promptGuidelines: ["Use loopflow_run when the user asks to run a loopflow, launch-control workflow, or builder/reviewer feedback loop."],
    async execute(_id, params, signal, onUpdate, ctx) {
      const workflows = discoverWorkflows(ctx.cwd);
      const found = workflows.get(params.workflow);
      if (!found) {
        return { content: [{ type: "text", text: `Unknown loopflow ${params.workflow}. Available: ${[...workflows.keys()].join(", ") || "none"}` }], details: {}, isError: true };
      }
      onUpdate?.({ content: [{ type: "text", text: `Running loopflow ${params.workflow}...` }], details: {} });
      const result = await runWorkflow(found.workflow, params.task, { cwd: ctx.cwd, signal, params: params.params, maxIterations: params.maxIterations, extensionCtx: ctx });
      return { content: [{ type: "text", text: result.summary }], details: result };
    },
  });

  pi.registerCommand("loopflow-list", {
    description: "List available loopflows",
    handler: async (_args, ctx) => {
      const workflows = discoverWorkflows(ctx.cwd);
      const lines = [...workflows.values()].map(({ file, workflow }) => `- ${workflow.name}: ${workflow.description ?? ""}\n  ${file}`);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No loopflows found", "info");
    },
  });

  pi.registerCommand("loopflow-monitor", {
    description: "Reopen the active loopflow monitor panel",
    handler: async (_args, ctx) => {
      if (!activeTuiState) {
        ctx.ui.notify("No active loopflow is currently running.", "error");
        return;
      }
      if (activeUiHandle) {
        // Bring to front
        activeUiHandle.focus?.();
        return;
      }
      try {
        activeUiHandle = ctx.ui.custom((tui: any, theme: any, keybindings: any, done: any) => {
          return new LoopflowOverlay(activeTuiState!, () => {
            done();
            activeUiHandle = undefined;
          });
        }, {
          overlay: true,
          overlayOptions: {
            width: "95%",
            anchor: "center",
            margin: 1
          },
          onHandle: (h: any) => {
            activeUiHandle = h;
          }
        });
      } catch {
        ctx.ui.notify("Failed to reopen monitor panel.", "error");
      }
    },
  });

  pi.registerShortcut("ctrl+shift+l", {
    description: "Toggle Loopflow Monitor Panel",
    handler: async (ctx) => {
      await ctx.ui.pasteToEditor("/loopflow-monitor\n");
    }
  });

  pi.registerCommand("loopflow", {
    description: "Run a loopflow: /loopflow <name> -- <task>",
    handler: async (args, ctx) => {
      const [namePart, ...rest] = args.split(/\s+--\s+/);
      const name = namePart.trim().split(/\s+/)[0];
      const task = rest.join(" -- ").trim() || namePart.trim().replace(/^\S+\s*/, "");
      if (!name || !task) {
        ctx.ui.notify("Usage: /loopflow <name> -- <task>", "error");
        return;
      }
      await ctx.waitForIdle();
      const workflows = discoverWorkflows(ctx.cwd);
      const found = workflows.get(name);
      if (!found) {
        ctx.ui.notify(`Unknown loopflow ${name}. Available: ${[...workflows.keys()].join(", ") || "none"}`, "error");
        return;
      }
      ctx.ui.notify(`Running loopflow ${name}`, "info");
      const result = await runWorkflow(found.workflow, task, { cwd: ctx.cwd, extensionCtx: ctx });
      pi.sendMessage({ customType: "loopflow-result", content: result.summary, display: true, details: result }, { triggerTurn: false });
    },
  });
}
