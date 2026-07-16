# Reference Harness Analysis

Purpose: determine which mature components from **Hermes Agent**, **OpenAI Codex**
(+ the Codex plugin example), and the **OpenAI Agents SDK** can be reused inside
Gondola **without replacing Gondola's architecture**. We do not copy whole
harnesses; we prefer small, testable interfaces, and we distinguish "import
directly" from "wrap as a process/service" from "inspire a native implementation."

## Method

Reference repos are shallow-cloned, read-only, under `references/` (git-ignored,
never shipped):

| Repo | Path | Size | Language(s) | License |
|------|------|------|-------------|---------|
| OpenAI Codex | `references/codex` | ~76 MB | Rust (`codex-rs/`) + TS (`codex-cli/`, `sdk/`) | Apache-2.0 (+ NOTICE) |
| Codex plugin example | `references/codex-plugin-cc` | ~0.7 MB | TypeScript | Apache-2.0 (+ NOTICE) |
| Hermes Agent | `references/hermes-agent` | ~231 MB | Python (+ some TS) | MIT |
| OpenAI Agents SDK | `references/openai-agents-python` | ~25 MB | Python | MIT |

Cross-cutting license implication: **Apache-2.0** (Codex) permits reuse but
requires preserving the `LICENSE` + `NOTICE` and stating changes; direct code
lifts must carry attribution. **MIT** (Hermes, Agents SDK) requires the copyright
+ permission notice on any copied source. Since Gondola is TypeScript and two of
the four are Python, most Python components are **inspiration-only** (option C),
which carries no code-license burden — only the burden of not copying text.

---

## A. Gondola's current architecture (baseline)

Gondola is a local-first, single-provider (Venice) agent built on a Pi-style
agent core, exposed through a Next.js app. Durable runtime state lives under
`.gondola/` as atomic JSON stores. The relevant abstractions today:

### Agent execution
- `src/lib/pi-agent.ts` — the core. `runAgentTurn()` runs one turn; `createSession()`
  builds an `Agent` with `RuntimeContext`; `buildSystemPrompt()` is rebuilt **every
  turn** (identity + runtime header + champion policy + memory). Streaming via
  `createVeniceStreamFn()` (`src/lib/venice-model.ts`) with per-model timeout and
  **model fallback**. In-memory `globalSessions` map (LRU-evicted); durable
  transcript via `src/lib/transcript.ts`; preflight compaction via
  `src/lib/compaction.ts`.
- `RuntimeContext` carries: `sessionId` (conversation id), `agentId`, `agentName`,
  `settings`, `skills`, `mcpServers`, `memoryScope`, `subAgentDepth`, `turnTrace`
  (per-turn `{tool, ok, error}[]`), `toolNames` (live capability registry), and
  `customToolDefs`.

### Tools
- `createTools(runtime)` returns an `AgentTool[]`: built-ins (media, files, search,
  memory, coordination, self-extension, **runtime introspection**, Venice), plus
  `use_skill`, approved abilities, and MCP tools (`src/lib/mcp.ts`).
- Tool results carry a `details` payload streamed to the UI
  (`handleToolResult` in `src/app/page.tsx`). `REQUIRED_BUILT_IN_TOOLS` forces a
  session rebuild when the toolset changes (fingerprint invalidation).
- Destructive tools gate on a `confirmed` flag (write-overwrite, move, delete,
  `run_command`, guarded `venice_api`); there is **no OS-level sandbox** — this is
  a policy/approval model, not isolation.

### Media jobs (asynchronous)
- `src/lib/media-tasks.ts` — durable `MediaTask` store (`.gondola/media-tasks.json`):
  `createMediaTask`, `awaitMediaTask` (idempotent, single shared retrieval per
  task per process via `inFlightRetrievals`, crash-safe via a `retrievalLeaseUntil`
  lease), `runRetrieval` (owner loop, saves bytes → `.gondola/media`, registers an
  asset), `listMediaTasks`, `toTaskStatusView`.
