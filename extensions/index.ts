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

type RunState = "running" | "pausing" | "paused" | "resuming" | "terminating" | "terminated" | "failed" | "completed";

type ResumeCursor = {
  workflowIndex: number;
  loopId?: string;
  loopIteration?: number;
  loopBodyIndex?: number;
};

type ActiveRun = {
  id: string;
  workflow: WorkflowDef;
  task: string;
  cwd: string;
  scope: "user" | "project" | "both";
  state: RunState;
  ctx: RunContext;
  maxIterations?: number;
  extensionCtx?: any;
  tuiState?: TuiState;
  triggerRender?: () => void;
  currentProc?: ReturnType<typeof spawn>;
  currentAgent?: string;
  currentStep?: string;
  checkpoint?: ResumeCursor;
  terminalReason?: string;
};

class LoopflowPauseError extends Error {
  constructor(message = "Loopflow paused") {
    super(message);
    this.name = "LoopflowPauseError";
  }
}

class LoopflowTerminateError extends Error {
  constructor(message = "Loopflow terminated") {
    super(message);
    this.name = "LoopflowTerminateError";
  }
}

type TuiState = {
  workflowName: string;
  task: string;
  activeAgent: string;
  activeStep: string;
  activeIteration: number;
  currentStatus: string;
  thoughtsLog: string[];
  agentLogs: Record<string, string[]>;
  liveLogIndexes?: Record<string, { global: number; agent: number }>;
  selectedAgent: string | null;
  viewMode: "general" | "thoughts";
  sequence: StepResult[];
};

class LoopflowWidget implements Component {
  private state: TuiState;
  constructor(state: TuiState) {
    this.state = state;
  }
  
  private truncateAnsi(text: string, maxWidth: number): string {
    let result = "";
    let cleanLength = 0;
    let activeStyles: string[] = [];
    let i = 0;
    while (i < text.length && cleanLength < maxWidth) {
      if (text[i] === "\x1b" && text[i + 1] === "[") {
        let j = i + 2;
        while (j < text.length && text[j] !== "m") {
          j++;
        }
        if (j < text.length) {
          const sequence = text.slice(i, j + 1);
          result += sequence;
          if (sequence === "\x1b[0m") activeStyles = [];
          else activeStyles.push(sequence);
          i = j + 1;
          continue;
        }
      }
      result += text[i];
      cleanLength++;
      i++;
    }
    if (cleanLength >= maxWidth) {
      result += "\x1b[0m";
    }
    return result;
  }

