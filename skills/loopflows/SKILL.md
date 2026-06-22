---
name: loopflows
description: Use when the user wants deterministic multi-agent workflows, feedback loops between builder/reviewer agents, launch-control style implementation gates, repeatable Pi subagent processes, or custom workflow construction with max iterations, gates, stop conditions, and artifacts.
---

# Loopflows

Use `loopflow_run` when a task needs process control, not just a linear chain.

A loopflow is a reusable workflow made from subagent steps, gates, and loops. Use it when work should be checked, sent back for fixes, capped by max iterations, or stopped when evidence is missing.

## Built-in loopflows

- `launch-control` — strict plan-as-contract flow: context → plan → build/review loop → final audit.
- `build-review` — lightweight implementation loop for scoped changes.
- `plan-review` — review and revise a plan before implementation starts.

## Commands

List workflows:

```text
/loopflow-list
```

Run a workflow:

```text
/loopflow launch-control -- <task or plan>
```

Or call the tool directly:

```ts
loopflow_run({ workflow: "launch-control", task: "...", maxIterations: 3 })
```

## Rule of thumb

Use `pi-subagents` chains for simple linear handoffs. Use `pi-loopflows` when a gate can send work backward for fixes or stop the run.

## Customization

Loopflows are `.loopflow.json` files. Copy bundled workflows into `.pi/loopflows/` to customize them for a project: change agents, prompts, max iterations, pass/retry/stop statuses, or final audit rules.
