# Changelog

## 0.2.0 - 2026-06-22

- **feat(memory)**: Implement isolated persistent session IDs (`loopflow-{workflow}-{agent}`) per subagent and native Mastra-style Observational Memory to compile, compress, and inject observations & reflections across iterations.
- **feat(tui)**: Add full-screen interactive TUI monitor dashboard overlay (`/loopflow-monitor` / `ctrl+shift+l`) with dynamic ANSI-aware text wrapping, scroll acceleration, tab navigation, and responsive layout.
- **feat(control)**: Implement real-time control plane allowing users to pause (`p`), resume (`r`), or terminate (`x`) loopflow execution at step boundaries.
- **feat(steering)**: Add inline subagent steering and messaging bar with `queue`, `steer`, and `interrupt` (rewrites and restarts current step) delivery modes to direct active subagents in real-time.
- **fix(executor)**: Robust `finalText` accumulation from multiple assistant messages and loop continuation on valid gate status even with non-zero exit codes.

## 0.1.3 - 2026-06-22

- Add clear semantic versioning policy and release checklist.
- Include `VERSIONING.md` in the published package.
- Add concise versioning guidance to README.

## 0.1.2 - 2026-06-22

- Tighten README positioning around loopflows as LEGO-like subagent workflows.
- Remove the dedicated Launch Control README section while keeping it listed as a bundled workflow.

## 0.1.1 - 2026-06-22

- Polish product README and usage guidance for public release.
- Add bundled `build-review` loopflow for lightweight implementation feedback loops.
- Add bundled `plan-review` loopflow for plan quality gates before implementation.
- Expand loopflows skill instructions.
- Clarify adapter/backend direction for future compatible executors.

## 0.1.0 - 2026-06-22

- Initial release.
- Add `loopflow_run` tool.
- Add `/loopflow` and `/loopflow-list` commands.
- Add JSON loopflow discovery from bundled, user, and project locations.
- Add step, loop, gate, max-iteration, artifact, and adapter primitives.
- Bundle `launch-control` loopflow preset.