- `src/lib/venice.ts` `quoteAndQueueVideo` / `quoteAndQueueMusic` return queue ids;
  `src/lib/media-service.ts` `retrieveMediaOnce`. Two retrieval paths exist:
  browser polling (`pollArtifact` → `/api/media/retrieve` in `page.tsx`) and the
  durable server task. Agent-facing tools `media_task_list` / `media_task_await`
  were added today.

### Artifacts / assets
- `src/lib/assets.ts` — `ProjectAsset` registry (`registerAsset`, `getAsset`,
  `listAssets`, `updateAsset`), served read-only via `/api/media/asset`.

### Memory
- `src/lib/memory.ts` — personal + agent-scoped memories, semantic search, session
  records, `getMemorySnapshot`, `renderMemorySnapshot` (injected into the prompt).

### Subagents
- `src/lib/subagent.ts` — `runSubAgent`, `scopeToolsForWorker` (a `WORKER_BASE_TOOLS`
  allowlist + depth cap `MAX_SUBAGENT_DEPTH`), driven by `delegate_task` /
  `orchestrate`. Isolation is capability-scoping + depth, not process isolation.

### Recovery
- `src/lib/supervisor.ts` — `diagnoseFailure` (categorizes) + `runSupervisorRecovery`
  (a stripped fast retry, or an explanation). Model fallback lives in `pi-agent`.
  `src/lib/failure-journal.ts` (added today) records failures by pattern category.

### Traces
- `src/lib/lab/ingest.ts` `recordLiveTrace` writes an immutable `RunTrace` per turn;
  `RuntimeContext.turnTrace` collects tool outcomes during the turn.

### Gondola Lab (outer loop / control plane)
- `src/lib/lab/*`: `store.ts` (versioned configs, champion pointer, promotion
  history, proposals), `service.ts` (seed, generateProposal, evaluate, promote,
  rollback, undoRollback), `evaluation.ts`, `reviewer.ts`, `runner.ts`, `apply.ts`
  (`getChampionConfig`), `policy.ts` (`policyDirectives`). UI `GondolaLab.tsx`,
  API `/api/lab`.

### Runtime introspection (added today — the operational self-awareness layer)
- `src/lib/runtime-state.ts` (types + renderers), `src/lib/runtime-snapshot.ts`
  (assembler over all live sources), `src/lib/execution-state.ts` (durable
  goal/plan/steps/phase/checkpoints/budget), `src/lib/failure-journal.ts`. Tools:
  `runtime_status`, `runtime_explain`, `set_plan`, `update_step`, `checkpoint`;
  route `/api/runtime/status`; a compact runtime header injected at the top of
  every turn.

### Security boundary
- `src/lib/request-security.ts` `rejectUntrustedLocalRequest` (loopback + fetch-site
  + content-type guards) protects the local API from DNS-rebinding / CSRF.

**Architectural stance for this analysis:** Gondola already owns execution, tools,
media tasks, assets, memory, subagents, recovery, traces, the Lab, and runtime
introspection. We are looking for **hardening and missing primitives** —
especially OS-level sandboxing, resumable session rollout, and a mature
event/tracing protocol — not a new agent core.

---

## B. Reference component analysis

Legend: **[A]** import directly · **[B]** wrap as a separate process/service · **[C]**
inspire a native TypeScript implementation. Because Codex is Rust and Hermes /
Agents-SDK are Python, and Gondola is a Next.js/TS local-first app, almost every
component is **[C]**; the sole strong **[B]** is Codex's OS-level sandbox.

### B.1 OpenAI Codex (`references/codex`, Apache-2.0, Rust)

