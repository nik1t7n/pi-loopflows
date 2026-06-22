# pi-loopflows

Build deterministic AI workflows out of Pi subagents.

Think of **loopflows** as LEGO for subagents. You take small specialist agents, connect them into a process, add gates where decisions matter, and let the workflow move forward, branch, loop back, or stop based on explicit results. Instead of one giant prompt, you get a reusable structure for how agents collaborate: steps, feedback loops, stop rules, and saved evidence.

## Why loopflows

Linear chains are useful, but real work is not always linear. A reviewer can request changes. A validator can reject missing evidence. A planner can reveal that the task is blocked. A builder may need several focused passes before the result is safe to accept.

Loopflows make that control flow explicit:

```text
step → step → gate
             ↓
          approved → continue
          changes_requested → loop back
          blocked → stop
```

The philosophy is simple: AI should work through a process, not just produce a confident answer. A loopflow defines who does the work, who checks it, what counts as success, how many attempts are allowed, where evidence is saved, and when the run must stop instead of guessing.

## Install

```bash
pi install npm:pi-loopflows
```

`pi-loopflows` uses Pi subagent definitions as its first backend. Install `pi-subagents` if you have not already:

```bash
pi install npm:pi-subagents
```

Then reload Pi:

```text
/reload
```

## What you get

### Tool

```ts
loopflow_run({
  workflow: "launch-control",
  task: "Implement this approved backend plan",
  maxIterations: 3
})
```

### Commands

```text
/loopflow-list
/loopflow launch-control -- Implement this approved backend plan
```

### Built-in loopflows

- `launch-control` — plan-as-contract implementation loop with builder/reviewer feedback and final audit.
- `build-review` — small generic build → review → fix loop for scoped implementation tasks.
- `plan-review` — planning loop that lets a reviewer reject vague or unsafe plans before implementation.

## Loopflows as a constructor

Think of loopflows as LEGO for agent processes. A loopflow can use any available Pi subagent role:

- `context-builder`
- `scout`
- `researcher`
- `planner`
- `worker`
- `reviewer`
- `oracle`
- your own custom agents

You decide:

- which agent runs first;
- what each agent receives;
- which output is saved;
- which step is a gate;
- what statuses mean pass, retry, or stop;
- how many loop iterations are allowed;
- where artifacts go;
- what final audit should prove.

Today, the backend runs Pi-compatible subagents. The engine is intentionally built behind an adapter boundary, so future versions can add other compatible backends — Codex CLI, OpenCode, ACP workers, remote agents, or custom executors — without changing the loopflow concept.

## Loopflow files

Loopflows are JSON files named:

```text
*.loopflow.json
```

Discovery locations:

- bundled package loopflows;
- user loopflows: `~/.pi/agent/loopflows/`;
- project loopflows: `.pi/loopflows/`.

Project loopflows are the easiest way to customize behavior for one repo.

## Minimal example

```json
{
  "name": "build-review",
  "description": "Build, review, and fix until approved.",
  "steps": [
    {
      "id": "plan",
      "agent": "planner",
      "task": "Plan this task: {task}"
    },
    {
      "loop": {
        "id": "build-review",
        "maxIterations": 3,
        "gateStep": "review",
        "passStatuses": ["approved"],
        "retryStatuses": ["changes_requested"],
        "stopStatuses": ["blocked"],
        "body": [
          {
            "id": "build",
            "agent": "worker",
            "task": "Build from plan: {outputs.plan}"
          },
          {
            "id": "review",
            "agent": "reviewer",
            "gate": { "type": "json-status" },
            "task": "Review and return JSON with status approved, changes_requested, or blocked."
          }
        ]
      }
    }
  ]
}
```

## Template variables

- `{task}` — original user task.
- `{previous}` — previous step output.
- `{outputs.stepId}` — output from a named step.
- `{outputs.stepId.output}` — same as above, explicit form.
- `{outputs.stepId.status}` — parsed gate status.
- `{outputs.stepId.json}` — parsed gate JSON.
- `{loop.iteration}` — current loop iteration.
- `{artifactsDir}` — current run artifact directory.
- `{params.name}` — runtime params passed to `loopflow_run`.

## Gate contract

Gate steps should return JSON. A typical reviewer gate returns:

```json
{
  "status": "approved",
  "summary": "The implementation satisfies the plan.",
  "findings": [],
  "validation_gaps": [],
  "requires_user_decision": false
}
```

Common statuses:

- `approved` — move forward.
- `changes_requested` — loop back for another pass.
- `blocked` — stop; user or environment action is required.
- `complete` — final audit passed.
- `incomplete` — final audit failed.

Each loopflow decides which statuses pass, retry, or stop.

## Artifacts

Every run writes evidence to:

```text
<cwd>/.pi/loopflows/runs/<timestamp>-<workflow>/
```

Typical artifacts:

```text
task.md
workflow.json
context.md
block-plan.md
build-1.md
review-1.json
final-audit.json
summary.md
```

This makes loopflows inspectable. You can see what each agent claimed, what the gate decided, and why the run stopped or passed.

## Customization patterns

### Make Launch Control stricter

Copy the bundled file:

```bash
mkdir -p .pi/loopflows
cp ~/.pi/agent/npm/node_modules/pi-loopflows/loopflows/launch-control.loopflow.json \
  .pi/loopflows/launch-control.loopflow.json
```

Then edit the project copy. Common changes:

- increase `maxIterations`;
- change `reviewer` to a custom security reviewer;
- add stricter validation language;
- add a docs or migration audit step;
- change stop statuses;
- make the final audit require `complete` only.

### Create a lightweight workflow

Use `build-review` for small implementation tasks where full Launch Control is too formal.

```text
/loopflow build-review -- Add validation to the import endpoint
```

### Review a plan before coding

Use `plan-review` when you want a plan to be checked before a worker touches files.

```text
/loopflow plan-review -- Plan the database migration for workspace roles
```

## Backend design

The runtime uses an executor adapter boundary:

```ts
runAgent(agent, task, options) -> StepResult
```

Current backend:

- Pi subprocess agents compatible with `pi-subagents` agent definitions.

Future-compatible backend ideas:

- Codex CLI workers;
- OpenCode workers;
- ACP-compatible agents;
- remote worker pools;
- project-specific executors.

The point is that loopflows describe the process. The backend decides how each agent is actually executed.

## When to use loopflows vs chains

Use normal Pi subagent chains when the process is linear:

```text
scout → planner → worker
```

Use loopflows when a step can send work backward or stop the process:

```text
worker → reviewer → worker → reviewer
```

If you need a feedback loop, a quality gate, a max iteration limit, or saved evidence, use a loopflow.

## Status

`pi-loopflows` is early, but designed as a real product surface rather than a one-off script. The core model is intentionally small:

```text
steps + loops + gates + artifacts + adapters
```

That is enough to build useful workflows without turning the extension into a giant orchestration platform.

## License

MIT
