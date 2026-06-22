---
name: loopflows
description: Use when the user wants deterministic multi-agent workflows, feedback loops between builder/reviewer agents, launch-control style implementation gates, or repeatable Pi subagent processes with max iterations, gates, stop conditions, and artifacts.
---

# Loopflows

Use `loopflow_run` for deterministic agent workflows that need real control flow instead of a linear chain.

Prefer loopflows when work needs:

- a builder/reviewer feedback loop;
- explicit pass/retry/stop gates;
- max iteration limits;
- saved evidence artifacts;
- launch-control style plan → build → review → fix → audit flow.

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