| Concern | Key files & symbols | Rec |
|---|---|---|
| 1. Async job tracking | `codex-rs/state/src/model/agent_job.rs` (`AgentJob`, `AgentJobStatus`), `runtime/agent_jobs.rs` (`create_agent_job`, `report_agent_job_item_result`) — SQLite multi-item jobs, pending→running→terminal | **C** |
| 2. Job IDs / poll / artifacts | `get_agent_job`, `get_agent_job_progress`; artifacts as `output_csv_path` + per-item JSON; cloud: `cloud-tasks-client/src/api.rs` (`TaskId`, `create_task`, `apply_task`) | **C** (cloud: ignore) |
| 3. Tool discovery / MCP | `rmcp-client/src/rmcp_client.rs` (`list_tools`, `call_tool`), `codex-mcp/src/connection_manager.rs`, `core/src/tools/registry.rs` (`ToolRegistry`) | **C** (+**B** to run Codex-as-MCP) |
| 4. Checkpoints / resume | `rollout/src/recorder.rs` (`RolloutRecorder`, `…::resume`), `core/src/session/rollout_reconstruction.rs`, `thread_manager.rs` (`resume_thread_from_rollout`, `fork_thread`) — append-only JSONL rollout + rebuild | **C** |
| 5. Sandbox exec/FS | `sandboxing/src/manager.rs` (`SandboxManager`), `linux-sandbox/src/landlock.rs` (landlock+seccomp), `sandboxing/src/seatbelt.rs` (`.sbpl`), `execpolicy/src/policy.rs` (`Policy::check`) | **B** (policy rules: **C**) |
| 6. Approvals | `protocol/src/protocol.rs` (`AskForApproval`: UnlessTrusted/OnRequest/Granular/Never, `ReviewDecision::ApprovedForSession`), `core/src/tools/approvals.rs`, `guardian/review.rs` | **C** |
| 7. Subagent isolation | `core/src/codex_delegate.rs` (`SessionSource::SubAgent`), `tools/handlers/multi_agents/{spawn,wait,resume_agent}.rs` — own thread + channel, parent-owned approvals | **C** |
| 8. Runtime state to agent | `core/src/context/world_state/*` (`WorldState`, `WorldStateSnapshot`, sections: environment, agents_md, plugins) — injected context | **C** |

### B.2 Codex plugin example (`references/codex-plugin-cc`, Apache-2.0, Node)

The most directly TS-relevant: a small, file-backed async-job harness + JSON-RPC client.

| Concern | Key files & symbols | Rec |
|---|---|---|
| 1–2. Job store / IDs / poll / artifacts | `plugins/codex/scripts/lib/state.mjs` (`loadState`/`upsertJob`/`generateJobId`/`writeJobFile`, prune to 50), `lib/tracked-jobs.mjs` (`runTrackedJob`, lifecycle queued→running→completed\|failed), `lib/job-control.mjs` (`waitForSingleJobSnapshot` 2s/240s, `buildStatusSnapshot`). IDs `{prefix}-{time36}-{rand}`; per-job `{id}.json` + `{id}.log` | **C** |
| 4. Resume | thread/job resume by id (`--resume-last`, `findLatestResumableTaskJob`); no step snapshots | **C** |
| 8. Runtime state | `enrichJob`/`buildStatusSnapshot` (status/phase/threadId/elapsed), phase inferred from log lines (`inferLegacyJobPhase`) | **C** |
| 9. Recovery | fail-closed job record + `errorMessage`; interrupt + `terminateProcessTree`; inferred turn completion | **C** |
| 10. Event / app-server protocol | newline-delimited JSON-RPC over stdio / unix-socket broker; `app-server-protocol.d.ts` `AppServerMethodMap` (`thread/start`, `turn/start`, notifications `turn/started`, `item/completed`, `error`); item types `agentMessage`, `commandExecution`, `mcpToolCall` | **B** (talk to Codex) / **C** (shapes) |

### B.3 Hermes Agent (`references/hermes-agent`, MIT, Python)

