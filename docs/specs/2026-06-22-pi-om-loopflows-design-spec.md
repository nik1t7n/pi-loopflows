# Design Spec: Private Persistent Memory for Loopflow Agents using Pi OM

**Date:** June 22, 2026  
**Status:** Approved  
**Author:** Nikita Nosov / Nikita's AI Assistant  

---

## 1. Executive Summary

This specification outlines the integration of **Private Persistent Memory (Approach A)** for loopflow subagents using `pi-observational-memory-extension` (Pi OM). By replacing the external `agentmemory` daemon, we establish a unified, robust, and zero-dependency memory framework across the entire Pi runtime and all of its automated loopflows.

---

## 2. Core Concepts & Context Flow

To enable a natural separation of cognitive concerns, the system distinguishes between **Explicit Context Sharing** (the working payload) and **Implicit Long-Term Memory** (the private cognitive context):

1. **Explicit Context Sharing (The Shared Canvas):**
   * Handled natively by the `pi-loopflows` orchestrator via task template variables (e.g., `{outputs.build.output}`, `{outputs.build.artifactPath}`).
   * This is how agents explicitly pass files, code modifications, or status structures to subsequent steps.

2. **Implicit Long-Term Memory (The Individual Heads):**
   * Handled by the OM extension running on dedicated, persistent session IDs:
     `sessionId = "loopflow-${workflowName}-${agentName}".toLowerCase()`
   * Each agent remembers its own procedural history, mistakes, successful tool invocations, and individual interactions across iterations and runs.

---

## 3. Implementation Plan

### A. Pi Observational Memory Extension (pi-observational-memory-extension)
* **Objective:** Ensure short, single-turn subagent runs always persist their memories upon shutdown.
* **Target File:** `/Users/nik1t7n/Projects/pi-observational-memory/extensions/index.ts`
* **Modification:** Enhance the `session_shutdown` hook to force `observeNow` if there are pending messages (`pendingMessageTokens > 0`).

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  if (runtime.statusTimer) clearInterval(runtime.statusTimer);
  runtime.currentOperation?.abort();
  if (runtime.state) {
    try {
      // Force observe pending tokens before shutting down
      if (runtime.state.enabled && runtime.state.pendingMessageTokens > 0) {
        await observeNow(ctx, { force: true, reason: "session_shutdown" });
      }
    } catch (error) {
      // Safe fallback on shutdown
    }
    await saveState(runtime.state);
  }
  ctx.ui.setStatus("om", undefined);
  ctx.ui.setWidget("om", undefined);
});
```

### B. Pi Loopflows (pi-loopflows)
* **Objective:** Remove `agentmemory` entirely, and run subagents with deterministic `--session-id` arguments.
* **Target File:** `/Users/nik1t7n/Projects/pi-loopflows/extensions/index.ts`
* **Modifications:**
  1. Remove `queryAgentMemory` function.
  2. Remove calling `queryAgentMemory` in `runStep -> prepareTask`.
  3. Modify `PiSubprocessAdapter.runAgent` to construct `sessionId` and pass it to Pi:
     ```typescript
     const workflowName = activeRun?.workflow?.name || "default";
     const sessionId = `loopflow-${safeName(workflowName)}-${safeName(agentName)}`.toLowerCase();
     const args = ["--mode", "json", "-p", "--session-id", sessionId];
     ```

---

## 4. Edge Cases & Safety

1. **Zero-Impact Shutdowns:** If a subprocess gets aborted (e.g. by `SIGINT`/`SIGTERM` during a pause or terminate request), `session_shutdown` is gracefully called and will capture any finished turns.
2. **Deterministic Identifiers:** The `safeName` helper is used to ensure that session files are named with clean, lower-case, alphanumeric filesystem-safe strings.
3. **No Thread Collisions:** All agents run as isolated processes with their own separate `.pi/om/<id>.json` files, preventing write conflicts or file lock issues.
