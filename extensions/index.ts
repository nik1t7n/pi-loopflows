import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

type LoopDef = {
  id: string;
  maxIterations: number;
  body: StepDef[];
  gateStep: string;
  passStatuses?: string[];
  retryStatuses?: string[];
  stopStatuses?: string[];
  onExhausted?: "stop" | "continue";
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
  runAgent(agent: string, task: string, options: { cwd: string; signal?: AbortSignal; model?: string; tools?: string[]; scope: "user" | "project" | "both" }): Promise<{ output: string; exitCode: number; stderr: string }>;
}

class PiSubprocessAdapter implements ExecutorAdapter {
  async runAgent(agentName: string, task: string, options: { cwd: string; signal?: AbortSignal; model?: string; tools?: string[]; scope: "user" | "project" | "both" }) {
    const agents = discoverAgents(options.cwd, options.scope);
    const agent = agents.get(agentName);
    if (!agent) {
      return { output: "", exitCode: 1, stderr: `Unknown agent ${agentName}. Available: ${[...agents.keys()].sort().join(", ")}` };
    }
    const args = ["--mode", "json", "-p", "--no-session"];
    const model = options.model ?? agent.model;
    const tools = options.tools ?? agent.tools;
    if (model) args.push("--model", model);
    if (tools?.length) args.push("--tools", tools.join(","));
    const tmp = agent.systemPrompt.trim() ? await writePrompt(agentName, agent.systemPrompt) : undefined;
    if (tmp) args.push("--append-system-prompt", tmp.file);
    args.push(task);

    const invocation = getPiInvocation(args);
    let stdout = "";
    let stderr = "";
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
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

async function runStep(def: StepDef, ctx: RunContext, adapter: ExecutorAdapter, scope: "user" | "project" | "both", signal: AbortSignal | undefined, iteration?: number): Promise<StepResult> {
  const task = renderTemplate(def.task, ctx, iteration);
  const run = await adapter.runAgent(def.agent, task, { cwd: ctx.cwd, signal, model: def.model, tools: def.tools, scope });
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

async function runLoop(loop: LoopDef, ctx: RunContext, adapter: ExecutorAdapter, scope: "user" | "project" | "both", signal: AbortSignal | undefined): Promise<StepResult> {
  const max = Math.max(1, loop.maxIterations);
  let lastGate: StepResult | undefined;
  for (let i = 1; i <= max; i++) {
    await saveArtifact(ctx, `${safeName(loop.id)}/iteration-${i}.txt`, `Starting iteration ${i}/${max}\n`);
    for (const step of loop.body) {
      const stepWithGate = step.id === loop.gateStep && !step.gate ? { ...step, gate: { type: "json-status" as const } } : step;
      const result = await runStep(stepWithGate, ctx, adapter, scope, signal, i);
      if (step.id === loop.gateStep) lastGate = result;
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

async function runWorkflow(workflow: WorkflowDef, task: string, opts: { cwd: string; signal?: AbortSignal; params?: Record<string, any>; maxIterations?: number }) {
  const adapter = new PiSubprocessAdapter();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(workflow.name)}`;
  const artifactsDir = path.join(opts.cwd, ".pi/loopflows/runs", runId);
  await ensureDir(artifactsDir);
  const ctx: RunContext = { cwd: opts.cwd, task, artifactsDir, outputs: {}, sequence: [], params: opts.params ?? {} };
  const scope = workflow.defaults?.agentScope ?? "both";

  await saveArtifact(ctx, "workflow.json", JSON.stringify(workflow, null, 2));
  await saveArtifact(ctx, "task.md", task);

  for (const node of workflow.steps) {
    if ("loop" in node) {
      const loop = { ...node.loop };
      if (opts.maxIterations) loop.maxIterations = opts.maxIterations;
      const result = await runLoop(loop, ctx, adapter, scope, opts.signal);
      if (result.exitCode !== 0 || String(result.status ?? "").startsWith("exhausted") || statusIn(result.status, loop.stopStatuses, ["blocked"])) break;
    } else {
      const result = await runStep(node, ctx, adapter, scope, opts.signal);
      if (result.exitCode !== 0) break;
      if (node.gate && statusIn(result.status, node.gate.stopStatuses, ["blocked", "incomplete"])) break;
    }
  }

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
      const result = await runWorkflow(found.workflow, params.task, { cwd: ctx.cwd, signal, params: params.params, maxIterations: params.maxIterations });
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
      const result = await runWorkflow(found.workflow, task, { cwd: ctx.cwd });
      pi.sendMessage({ customType: "loopflow-result", content: result.summary, display: true, details: result }, { triggerTurn: false });
    },
  });
}