  render(width: number): string[] {
    const stepStr = this.state.activeStep || "none";
    const agentStr = this.state.activeAgent || "none";
    const iterStr = this.state.activeIteration ? `Iteration: ${this.state.activeIteration}` : "none";
    
    const titleText = `● Loopflow Status: ${this.state.workflowName}`;
    const cleanTitle = titleText.replace(/\x1b\[[0-9;]*m/g, "");
    const dashCount = Math.max(0, width - 6 - cleanTitle.length);
    const headerLine = `\x1b[2m───\x1b[0m \x1b[1m\x1b[33m●\x1b[0m \x1b[1mLoopflow Status: ${this.state.workflowName}\x1b[0m \x1b[2m` + "─".repeat(dashCount) + "\x1b[0m";
    
    const detailText = `  Step: \x1b[32m${stepStr}\x1b[0m | Agent: \x1b[36m${agentStr}\x1b[0m | ${iterStr}  |  \x1b[2m${this.state.currentStatus}\x1b[0m`;
    const cleanDetail = detailText.replace(/\x1b\[[0-9;]*m/g, "");
    const detailLine = detailText + " ".repeat(Math.max(0, width - cleanDetail.length));
    
    return [
      this.truncateAnsi(headerLine, width),
      this.truncateAnsi(detailLine, width)
    ];
  }
  invalidate() {}
}

class LoopflowOverlay implements Component {
  private state: TuiState;
  private onClose: () => void;
  private extensionCtx?: any;
  private selectedAgentIndex: number = 0;
  private scrollTop: number = 0;
  private autoFollow: boolean = true;
  private lastDownAt: number = 0;
  
  constructor(state: TuiState, onClose: () => void, extensionCtx?: any) {
    this.state = state;
    this.onClose = onClose;
    this.extensionCtx = extensionCtx;
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
        
        // Find unique agents that have run or are currently running
        const activeAgentList = this.state.activeAgent ? [this.state.activeAgent] : [];
        const uniqueAgents = ["global", ...new Set(this.state.sequence.map(s => s.agent).concat(activeAgentList).filter(Boolean))];
        
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

        // Limit scrolling to valid range and magnet-follow live stream when enabled.
        const maxScroll = Math.max(0, wrappedLogs.length - maxLines);
        if (this.autoFollow) this.scrollTop = maxScroll;
        if (this.scrollTop > maxScroll) this.scrollTop = maxScroll;
        if (this.scrollTop < 0) this.scrollTop = 0;

        const visibleLogs = wrappedLogs.slice(this.scrollTop, this.scrollTop + maxLines);
        
        while (visibleLogs.length < maxLines) {
          visibleLogs.push("");
        }

        const followBadge = this.autoFollow ? " | follow:on" : " | follow:off";
        const titleHeader = `=== Thoughts of ${agentName} (Scroll: ${this.scrollTop}/${maxScroll}${followBadge}) ===`;
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
      footerText = "Press [→] for Thoughts | [Esc/q] to Close Panel";
    } else if (this.state.selectedAgent === null) {
      footerText = "Press [↑/↓] Navigate | [←] Map | [Enter] Select | [Esc/q] Close";
    } else {
      footerText = "[↑] pause+scroll | double [↓] bottom | [p] pause [r] resume [x] terminate [m] msg";
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
    } else if (matchesKey(data, "p")) {
      const ok = requestPauseActiveRun("Paused from loopflow overlay");
      this.extensionCtx?.ui?.notify?.(ok ? "Loopflow pause requested." : "No running loopflow to pause.", ok ? "info" : "error");
    } else if (matchesKey(data, "r")) {
      void resumePausedRun(this.extensionCtx);
    } else if (matchesKey(data, "x")) {
      const ok = requestTerminateActiveRun("Terminated from loopflow overlay");
      this.extensionCtx?.ui?.notify?.(ok ? "Loopflow terminate requested." : "No active loopflow to terminate.", ok ? "warning" : "error");
    } else if (matchesKey(data, "m")) {
      const agent = this.state.selectedAgent && this.state.selectedAgent !== "global" ? this.state.selectedAgent : (this.state.activeAgent || "worker");
      void (async () => {
        const text = await this.extensionCtx?.ui?.input?.(`Message ${agent}:`, "tweak/instruction");
        if (text?.trim()) {
          const ok = queueAgentMessage(agent, text.trim(), "overlay");
          this.extensionCtx?.ui?.notify?.(ok ? `Queued message for ${agent}` : "No active/paused loopflow.", ok ? "info" : "error");
        }
      })();
    } else if (matchesKey(data, "b")) {
      if (this.state.viewMode === "thoughts" && this.state.selectedAgent !== null) {
        this.state.selectedAgent = null;
      }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, "1")) {
      this.state.viewMode = "general";
    } else if (matchesKey(data, "2")) {
      this.state.viewMode = "thoughts";
    } else if (matchesKey(data, Key.right)) {
      if (this.state.viewMode === "general") {
        this.state.viewMode = "thoughts";
      }
    } else if (matchesKey(data, Key.left)) {
      if (this.state.viewMode === "thoughts") {
        if (this.state.selectedAgent !== null) {
          this.state.selectedAgent = null;
        } else {
          this.state.viewMode = "general";
        }
      }
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
            this.autoFollow = true;
            this.scrollTop = 9999; // Scroll to bottom initially
          }
        }
      } else {
        // Scroll thoughts
        if (matchesKey(data, Key.up)) {
          this.autoFollow = false;
          this.scrollTop = Math.max(0, this.scrollTop - 1);
        } else if (matchesKey(data, Key.down)) {
          const now = Date.now();
          if (now - this.lastDownAt < 350) {
            this.autoFollow = true;
            this.scrollTop = 999999;
          } else {
            this.scrollTop = this.scrollTop + 1;
          }
          this.lastDownAt = now;
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

function stringifyToolPayload(value: any, max = 700): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}... [truncated]` : text;
}

function maybeAppendSpacer(lines: string[]) {
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
}

function appendTuiEventLog(tuiState: TuiState, agentName: string, logStr: string, triggerRender?: () => void, status?: string, block = true) {
  if (!tuiState.agentLogs[agentName]) tuiState.agentLogs[agentName] = [];
  if (block) {
    maybeAppendSpacer(tuiState.thoughtsLog);
    maybeAppendSpacer(tuiState.agentLogs[agentName]);
  }
  tuiState.thoughtsLog.push(logStr);
  tuiState.agentLogs[agentName].push(logStr);
  if (status) tuiState.currentStatus = status;
  triggerRender?.();
}

function updateTuiLiveLog(tuiState: TuiState, agentName: string, key: string, logStr: string, triggerRender?: () => void, status?: string) {
  if (!tuiState.agentLogs[agentName]) tuiState.agentLogs[agentName] = [];
  if (!tuiState.liveLogIndexes) tuiState.liveLogIndexes = {};
  const liveKey = `${agentName}:${key}`;
  const existing = tuiState.liveLogIndexes[liveKey];
  if (existing && tuiState.thoughtsLog[existing.global] !== undefined && tuiState.agentLogs[agentName][existing.agent] !== undefined) {
    tuiState.thoughtsLog[existing.global] = logStr;
    tuiState.agentLogs[agentName][existing.agent] = logStr;
  } else {
    maybeAppendSpacer(tuiState.thoughtsLog);
    maybeAppendSpacer(tuiState.agentLogs[agentName]);
    tuiState.thoughtsLog.push(logStr);
    tuiState.agentLogs[agentName].push(logStr);
    tuiState.liveLogIndexes[liveKey] = {
      global: tuiState.thoughtsLog.length - 1,
      agent: tuiState.agentLogs[agentName].length - 1
    };
  }
  if (status) tuiState.currentStatus = status;
  triggerRender?.();
}

function clearTuiLiveLog(tuiState: TuiState, agentName: string, key: string) {
  delete tuiState.liveLogIndexes?.[`${agentName}:${key}`];
}

function handleAgentEventForTui(tuiState: TuiState | undefined, agentName: string, ev: any, triggerRender?: () => void) {
  if (!tuiState) return;

  if (ev.type === "thinking" && ev.text) {
    updateTuiLiveLog(tuiState, agentName, "thinking", `\x1b[2m[Thinking] ${ev.text}\x1b[0m`, triggerRender, "Thinking...");
    return;
  }
  if (ev.type === "tool_call" && ev.toolCall) {
    clearTuiLiveLog(tuiState, agentName, "thinking");
    appendTuiEventLog(tuiState, agentName, `\x1b[33m[Tool Call] ${ev.toolCall.name}(${stringifyToolPayload(ev.toolCall.input)})\x1b[0m`, triggerRender, `Calling tool: ${ev.toolCall.name}`, true);
    return;
  }
  if (ev.type === "tool_result" && ev.toolCall) {
    appendTuiEventLog(tuiState, agentName, `\x1b[32m[Tool Result] ${ev.toolCall.name} -> ${stringifyToolPayload(ev.result, 500)}\x1b[0m`, triggerRender, undefined, true);
    return;
  }
  if (ev.type === "tool_execution_start") {
    const name = ev.toolName || "tool";
    clearTuiLiveLog(tuiState, agentName, "thinking");
    clearTuiLiveLog(tuiState, agentName, "response");
    appendTuiEventLog(tuiState, agentName, `\x1b[33m[Tool Start] ${name}(${stringifyToolPayload(ev.args)})\x1b[0m`, triggerRender, `Calling tool: ${name}`, true);
    return;
  }
  if (ev.type === "tool_execution_update") {
    const name = ev.toolName || "tool";
    updateTuiLiveLog(tuiState, agentName, `tool:${name}:update`, `\x1b[33m[Tool Update] ${name}: ${stringifyToolPayload(ev.update ?? ev.result ?? ev, 500)}\x1b[0m`, triggerRender, `Running tool: ${name}`);
    return;
  }
  if (ev.type === "tool_execution_end") {
    const name = ev.toolName || "tool";
    const isError = ev.result?.isError === true || ev.isError === true;
    const prefix = isError ? "\x1b[31m[Tool Error]" : "\x1b[32m[Tool End]";
    clearTuiLiveLog(tuiState, agentName, `tool:${name}:update`);
    appendTuiEventLog(tuiState, agentName, `${prefix} ${name} -> ${stringifyToolPayload(ev.result, 700)}\x1b[0m`, triggerRender, undefined, true);
    return;
  }
  if (ev.type === "tool_result_end") {
    const msg = ev.message;
    const content = Array.isArray(msg?.content) ? msg.content.map((c: any) => c?.text || JSON.stringify(c)).join("\n") : msg?.content;
    appendTuiEventLog(tuiState, agentName, `\x1b[32m[Tool Result] ${stringifyToolPayload(content, 700)}\x1b[0m`, triggerRender, undefined, true);
    return;
  }

  const msg = ev.message;
  if (!msg) return;

  for (const part of msg.content ?? []) {
    if (part?.type === "thinking") {
      const summaries = Array.isArray(part.summary) ? part.summary.map((s: any) => s?.text).filter(Boolean).join("\n") : "";
      const text = part.text || part.thinking || summaries;
      if (text?.trim()) {
        const line = `\x1b[2m[Thinking] ${stringifyToolPayload(text, 900)}\x1b[0m`;
        if (ev.type === "message_update") updateTuiLiveLog(tuiState, agentName, "thinking", line, triggerRender, "Thinking...");
        else {
          updateTuiLiveLog(tuiState, agentName, "thinking", line, triggerRender, "Thinking...");
          clearTuiLiveLog(tuiState, agentName, "thinking");
        }
      }
    } else if ((part?.type === "toolCall" || part?.toolCall) && ev.type !== "message_update") {
      const call = part.toolCall ?? part;
      const name = call.name || call.toolName || "tool";
      const args = call.arguments ?? call.input;
      clearTuiLiveLog(tuiState, agentName, "thinking");
      appendTuiEventLog(tuiState, agentName, `\x1b[33m[Tool Call] ${name}(${stringifyToolPayload(args)})\x1b[0m`, triggerRender, `Calling tool: ${name}`, true);
    } else if (part?.type === "text") {
      const text = part.text || "";
      if (text.trim()) {
        const line = `\x1b[36m[Response] ${stringifyToolPayload(text, 1000)}\x1b[0m`;
        if (ev.type === "message_update") updateTuiLiveLog(tuiState, agentName, "response", line, triggerRender, "Responding...");
        else {
          updateTuiLiveLog(tuiState, agentName, "response", line, triggerRender, "Responding...");
          clearTuiLiveLog(tuiState, agentName, "response");
        }
      }
    }
  }

  if (ev.type === "message_update") return;

  for (const result of msg.toolResults ?? []) {
    const name = result.toolName || result.name || "tool";
    const content = Array.isArray(result.content) ? result.content.map((c: any) => c?.text || JSON.stringify(c)).join("\n") : result.content;
    const prefix = result.isError ? "\x1b[31m[Tool Error]" : "\x1b[32m[Tool Result]";
    appendTuiEventLog(tuiState, agentName, `${prefix} ${name} -> ${stringifyToolPayload(content, 500)}\x1b[0m`, triggerRender, undefined, true);
  }

  if (msg.stopReason === "error" || msg.errorMessage) {
    appendTuiEventLog(tuiState, agentName, `\x1b[31m[Provider Error] ${msg.errorMessage || "Provider returned an error"}\x1b[0m`, triggerRender, "Provider error", true);
  }
}

function truncateForError(text: string | undefined, max = 6000): string {
  const value = text ?? "";
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${value.slice(0, head)}\n\n...[truncated ${value.length - max} chars]...\n\n${value.slice(-tail)}`;
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

function summarizeProviderDiagnostics(msg: any): string {
  const diagnostics = Array.isArray(msg?.diagnostics) ? msg.diagnostics : [];
  const summaries = diagnostics.slice(0, 3).map((d: any) => {
    const type = d?.type ? `${d.type}: ` : "";
    const error = d?.error?.message || d?.message || "";
    const phase = d?.details?.phase ? ` (phase: ${d.details.phase})` : "";
    const requestBytes = d?.details?.requestBytes ? ` (requestBytes: ${d.details.requestBytes})` : "";
    return `${type}${error}${phase}${requestBytes}`.trim();
  }).filter(Boolean);
  return summaries.join("; ");
}

function parsePiJsonLines(stdout: string): { finalText: string; providerError?: string; hadAssistantMessage: boolean } {
  let finalText = "";
  let providerError: string | undefined;
  let hadAssistantMessage = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev.message;
    if (ev.type === "message_end" && msg?.role === "assistant") {
      hadAssistantMessage = true;
      if (msg.stopReason === "error" || msg.errorMessage) {
        const details = summarizeProviderDiagnostics(msg);
        providerError = [msg.errorMessage || "Provider returned an error", details].filter(Boolean).join(". Diagnostics: ");
      }
      for (const part of msg.content ?? []) {
        if (part.type === "text") finalText = part.text;
      }
    }
  }

  return { finalText, providerError, hadAssistantMessage };
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
    let finalText = "";
    let providerError: string | undefined;
    let hadAssistantMessage = false;
    const retainedStdoutLimit = 250_000;
    const appendRetainedStdout = (line: string) => {
      if (stdout.length >= retainedStdoutLimit) return;
      const remaining = retainedStdoutLimit - stdout.length;
      stdout += `${line}\n`.slice(0, remaining);
    };
    
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      if (activeRun) activeRun.currentProc = proc;
      
      let buffer = "";
      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;
        try {
          const ev = JSON.parse(line);
          options.onAgentEvent?.(ev);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            hadAssistantMessage = true;
            const msg = ev.message;
            if (msg.stopReason === "error" || msg.errorMessage) {
              const details = summarizeProviderDiagnostics(msg);
              providerError = [msg.errorMessage || "Provider returned an error", details].filter(Boolean).join(". Diagnostics: ");
            }
            for (const part of msg.content ?? []) {
              if (part?.type === "text" && typeof part.text === "string") finalText = part.text;
            }
          }
          // Streaming deltas/partial tool output can be extremely large/noisy. Keep them live-only.
          if (ev.type !== "message_update" && ev.type !== "tool_execution_update") appendRetainedStdout(line);
        } catch {
          appendRetainedStdout(line);
        }
      };
      proc.stdout.on("data", (d) => {
        buffer += d.toString();
        
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          processLine(line);
        }
      });
      
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        if (activeRun?.currentProc === proc) activeRun.currentProc = undefined;
        if (activeRun?.state === "pausing") resolve(-20);
        else if (activeRun?.state === "terminating") resolve(-21);
        else resolve(code ?? 0);
      });
      proc.on("error", (err) => {
        if (activeRun?.currentProc === proc) activeRun.currentProc = undefined;
        stderr += String(err?.message ?? err);
        resolve(activeRun?.state === "terminating" ? -21 : activeRun?.state === "pausing" ? -20 : 1);
      });
      if (options.signal) {
        const kill = () => { proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 3000); };
        if (options.signal.aborted) kill();
        else options.signal.addEventListener("abort", kill, { once: true });
      }
    });
    if (tmp) {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    }

    if (providerError) {
      return {
        output: finalText || stdout.trim(),
        exitCode: exitCode === 0 ? 1 : exitCode,
        stderr: [stderr.trim(), `Provider error from agent '${agentName}': ${providerError}`].filter(Boolean).join("\n")
      };
    }

    if (exitCode === 0 && hadAssistantMessage && !finalText.trim()) {
      return {
        output: stdout.trim(),
        exitCode: 1,
        stderr: [stderr.trim(), `Agent '${agentName}' completed with an empty assistant response.`].filter(Boolean).join("\n")
      };
    }

    return { output: finalText || (exitCode === 0 ? stdout.trim() : truncateForError(stdout, 12000)), exitCode, stderr };
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
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${agentmemoryUrl}/agentmemory/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: task, limit: 5 }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`agentmemory daemon returned status ${response.status}: ${response.statusText}`);
    }
    const data = await response.json() as any;
    if (!data || !Array.isArray(data.results)) {
      throw new Error("agentmemory search returned invalid response format");
    }
    if (data.results.length === 0) return "";
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
  } catch (err: any) {
    throw new Error(`Failed to query agentmemory: ${err?.message || err}. Ensure that the agentmemory daemon is running on ${agentmemoryUrl}. Start it in your terminal by running 'agentmemory'.`);
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function commandOutput(command: string, cwd: string): Promise<string> {
  return await new Promise((resolve) => {
    const proc = spawn("/bin/bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve((stdout || stderr || `exit ${code ?? 0}`).trim()));
    proc.on("error", (err) => resolve(String(err?.message ?? err)));
  });
}

function inferTargetPath(task: string, cwd: string): string | undefined {
  const cwdMatch = task.match(/\/Users\/[^\s,]+(?:\/[^\s,]+)*/);
  const folderMatch = task.match(/создай\s+папку\s+([^,\n]+?)(?:\s+где|\s+в\s+которой|$)/i);
  if (cwdMatch && folderMatch) return path.join(cwdMatch[0], folderMatch[1].trim());
  return cwdMatch?.[0] ?? cwd;
}

async function buildDeterministicContext(def: StepDef, ctx: RunContext, iteration?: number): Promise<StepResult> {
  const targetPath = inferTargetPath(ctx.task, ctx.cwd);
  const targetExists = targetPath ? fs.existsSync(targetPath) : false;
  const parentPath = targetPath ? path.dirname(targetPath) : ctx.cwd;
  const pythonVersion = await commandOutput("python3 --version", ctx.cwd);
  const uvVersion = await commandOutput("uv --version || true", ctx.cwd);
  const parentListing = fs.existsSync(parentPath)
    ? fs.readdirSync(parentPath).slice(0, 80).join("\n")
    : "<parent path does not exist>";
  const output = `# Launch-control execution context\n\n## Scope\n${ctx.task}\n\n## Target\n- cwd: ${ctx.cwd}\n- inferred target path: ${targetPath ?? "unknown"}\n- target exists: ${targetExists}\n- parent path: ${parentPath}\n\n## Environment\n- ${pythonVersion}\n- ${uvVersion}\n\n## Parent directory sample\n\`\`\`\n${parentListing}\n\`\`\`\n\n## Validation contract candidates\n- Python syntax check for app modules.\n- Backend tests with pytest.\n- FastAPI smoke test on an available localhost port.\n- Static frontend file presence check.\n\n## Constraints and stop conditions\n- Create/modify only the target project folder.\n- Do not scan unrelated projects, .pi, previous loopflow runs, node_modules, .venv, or caches.\n- Stop if required dependencies cannot be installed or local server cannot be validated after diagnostics.\n`;
  const artifactName = def.output ? renderTemplate(def.output, ctx, iteration) : `${safeName(def.id)}.md`;
  const artifactPath = await saveArtifact(ctx, artifactName, output);
  const result: StepResult = { id: def.id, agent: def.agent, iteration, output, artifactPath, exitCode: 0 };
  ctx.outputs[def.id] = result;
  ctx.outputs[iteration ? `${def.id}_${iteration}` : def.id] = result;
  ctx.sequence.push(result);
  return result;
}

async function runStep(def: StepDef, ctx: RunContext, adapter: ExecutorAdapter, scope: "user" | "project" | "both", signal: AbortSignal | undefined, iteration?: number, onAgentEvent?: (event: any) => void): Promise<StepResult> {
  if (def.agent === "builtin-context") return buildDeterministicContext(def, ctx, iteration);

  let task = renderTemplate(def.task, ctx, iteration);
  
  // Natively inject Observational Memory if active but not explicitly placed in template
  const hasObservationsPlaceholder = def.task.includes("{loop.observations}");
  if (!hasObservationsPlaceholder && ctx.params.observations) {
    task += `\n\n=== Loop Execution History (Observational Memory) ===\n${ctx.params.observations}`;
    if (ctx.params.reflections) {
      task += `\n\n=== High-Level Reflections ===\n${ctx.params.reflections}`;
    }
  }

  const messageBag = (ctx.params.agentMessages ?? {}) as Record<string, Array<{ message: string; source: string; ts: string }>>;
  ctx.params.agentMessages = messageBag;
  const pendingMessages = messageBag[def.agent] ?? [];
  if (pendingMessages.length > 0) {
    const liveInstructionBlock = `=== REQUIRED LIVE USER INSTRUCTIONS FOR AGENT '${def.agent}' ===\n${pendingMessages.map((m, i) => `${i + 1}. [${m.ts}] (${m.source}) ${m.message}`).join("\n")}\n\nYou MUST explicitly handle these live instructions in this step. If any instruction conflicts with safety, validation, or the workflow contract, do not ignore it; report the conflict explicitly in your final response.\n\n=== ORIGINAL STEP TASK ===\n`;
    task = liveInstructionBlock + task;
    messageBag[def.agent] = [];
  }

  // Auto-inject agentmemory context (CLI-first via API)
  const memoryContext = await queryAgentMemory(task, ctx.cwd);
  if (memoryContext) {
    task = memoryContext + task;
  }

  if (activeRun) {
    activeRun.currentAgent = def.agent;
    activeRun.currentStep = def.id;
  }
  const run = await adapter.runAgent(def.agent, task, { cwd: ctx.cwd, signal, model: def.model, tools: def.tools, scope, onAgentEvent });
  if (run.exitCode === -20) throw new LoopflowPauseError(`Paused before completing step '${def.id}' (${def.agent}).`);
  if (run.exitCode === -21) throw new LoopflowTerminateError(`Terminated during step '${def.id}' (${def.agent}).`);
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
      appendTuiEventLog(tuiState, observerAgent, "[Observer] Compression triggered due to limit.", triggerRender, "Compressing past iterations' raw logs...");
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
          appendTuiEventLog(tuiState, observerAgent, "[Observer] Compression completed successfully.", triggerRender);
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
        throw new Error(`Observer agent '${observerAgent}' failed with exit code ${observerRun.exitCode}. Stderr: ${observerRun.stderr}`);
      }
    } catch (err: any) {
      throw new Error(`Observational Memory Observer failed: ${err?.message || err}`);
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
        appendTuiEventLog(tuiState, reflectorAgentName, "[Reflector] Reflection triggered due to threshold.", triggerRender, "Consolidating observations into reflections...");
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
            appendTuiEventLog(tuiState, reflectorAgentName, "[Reflector] Reflection completed successfully.", triggerRender);
          }

          await saveArtifact(ctx, `om-reflections-${currentIteration}.md`, ctx.params.reflections);
        } else {
          throw new Error(`Reflector agent '${reflectorAgentName}' failed with exit code ${reflectorRun.exitCode}. Stderr: ${reflectorRun.stderr}`);
        }
      } catch (err: any) {
        throw new Error(`Observational Memory Reflector failed: ${err?.message || err}`);
      }
    }
  }

  await saveArtifact(ctx, `om-debug-${currentIteration}.txt`, debugLines.join("\n"));
}

async function runLoop(loop: LoopDef, ctx: RunContext, adapter: ExecutorAdapter, scope: "user" | "project" | "both", signal: AbortSignal | undefined, tuiState?: TuiState, triggerRender?: () => void, workflowIndex = 0, resume?: ResumeCursor): Promise<StepResult> {
  await saveArtifact(ctx, `loop-debug.json`, JSON.stringify(loop, null, 2));
  const max = Math.max(1, loop.maxIterations);
  let lastGate: StepResult | undefined;
  const startIteration = resume?.loopId === loop.id && resume.loopIteration ? resume.loopIteration : 1;
  for (let i = startIteration; i <= max; i++) {
    // Run Observational Memory compression by default (unless explicitly set to false)
    const isObservational = loop.memory?.observational !== false;
    if (i > 1 && isObservational) {
      await runOMCompression(loop, ctx, adapter, scope, signal, i, tuiState, triggerRender);
    }

    await saveArtifact(ctx, `${safeName(loop.id)}/iteration-${i}.txt`, `Starting iteration ${i}/${max}\n`);
    const startBodyIndex = resume?.loopId === loop.id && resume.loopIteration === i ? (resume.loopBodyIndex ?? 0) : 0;
    for (let stepIndex = startBodyIndex; stepIndex < loop.body.length; stepIndex++) {
      const step = loop.body[stepIndex];
      if (activeRun) {
        await saveCheckpoint(activeRun, { workflowIndex, loopId: loop.id, loopIteration: i, loopBodyIndex: stepIndex });
        if (activeRun.state === "paused" || activeRun.state === "pausing") throw new LoopflowPauseError(`Paused before step '${step.id}' (${step.agent}).`);
        if (activeRun.state === "terminated" || activeRun.state === "terminating") throw new LoopflowTerminateError(`Terminated before step '${step.id}' (${step.agent}).`);
      }
      if (tuiState) {
        tuiState.activeStep = step.id;
        tuiState.activeAgent = step.agent;
        tuiState.activeIteration = i;
        tuiState.currentStatus = `Running agent ${step.agent}...`;
        tuiState.sequence = [...ctx.sequence];
        if (!tuiState.agentLogs[step.agent]) tuiState.agentLogs[step.agent] = [];
        const startLog = `[Workflow] Starting step: ${step.id} (Iteration: ${i})`;
        appendTuiEventLog(tuiState, step.agent, startLog, triggerRender, `Running agent ${step.agent}...`);
      }

      const stepWithGate = step.id === loop.gateStep && !step.gate ? { ...step, gate: { type: "json-status" as const } } : step;
      
      const onAgentEvent = (ev: any) => {
        handleAgentEventForTui(tuiState, step.agent, ev, triggerRender);
      };

      const result = await runStep(stepWithGate, ctx, adapter, scope, signal, i, onAgentEvent);
      if (step.id === loop.gateStep) lastGate = result;
      
      if (tuiState) {
        tuiState.sequence = [...ctx.sequence];
        const completedLog = `[Workflow] Completed step: ${step.id} (Exit Code: ${result.exitCode})`;
        appendTuiEventLog(tuiState, step.agent, completedLog, triggerRender);
      }

      if (result.exitCode !== 0) return result;
    }
    const status = lastGate?.status;
    if (lastGate?.json?.parse_error || !status) {
      throw new Error(`Gate step '${loop.gateStep}' failed: could not parse a valid status from agent output.
Ensure your LLM API credentials are valid and the provider is online.
Raw Output:
${truncateForError(lastGate?.output)}
${lastGate?.stderr ? `\nStderr:\n${truncateForError(lastGate.stderr)}` : ""}`);
    }
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
let activeRun: ActiveRun | undefined = undefined;
let pausedRun: ActiveRun | undefined = undefined;

function activeRunStatus(): string {
  if (activeRun) return `${activeRun.workflow.name} [${activeRun.state}] step=${activeRun.currentStep || "none"} agent=${activeRun.currentAgent || "none"}`;
  if (pausedRun) return `${pausedRun.workflow.name} [paused] step=${pausedRun.currentStep || "none"} agent=${pausedRun.currentAgent || "none"}`;
  return "No active or paused loopflow.";
}

function setRunState(run: ActiveRun | undefined, state: RunState, status?: string) {
  if (!run) return;
  run.state = state;
  if (run.tuiState) {
    run.tuiState.currentStatus = status ?? state;
    run.triggerRender?.();
  }
}

async function saveCheckpoint(run: ActiveRun, cursor: ResumeCursor) {
  run.checkpoint = cursor;
  const checkpoint = {
    id: run.id,
    workflow: run.workflow.name,
    task: run.task,
    cwd: run.cwd,
    state: run.state,
    cursor,
    params: run.ctx.params,
    outputs: run.ctx.outputs,
    sequence: run.ctx.sequence,
    artifactsDir: run.ctx.artifactsDir,
    currentAgent: run.currentAgent,
    currentStep: run.currentStep,
    savedAt: new Date().toISOString()
  };
  await saveArtifact(run.ctx, "checkpoint.json", JSON.stringify(checkpoint, null, 2));
}

function requestPauseActiveRun(reason = "User requested pause") {
  if (!activeRun) return false;
  if (activeRun.state !== "running" && activeRun.state !== "resuming") return false;
  activeRun.terminalReason = reason;
  if (!activeRun.currentProc) {
    setRunState(activeRun, "paused", "Paused at checkpoint.");
    pausedRun = activeRun;
    void saveCheckpoint(activeRun, activeRun.checkpoint ?? { workflowIndex: 0 }).catch(() => {});
    return true;
  }
  setRunState(activeRun, "pausing", "Pausing after interrupt...");
  activeRun.currentProc.kill("SIGINT");
  setTimeout(() => {
    if (activeRun?.state === "pausing") activeRun.currentProc?.kill("SIGTERM");
  }, 3000).unref?.();
  return true;
}

function requestTerminateActiveRun(reason = "User requested terminate") {
  const run = activeRun ?? pausedRun;
  if (!run) return false;
  run.terminalReason = reason;
  setRunState(run, "terminating", "Terminating...");
  run.currentProc?.kill("SIGTERM");
  setTimeout(() => {
    if (run.state === "terminating") run.currentProc?.kill("SIGKILL");
  }, 3000).unref?.();
  if (!run.currentProc) {
    setRunState(run, "terminated", "Terminated.");
    if (pausedRun === run) pausedRun = undefined;
    if (activeRun === run) activeRun = undefined;
    if (activeTuiState === run.tuiState) activeTuiState = undefined;
  }
  return true;
}

function queueAgentMessage(agent: string, message: string, source = "user") {
  const run = activeRun ?? pausedRun;
  if (!run) return false;
  const key = "agentMessages";
  const bag = (run.ctx.params[key] ?? {}) as Record<string, Array<{ message: string; source: string; ts: string }>>;
  if (!Array.isArray(bag[agent])) bag[agent] = [];
  bag[agent].push({ message, source, ts: new Date().toISOString() });
  run.ctx.params[key] = bag;
  if (run.tuiState) {
    appendTuiEventLog(run.tuiState, agent, `\x1b[35m[User Message queued] ${message}\x1b[0m`, run.triggerRender, `Queued message for ${agent}`);
  }
  void saveCheckpoint(run, run.checkpoint ?? { workflowIndex: 0 }).catch(() => {});
  return true;
}

async function runWorkflow(workflow: WorkflowDef, task: string, opts: { cwd: string; signal?: AbortSignal; params?: Record<string, any>; maxIterations?: number; extensionCtx?: any; resumeRun?: ActiveRun }) {
  if (activeRun && activeRun !== opts.resumeRun) {
    throw new Error(`Another loopflow is already active: ${activeRunStatus()}`);
  }
  const adapter = new PiSubprocessAdapter();
  const runId = opts.resumeRun?.id ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(workflow.name)}`;
  const artifactsDir = opts.resumeRun?.ctx.artifactsDir ?? path.join(opts.cwd, ".pi/loopflows/runs", runId);
  await ensureDir(artifactsDir);
  const ctx: RunContext = opts.resumeRun?.ctx ?? { cwd: opts.cwd, task, artifactsDir, outputs: {}, sequence: [], params: opts.params ?? {} };
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
  const run: ActiveRun = opts.resumeRun ?? {
    id: runId,
    workflow,
    task,
    cwd: opts.cwd,
    scope,
    state: "running",
    ctx,
    maxIterations: opts.maxIterations,
    extensionCtx: opts.extensionCtx,
    tuiState,
  };
  run.workflow = workflow;
  run.task = task;
  run.cwd = opts.cwd;
  run.scope = scope;
  run.state = opts.resumeRun ? "resuming" : "running";
  run.extensionCtx = opts.extensionCtx;
  run.tuiState = tuiState;
  activeRun = run;

  let uiHandle: any = undefined;
  const updateWidget = () => {
    if (!opts.extensionCtx || !tuiState) return;
    try {
      opts.extensionCtx.ui.setWidget("loopflow-status", (tui: any, theme: any) => {
        return new LoopflowWidget(tuiState);
      }, { placement: "aboveEditor" });
    } catch {
      // Ignore
    }
  };

  const triggerRender = () => {
    uiHandle?.requestRender?.();
    activeUiHandle?.requestRender?.();
    updateWidget();
  };
  run.triggerRender = triggerRender;

  if (opts.extensionCtx && tuiState) {
    try {
      updateWidget();
      uiHandle = opts.extensionCtx.ui.custom((tui: any, theme: any, keybindings: any, done: any) => {
        return new LoopflowOverlay(tuiState, () => {
          done();
          uiHandle = undefined;
          activeUiHandle = undefined;
        }, opts.extensionCtx);
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

  const resumeCursor = opts.resumeRun?.checkpoint;
  const startWorkflowIndex = resumeCursor?.workflowIndex ?? 0;
  try {
  for (let workflowIndex = startWorkflowIndex; workflowIndex < workflow.steps.length; workflowIndex++) {
    const node = workflow.steps[workflowIndex];
    if (activeRun) {
      await saveCheckpoint(activeRun, { workflowIndex });
      if (activeRun.state === "paused" || activeRun.state === "pausing") throw new LoopflowPauseError("Paused at workflow checkpoint.");
      if (activeRun.state === "terminated" || activeRun.state === "terminating") throw new LoopflowTerminateError("Terminated at workflow checkpoint.");
    }
    if ("loop" in node) {
      const loop = { ...node.loop };
      if (opts.maxIterations) loop.maxIterations = opts.maxIterations;
      const result = await runLoop(loop, ctx, adapter, scope, opts.signal, tuiState, triggerRender, workflowIndex, resumeCursor);
      if (result.exitCode !== 0 || String(result.status ?? "").startsWith("exhausted") || statusIn(result.status, loop.stopStatuses, ["blocked"])) break;
    } else {
      if (activeRun) {
        await saveCheckpoint(activeRun, { workflowIndex });
        if (activeRun.state === "paused" || activeRun.state === "pausing") throw new LoopflowPauseError("Paused at workflow checkpoint.");
        if (activeRun.state === "terminated" || activeRun.state === "terminating") throw new LoopflowTerminateError("Terminated at workflow checkpoint.");
      }
      if (tuiState) {
        tuiState.activeStep = node.id;
        tuiState.activeAgent = node.agent;
        tuiState.activeIteration = 0;
        tuiState.currentStatus = `Running agent ${node.agent}...`;
        if (!tuiState.agentLogs[node.agent]) tuiState.agentLogs[node.agent] = [];
        const startLog = `[Workflow] Starting step: ${node.id}`;
        appendTuiEventLog(tuiState, node.agent, startLog, triggerRender, `Running agent ${node.agent}...`);
      }

      const onAgentEvent = (ev: any) => {
        handleAgentEventForTui(tuiState, node.agent, ev, triggerRender);
      };

      const result = await runStep(node, ctx, adapter, scope, opts.signal, undefined, onAgentEvent);
      
      if (tuiState) {
        tuiState.sequence = [...ctx.sequence];
        const completedLog = `[Workflow] Completed step: ${node.id} (Exit Code: ${result.exitCode})`;
        appendTuiEventLog(tuiState, node.agent, completedLog, triggerRender);
      }

      if (result.exitCode !== 0) {
        if (opts.extensionCtx) {
          opts.extensionCtx.ui.notify(`Step '${node.id}' failed with exit code ${result.exitCode}`, "error");
        }
        throw new Error(`Step '${node.id}' failed with exit code ${result.exitCode}. Stderr: ${truncateForError(result.stderr)}`);
      }
      
      if (node.gate) {
        if (result.json?.parse_error || !result.status) {
          throw new Error(`Gate step '${node.id}' failed: could not parse a valid status from agent output.
Ensure your LLM API credentials are valid and the provider is online.
Raw Output:
${truncateForError(result.output)}
${result.stderr ? `\nStderr:\n${truncateForError(result.stderr)}` : ""}`);
        }
        if (statusIn(result.status, node.gate.stopStatuses, ["blocked", "incomplete"])) break;
      }
    }
  }
  } catch (err: any) {
    if (err instanceof LoopflowPauseError) {
      if (activeRun) {
        setRunState(activeRun, "paused", err.message);
        pausedRun = activeRun;
        await saveCheckpoint(activeRun, activeRun.checkpoint ?? { workflowIndex: startWorkflowIndex });
      }
      opts.extensionCtx?.ui?.notify?.(`Loopflow paused: ${err.message}`, "info");
      throw err;
    }
    if (err instanceof LoopflowTerminateError) {
      if (activeRun) {
        setRunState(activeRun, "terminated", err.message);
        await saveArtifact(activeRun.ctx, "terminated.txt", `${new Date().toISOString()} ${err.message}\n${activeRun.terminalReason ?? ""}`);
      }
      pausedRun = undefined;
      throw err;
    }
    if (activeRun) setRunState(activeRun, "failed", err?.message || String(err));
    throw err;
  }

  if (activeRun) setRunState(activeRun, "completed", "Completed.");

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
  if (activeRun?.id === run.id) activeRun = undefined;

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

async function resumePausedRun(extensionCtx?: any, pi?: ExtensionAPI) {
  if (!pausedRun) {
    extensionCtx?.ui?.notify?.("No paused loopflow to resume.", "error");
    return false;
  }
  if (activeRun && activeRun !== pausedRun) {
    extensionCtx?.ui?.notify?.("Another loopflow is already running.", "error");
    return false;
  }
  const run = pausedRun;
  pausedRun = undefined;
  run.extensionCtx = extensionCtx ?? run.extensionCtx;
  setRunState(run, "resuming", "Resuming from checkpoint...");
  activeRun = run;
  runWorkflow(run.workflow, run.task, {
    cwd: run.cwd,
    params: run.ctx.params,
    maxIterations: run.maxIterations,
    extensionCtx: run.extensionCtx,
    resumeRun: run,
  }).then((result) => {
    run.extensionCtx?.ui?.notify?.("Loopflow resumed and completed.", "info");
    pi?.sendMessage?.({ customType: "loopflow-result", content: result.summary, display: true, details: result }, { triggerTurn: false });
  }).catch((err) => {
    if (err instanceof LoopflowPauseError) {
      run.extensionCtx?.ui?.notify?.("Loopflow paused again.", "info");
      return;
    }
    if (err instanceof LoopflowTerminateError) {
      run.extensionCtx?.ui?.notify?.("Loopflow terminated.", "warning");
      return;
    }
    run.extensionCtx?.ui?.notify?.(`Resumed loopflow failed: ${err?.message || err}`, "error");
  });
  extensionCtx?.ui?.notify?.("Loopflow resume started.", "info");
  return true;
}

const RunParams = Type.Object({
  workflow: Type.String({ description: "Loopflow name, e.g. launch-control" }),
  task: Type.String({ description: "Task/spec/plan for the loopflow" }),
  maxIterations: Type.Optional(Type.Number({ description: "Override max iterations for loops" })),
  params: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export default function (pi: ExtensionAPI) {
  pi.on("agent_start", (event, ctx) => {
    try {
      ctx.ui.setWidget("loopflow-status", undefined);
      setTimeout(() => {
        if (activeTuiState) {
          ctx.ui.setWidget("loopflow-status", (tui: any, theme: any) => {
            return new LoopflowWidget(activeTuiState!);
          });
        }
      }, 100);
    } catch {
      // Ignore
    }
  });

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
      try {
        const result = await runWorkflow(found.workflow, params.task, { cwd: ctx.cwd, signal, params: params.params, maxIterations: params.maxIterations, extensionCtx: ctx });
        return { content: [{ type: "text", text: result.summary }], details: result };
      } catch (err: any) {
        if (err instanceof LoopflowPauseError) {
          return { content: [{ type: "text", text: `Loopflow paused. Use /loopflow-resume to continue. Artifacts: ${pausedRun?.ctx.artifactsDir ?? "unknown"}` }], details: { paused: true, artifactsDir: pausedRun?.ctx.artifactsDir } };
        }
        if (err instanceof LoopflowTerminateError) {
          return { content: [{ type: "text", text: `Loopflow terminated.` }], details: { terminated: true }, isError: true };
        }
        throw err;
      }
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

  pi.registerCommand("loopflow-status", {
    description: "Show active/paused loopflow status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(activeRunStatus(), "info");
    },
  });

  pi.registerCommand("loopflow-pause", {
    description: "Pause the active loopflow at the current checkpoint",
    handler: async (_args, ctx) => {
      const ok = requestPauseActiveRun("Paused from /loopflow-pause");
      ctx.ui.notify(ok ? "Loopflow pause requested." : "No running loopflow to pause.", ok ? "info" : "error");
    },
  });

  pi.registerCommand("loopflow-resume", {
    description: "Resume the paused loopflow",
    handler: async (_args, ctx) => {
      await resumePausedRun(ctx, pi);
    },
  });

  pi.registerCommand("loopflow-terminate", {
    description: "Terminate the active or paused loopflow permanently",
    handler: async (_args, ctx) => {
      const ok = requestTerminateActiveRun("Terminated from /loopflow-terminate");
      ctx.ui.notify(ok ? "Loopflow terminate requested." : "No active or paused loopflow to terminate.", ok ? "warning" : "error");
    },
  });

  pi.registerCommand("loopflow-message", {
    description: "Queue a live instruction for a loopflow agent: /loopflow-message <agent> -- <text>",
    handler: async (args, ctx) => {
      const [agentPart, ...rest] = args.split(/\s+--\s+/);
      const agent = agentPart.trim().split(/\s+/)[0];
      const message = rest.join(" -- ").trim() || agentPart.trim().replace(/^\S+\s*/, "");
      if (!agent || !message) {
        ctx.ui.notify("Usage: /loopflow-message <agent> -- <message>", "error");
        return;
      }
      const ok = queueAgentMessage(agent, message, "slash");
      ctx.ui.notify(ok ? `Queued message for ${agent}. Pause/resume if you need the active agent to consume it immediately.` : "No active or paused loopflow.", ok ? "info" : "error");
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
          }, ctx);
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
      ctx.ui.notify(`Running loopflow ${name} in background`, "info");
      
      // Run asynchronously in the background to prevent blocking the TUI
      runWorkflow(found.workflow, task, { cwd: ctx.cwd, extensionCtx: ctx })
        .then((result) => {
          pi.sendMessage({ customType: "loopflow-result", content: result.summary, display: true, details: result }, { triggerTurn: false });
        })
        .catch((err) => {
          if (err instanceof LoopflowPauseError) {
            ctx.ui.notify(`Loopflow '${name}' paused. Use /loopflow-resume to continue.`, "info");
            return;
          }
          if (err instanceof LoopflowTerminateError) {
            ctx.ui.notify(`Loopflow '${name}' terminated.`, "warning");
            return;
          }
          ctx.ui.notify(`Loopflow '${name}' failed: ${err?.message || err}`, "error");
        });
    },
  });
}
