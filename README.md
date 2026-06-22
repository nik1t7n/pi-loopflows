# pi-loopflows

Deterministic loop workflows for Pi subagents.

A **loopflow** describes agent work as a process instead of a single prompt: steps, gates, feedback loops, stop conditions, and saved evidence. It lets you connect Pi subagents like building blocks: gather context, plan, build, review, loop back for fixes, and audit the result.

## Why

Normal chains are linear. Real work is not. A reviewer may request changes, a builder may need another pass, or a gate may block because evidence is missing. `pi-loopflows` adds that missing control flow while keeping the agents focused on their roles.

## Install

```bash
pi install npm:pi-loopflows
```

Or from GitHub:

```bash
pi install https://github.com/nik1t7n/pi-loopflows
```

Reload Pi after installing:

```text
/reload
```

## What it adds

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

### Bundled loopflow

`launch-control`:

```text
context-builder
  → planner
  → loop max 3:
      worker
      reviewer gate
        approved -> continue
        changes_requested -> repeat
        blocked -> stop
  → final audit
```

## Loopflow files

Loopflows are JSON files named `*.loopflow.json`.

Discovery locations:

- bundled package `loopflows/`
- user: `~/.pi/agent/loopflows/`
- project: `.pi/loopflows/`

Project loopflows can override or add workflows for a repo.

## Minimal shape

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

- `{task}` — original user task
- `{previous}` — previous step output
- `{outputs.stepId}` — output from a named step
- `{outputs.stepId.status}` — parsed gate status
- `{outputs.stepId.json}` — parsed gate JSON
- `{loop.iteration}` — current loop iteration
- `{artifactsDir}` — current run artifact directory
- `{params.name}` — runtime params passed to `loopflow_run`

## Artifacts

Every run writes evidence to:

```text
<cwd>/.pi/loopflows/runs/<timestamp>-<workflow>/
```

Typical files:

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

## Backend design

The engine uses an executor adapter boundary:

```ts
runAgent(agent, task, options) -> StepResult
```

Current backend: Pi subprocess agents compatible with `pi-subagents` agent definitions.

Future backends can support Codex CLI, OpenCode, ACP-based workers, remote workers, or other agent runtimes without changing loopflow definitions.

## Requirements

- Pi coding agent
- `pi-subagents` installed for the bundled agent roles:

```bash
pi install npm:pi-subagents
```

## Status

Early but usable. The core model is intentionally small: steps, loops, gates, artifacts, and adapters.

## License

MIT
