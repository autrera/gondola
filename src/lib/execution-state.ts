import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Durable, per-conversation execution state: the goal, the plan (as an ordered
// list of steps with status), the current phase, wait/recovery flags, and named
// checkpoints. This is the authoritative "where is execution right now" record
// that the Runtime Introspection layer reads, so the agent never has to
// reconstruct its own progress from the chat transcript.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "execution-state.json");
const MAX_CONVERSATIONS = 200;
const MAX_STEPS = 60;
const MAX_CHECKPOINTS = 40;

export type StepStatus =
  | "not_started"
  | "running"
  | "done"
  | "blocked"
  | "waiting"
  | "skipped"
  | "failed";

export const STEP_STATUSES: StepStatus[] = [
  "not_started",
  "running",
  "done",
  "blocked",
  "waiting",
  "skipped",
  "failed",
];

export interface ExecutionStep {
  id: string;
  title: string;
  status: StepStatus;
  detail?: string;
  updatedAt: string;
}

export interface ExecutionCheckpoint {
  id: string;
  label: string;
  createdAt: string;
  data?: Record<string, unknown>;
}

export interface ExecutionState {
  conversationId: string;
  goal: string | null;
  plan: string | null;
  phase: string | null;
  currentStepId: string | null;
  waitingForHuman: boolean;
  waitingForTool: boolean;
  waitingForMedia: boolean;
  recovering: boolean;
  /** Optional durable spend cap the agent declared for this task, in USD. */
  budgetUsd: number | null;
  steps: ExecutionStep[];
  checkpoints: ExecutionCheckpoint[];
  createdAt: string;
  updatedAt: string;
}

interface ExecutionStore {
  version: 1;
  conversations: Record<string, ExecutionState>;
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<ExecutionStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<ExecutionStore>;
    return { version: 1, conversations: parsed.conversations ?? {} };
  } catch {
    return { version: 1, conversations: {} };
  }
}

async function write(store: ExecutionStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  // Bound growth: keep the most recently updated conversations.
  const entries = Object.entries(store.conversations);
  if (entries.length > MAX_CONVERSATIONS) {
    entries.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
    store.conversations = Object.fromEntries(entries.slice(0, MAX_CONVERSATIONS));
  }
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, FILE);
}

function emptyState(conversationId: string): ExecutionState {
  const now = new Date().toISOString();
  return {
    conversationId,
    goal: null,
    plan: null,
    phase: null,
    currentStepId: null,
    waitingForHuman: false,
    waitingForTool: false,
    waitingForMedia: false,
    recovering: false,
    budgetUsd: null,
    steps: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function getExecutionState(conversationId: string): Promise<ExecutionState> {
  const store = await read();
  return store.conversations[conversationId] ?? emptyState(conversationId);
}

async function mutate(
  conversationId: string,
  patch: (state: ExecutionState) => ExecutionState,
): Promise<ExecutionState> {
  return serial(async () => {
    const store = await read();
    const current = store.conversations[conversationId] ?? emptyState(conversationId);
    const next = { ...patch(current), conversationId, updatedAt: new Date().toISOString() };
    store.conversations[conversationId] = next;
    await write(store);
    return next;
  });
}

export interface SetPlanInput {
  goal?: string | null;
  plan?: string | null;
  phase?: string | null;
  budgetUsd?: number | null;
  steps?: { title: string; status?: StepStatus; detail?: string }[];
}

/** Declare (or replace) the goal and ordered plan for a conversation. */
export async function setExecutionPlan(conversationId: string, input: SetPlanInput): Promise<ExecutionState> {
  const now = new Date().toISOString();
  const steps: ExecutionStep[] = (input.steps ?? []).slice(0, MAX_STEPS).map((step, index) => ({
    id: `step-${index + 1}`,
    title: step.title.slice(0, 200),
    status: step.status ?? "not_started",
    detail: step.detail?.slice(0, 500),
    updatedAt: now,
  }));
  return mutate(conversationId, (state) => ({
    ...state,
    goal: input.goal !== undefined ? input.goal : state.goal,
    plan: input.plan !== undefined ? input.plan : state.plan,
    phase: input.phase !== undefined ? input.phase : state.phase,
    budgetUsd: input.budgetUsd !== undefined ? input.budgetUsd : state.budgetUsd,
    steps: input.steps ? steps : state.steps,
    currentStepId: input.steps ? (steps.find((step) => step.status === "running")?.id ?? steps[0]?.id ?? null) : state.currentStepId,
  }));
}

export interface UpdateStepInput {
  stepId?: string;
  title?: string;
  status: StepStatus;
  detail?: string;
  makeCurrent?: boolean;
}

/** Update one step by id or by exact title. Marks it current when it starts. */
export async function updateExecutionStep(conversationId: string, input: UpdateStepInput): Promise<ExecutionState> {
  const now = new Date().toISOString();
  return mutate(conversationId, (state) => {
    const steps = state.steps.map((step) => {
      const matches = input.stepId ? step.id === input.stepId : input.title ? step.title === input.title : false;
      if (!matches) return step;
      return { ...step, status: input.status, detail: input.detail?.slice(0, 500) ?? step.detail, updatedAt: now };
    });
    const target = steps.find((step) => (input.stepId ? step.id === input.stepId : step.title === input.title));
    const currentStepId = (input.makeCurrent ?? input.status === "running") && target ? target.id : state.currentStepId;
    return { ...state, steps, currentStepId };
  });
}

export interface FlagsInput {
  phase?: string | null;
  waitingForHuman?: boolean;
  waitingForTool?: boolean;
  waitingForMedia?: boolean;
  recovering?: boolean;
}

export async function setExecutionFlags(conversationId: string, flags: FlagsInput): Promise<ExecutionState> {
  return mutate(conversationId, (state) => ({
    ...state,
    phase: flags.phase !== undefined ? flags.phase : state.phase,
    waitingForHuman: flags.waitingForHuman ?? state.waitingForHuman,
    waitingForTool: flags.waitingForTool ?? state.waitingForTool,
    waitingForMedia: flags.waitingForMedia ?? state.waitingForMedia,
    recovering: flags.recovering ?? state.recovering,
  }));
}

export async function addExecutionCheckpoint(
  conversationId: string,
  label: string,
  data?: Record<string, unknown>,
): Promise<ExecutionState> {
  const checkpoint: ExecutionCheckpoint = {
    id: crypto.randomUUID(),
    label: label.slice(0, 200),
    createdAt: new Date().toISOString(),
    ...(data ? { data } : {}),
  };
  return mutate(conversationId, (state) => ({
    ...state,
    checkpoints: [...state.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS),
  }));
}

export async function clearExecutionState(conversationId: string): Promise<void> {
  await serial(async () => {
    const store = await read();
    if (store.conversations[conversationId]) {
      delete store.conversations[conversationId];
      await write(store);
    }
  });
}

/** 0-100 completion, derived from step statuses (done/skipped count as complete). */
export function executionCompletionPct(state: ExecutionState): number {
  if (!state.steps.length) return state.goal ? 0 : 0;
  const complete = state.steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return Math.round((complete / state.steps.length) * 100);
}

export function currentStepTitle(state: ExecutionState): string | null {
  const current = state.steps.find((step) => step.id === state.currentStepId)
    ?? state.steps.find((step) => step.status === "running")
    ?? state.steps.find((step) => step.status === "not_started");
  return current?.title ?? null;
}

export function isExecutionBlocked(state: ExecutionState): boolean {
  return state.steps.some((step) => step.status === "blocked")
    || state.waitingForHuman
    || state.waitingForTool
    || state.waitingForMedia;
}