| Concern | Key files & symbols | Rec |
|---|---|---|
| 1. Async jobs | `cron/jobs.py` (`create_job`/`claim_job_for_fire`/`mark_job_run` — durable JSON store), `tools/async_delegation.py` (`dispatch_async_delegation`, `recover_abandoned_delegations` — SQLite), `tools/process_registry.py` | **C** |
| 3. Tool discovery / ACP | `tools/registry.py` (`ToolRegistry`, `discover_builtin_tools`, `get_definitions`), `toolsets.py` (`resolve_toolset`), `acp_adapter/server.py` (`HermesACPAgent`), `acp_registry/agent.json` | **C** (+**B** for ACP subprocess) |
| 4. Checkpoints / resume | `hermes_state.py` (`SessionDB`: `create_session`/`reopen_session`/handoff), `acp_adapter/session.py` (`SessionManager` persist/restore/resume), `tools/checkpoint_manager.py` (shadow-git snapshots) | **C** |
| 5. Sandbox | `tools/environments/base.py` (`BaseEnvironment.execute`) + `Local`/`Docker`/`SSH`/`Modal`/`Daytona` backends | **C** (local) / **B** (container) |
| 6. Approvals | `tools/approval.py` (`detect_dangerous_command`, allowlist/deny), `acp_adapter/permissions.py` (`make_approval_callback`), `edit_approval.py` (`EditProposal`) | **C** |
| 7. Subagents | `tools/delegate_tool.py` (roles leaf\|orchestrator, `interrupt_subagent`, depth/concurrency caps), `tools/kanban_tools.py` (task board) | **C** |
| 9. Recovery / retry | `agent/error_classifier.py` (`classify_api_error`, `FailoverReason`), `retry_utils.py` (`jittered_backoff`), `agent_runtime_helpers.py` (`recover_with_credential_pool`, `repair_message_sequence`) | **C** |
| 10. Events | `acp_adapter/events.py` (`make_tool_progress_cb`, `make_step_cb`, `_send_update`) — ACP update stream | **C** (+**B** ACP) |

### B.4 OpenAI Agents SDK (`references/openai-agents-python`, MIT, Python)

Best **shapes** to mirror (interfaces/dataclasses), not code to import.

| Concern | Key files & symbols | Rec |
|---|---|---|
| 1–2. Jobs / artifacts | _no first-class job queue._ Closest: `run_state.py` (`RunState`), `memory/session.py` (`Session`), `sandbox/entries/artifacts.py` (`File`/`Dir`/`GitRepo`), `sandbox/snapshot.py` | **C** |
| 3. Tool discovery | `tool.py` (`FunctionTool`, `function_tool()`, `HostedMCPTool`), `function_schema.py` (`FuncSchema`), `mcp/util.py` (`MCPUtil.get_all_function_tools`, `ToolFilter`) | **C** (+**B** MCP transport) |
| 4. Checkpoints / resume | **`run_state.py` `RunState`** (`to_json`/`from_json`, `get_interruptions`, `approve`/`reject`) + `run.py` `Runner.run(input: … | RunState)` — serializable checkpoint + resume contract | **C** (highest-value shape) |
| 6. Approvals (HITL) | `tool.py` `FunctionTool.needs_approval`, `run_context.py` (`approve_tool`/`is_tool_approved`, sticky vs per-`call_id`), `items.py` `ToolApprovalItem`, `run_internal/run_steps.py` `NextStepInterruption` | **C** |
| 7. Subagents | `handoffs/__init__.py` (`Handoff`, `handoff()`, `HandoffInputFilter`) vs `agent.py` `Agent.as_tool()` (nested run returns to parent) | **C** |
| 8. Runtime state | `run_context.py` `RunContextWrapper` (context/usage/approvals — **not sent to LLM**), `tool_context.py` `ToolContext` | **C** |
| 10. Tracing | `tracing/` spans + `RunResultStreaming` streamed events | **C** |

---

## C. License & attribution summary

| Repo | License | Obligation if we reuse |
|---|---|---|
| Codex | **Apache-2.0** | Preserve `LICENSE` + `NOTICE`; state changes; patent grant applies. `NOTICE` also carries **Ratatui (MIT)** attribution — only relevant if reusing its TUI code (we won't). |
| Codex plugin | **Apache-2.0** | Preserve `LICENSE` + `NOTICE` (Copyright 2026 OpenAI) on any copied source. |
| Hermes Agent | **MIT** | Keep the MIT copyright + permission notice on any copied source (Copyright 2025 Nous Research). |
| OpenAI Agents SDK | **MIT** | Keep the MIT notice on any copied source (Copyright 2025 OpenAI). |

**Practical bottom line:** our recommendations are almost entirely **[C] (native TS,
inspired-by)**, which copies *ideas*, not source — so **no license text travels into
Gondola**. The only obligations arise if we later (a) vendor snippets (add the
notice) or (b) ship the Codex binary as a sandbox sidecar (**[B]** — bundle its
`LICENSE`/`NOTICE`). Keep `references/` git-ignored (done) so upstream code is never
committed.

---

## D. Ranked components worth adopting

Ranked by value ÷ effort for a **local-first TS** agent, with the integration boundary.

1. **Serializable turn checkpoint + resume contract** — *Agents SDK `RunState`* + *Codex rollout reconstruction* + *Hermes `SessionDB.reopen_session`*. **[C].** Boundary: a durable, serializable per-turn checkpoint that `runAgentTurn` can resume/fork; extends today's `execution-state.ts` checkpoints. **Highest value.**
2. **Durable async-job registry (id → poll → artifact/log)** — *codex-plugin `state.mjs`/`tracked-jobs.mjs`* (near-drop-in TS pattern) + *Codex `agent_jobs`* + *Hermes `cron/jobs` + `async_delegation` (recover_abandoned)*. **[C].** Boundary: this is exactly §E's media-registry hardening — validate our `media-tasks.ts` against the plugin's id/poll/artifact split and `recover_abandoned_delegations`.
3. **OS-level sandbox for `run_command`** — *Codex `sandboxing` (Landlock/seccomp/Seatbelt) + `execpolicy`*. **[B]** sidecar (+**[C]** for the allowlist policy). Boundary: a small exec-broker process; Node cannot do Landlock/Seatbelt in-process. **Highest security value; highest effort** — Gondola currently has *no* real isolation, only a `confirmed` policy.
4. **First-class approval / interruption model** — *Agents SDK `needs_approval` + interruptions→approve/reject→resume (sticky vs per-call_id)* + *Codex `AskForApproval` modes / `ApprovedForSession`*. **[C].** Boundary: upgrade our per-tool `confirmed` flag into a durable `ToolApprovalItem`-style record with session-scoped grants.
5. **Failure classification + bounded retry/recovery** — *Hermes `error_classifier` (`FailoverReason`) + `retry_utils` + `recover_abandoned_delegations`*. **[C].** Boundary: feed our `failure-journal.ts` + supervisor; add `recoverAbandoned*` for detached jobs (ties into §E).
6. **Tool/capability registry + MCP tool filters** — *Agents SDK `FunctionTool`/`function_schema`/`MCPUtil.ToolFilter`* + *Codex/Hermes `ToolRegistry`*. **[C].** Boundary: we already have this; adopt static tool filters + per-tool `needs_approval`.
7. **Subagent patterns: handoff vs agent-as-tool** — *Agents SDK `Handoff` vs `Agent.as_tool()`* + *Codex/Hermes delegate roles + parent-owned approvals*. **[C].** Boundary: extend `subagent.ts` with the explicit "returns to parent" (tool) vs "transfers control" (handoff) distinction.
8. **Event / ACP protocol** — *Hermes ACP (`acp_adapter`)* + *codex-plugin JSON-RPC app-server (`AppServerMethodMap`)*. **[C]** for a small native event bus; **[B]** only if Gondola ever exposes/consumes an external agent over ACP (e.g. editor integration).

Explicitly **not** worth adopting: whole harnesses; Codex's Rust rollout/thread crates; Hermes's Python multiprocess batch/datagen (`batch_runner.py`); cloud-tasks / container backends (Modal/Daytona) for a local-first tool; Claude-plugin markdown/slash-command layout.

---

## E. First implementation plan — durable, attached media-job registry

### The failure this targets
In the observed run, video jobs were **queued but became detached from the
agent's runtime state**: the agent held queue ids only in conversation text,
could not authoritatively check status, and could neither retrieve nor deliver
the finished files. It then hallucinated/flip-flopped about delivery.

### What already exists (do not rebuild)
Today's `src/lib/media-tasks.ts` is already a durable registry with queue id
(`providerTaskId`), `status`, `estimatedCostUsd`/`actualCostUsd`, `downloadUrl`,
`outputPath`/`outputUrl`, `assetId`, `error`, and a crash-safe resumable retrieval
(`awaitMediaTask` + `retrievalLeaseUntil` + shared `inFlightRetrievals`). It is
already surfaced read-only to the agent via `media_task_list` and the
`runtime_status` `jobs` section, and delivered via `media_task_await`.

So this plan is **not** a new store — it is **closing four specific gaps** so a
job can never again be "detached" from runtime state.

### Gaps to close
1. **Associated goal + conversation link.** `MediaTask` records `originatingRunId`/
   `originatingAgentId`/`projectId` but not the conversation id or the active goal.
   → Add `conversationId` and `goal` (captured at `createMediaTask` time from
   `runtime.sessionId` and the current `execution-state` goal). This ties every job
   to *why* it exists and lets the snapshot filter jobs to the current task.
2. **Source assets.** Image-to-video jobs have no link to the image(s) they
   animate. → Add `sourceAssetIds?: string[]` (and/or `sourceImageRefs`), populated
   from the generated/attached image assets used to queue.
3. **Retrieval state detail.** We track `status` + lease but not attempts/last poll.
   → Add `retrievalAttempts` and `lastPolledAt` for honest "retrieval state"
   reporting (and to bound supervisor retries).
4. **Supervisor-safe resume.** `awaitMediaTask` is resumable, but nothing *invokes*
   it on recovery. → Add `resumePendingMediaTasks(conversationId)` that finds
   `queued`/`running` tasks and re-drives `awaitMediaTask` for each (idempotent via
   the existing lease/shared-retrieval, so double-resume is safe), and call it from
   `runSupervisorRecovery` and optionally at session start.

### Read-only introspection (already satisfied, to confirm in tests)
The agent reads jobs through `media_task_list` and `runtime_status` (`jobs`
section); both are read-only. The registry additions above flow into
`buildRuntimeSnapshot`'s `jobs` mapping (add `goal`, `sourceAssetIds`,
`retrievalAttempts`).

### Proposed integration boundary
- Registry stays **native TypeScript** in `media-tasks.ts` (option C throughout for
  this feature — no external code). The reference repos inform *shape*: durable
  task record + lease + resumable poller mirrors patterns validated in the Agents
  SDK (RunState) and Codex (rollout/resume). See Section D for what, if anything,
  is worth wrapping vs. mirroring.
- Supervisor resume is an internal call; no new process/service.

### Testability
- Unit: `createMediaTask` captures `conversationId`/`goal`/`sourceAssetIds`;
  `resumePendingMediaTasks` re-drives only `queued`/`running` and is idempotent
  under concurrent calls (injectable retriever, as `awaitMediaTask` already
  supports).
- Integration: a queued task survives a simulated restart and is resumed to
  `succeeded` with an asset + `outputPath`.

### Explicitly out of scope for the first cut
OS-level sandboxing, session rollout/replay, and a full event protocol are
separate, larger adoptions evaluated in Sections B–D; they are **not** required to
fix the detached-job failure.

---

_Status: complete. Sections A–E written from the four upstream analyses. No
production code was modified for this analysis (the `tsconfig` exclude for
`references/` is build hygiene so the clones aren't compiled)._
