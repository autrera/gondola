import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Durable failure journal. Instead of the agent guessing "I think that failed
// twice", the runtime records each operational failure by capability + pattern
// category, coalescing repeats into a count and tracking whether it was later
// recovered. This is what the Runtime Introspection layer exposes as the
// authoritative failure history, and what the Lab should reason about at the
// pattern level (e.g. "async job detached from execution state" x3), not raw
// one-off errors.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "failure-journal.json");
const MAX_RECORDS = 300;

export type FailureStatus = "open" | "recovered" | "abandoned";

// Coarse, harness-level categories. These describe the *pattern*, which is what
// the outer loop can actually act on, rather than a specific provider message.
export type FailureCategory =
  | "provider_4xx"
  | "provider_5xx"
  | "timeout"
  | "rate_limit"
  | "tool_schema"
  | "detached_async"
  | "missing_capability"
  | "budget"
  | "permission"
  | "network"
  | "unknown";

export const FAILURE_CATEGORIES: FailureCategory[] = [
  "provider_4xx",
  "provider_5xx",
  "timeout",
  "rate_limit",
  "tool_schema",
  "detached_async",
  "missing_capability",
  "budget",
  "permission",
  "network",
  "unknown",
];

export interface FailureRecord {
  id: string;
  conversationId?: string;
  capability: string;
  category: FailureCategory;
  count: number;
  status: FailureStatus;
  lastError?: string;
  firstAt: string;
  lastAt: string;
}

interface FailureStore {
  version: 1;
  records: FailureRecord[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<FailureStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<FailureStore>;
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { version: 1, records: [] };
  }
}

async function write(store: FailureStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  if (store.records.length > MAX_RECORDS) store.records = store.records.slice(-MAX_RECORDS);
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, FILE);
}

/** Best-effort classification of an arbitrary error into a pattern category. */
export function classifyFailure(error: unknown, status?: number): FailureCategory {
  if (typeof status === "number") {
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "permission";
    if (status === 402) return "budget";
    if (status >= 500) return "provider_5xx";
    if (status >= 400) return "provider_4xx";
  }
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!message) return "unknown";
  if (/time?d?\s*out|timeout|deadline/.test(message)) return "timeout";
  if (/rate limit|too many requests|429/.test(message)) return "rate_limit";
  if (/unauthorized|forbidden|permission|api key/.test(message)) return "permission";
  if (/budget|insufficient|payment|402/.test(message)) return "budget";
  if (/schema|invalid (?:argument|parameter|field)|validation|400/.test(message)) return "tool_schema";
  if (/network|fetch failed|econn|socket|dns/.test(message)) return "network";
  if (/no .*tool|missing .*capability|not supported|cannot .*(retrieve|find)/.test(message)) return "missing_capability";
  if (/5\d\d|server error|internal error/.test(message)) return "provider_5xx";
  if (/4\d\d|bad request/.test(message)) return "provider_4xx";
  return "unknown";
}

export interface RecordFailureInput {
  capability: string;
  category?: FailureCategory;
  error?: unknown;
  status?: number;
  conversationId?: string;
}

/**
 * Record a failure, coalescing with an existing OPEN record for the same
 * capability + category so repeats become a count (the pattern), not noise.
 */
export async function recordFailure(input: RecordFailureInput): Promise<FailureRecord> {
  const category = input.category ?? classifyFailure(input.error, input.status);
  const lastError = input.error instanceof Error
    ? input.error.message.slice(0, 300)
    : input.error != null
      ? String(input.error).slice(0, 300)
      : undefined;
  const now = new Date().toISOString();
  return serial(async () => {
    const store = await read();
    const existing = store.records.find(
      (record) => record.status === "open"
        && record.capability === input.capability
        && record.category === category,
    );
    if (existing) {
      existing.count += 1;
      existing.lastAt = now;
      if (lastError) existing.lastError = lastError;
      await write(store);
      return existing;
    }
    const record: FailureRecord = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      capability: input.capability,
      category,
      count: 1,
      status: "open",
      lastError,
      firstAt: now,
      lastAt: now,
    };
    store.records.push(record);
    await write(store);
    return record;
  });
}

/** Mark the most recent open record for a capability (optionally category) recovered. */
export async function markFailureRecovered(capability: string, category?: FailureCategory): Promise<void> {
  await serial(async () => {
    const store = await read();
    const open = [...store.records]
      .reverse()
      .find((record) => record.status === "open" && record.capability === capability && (!category || record.category === category));
    if (open) {
      open.status = "recovered";
      open.lastAt = new Date().toISOString();
      await write(store);
    }
  });
}

export interface ListFailuresOptions {
  conversationId?: string;
  status?: FailureStatus;
  limit?: number;
}

export async function listFailures(options?: ListFailuresOptions): Promise<FailureRecord[]> {
  const store = await read();
  let records = store.records;
  if (options?.conversationId) records = records.filter((record) => record.conversationId === options.conversationId);
  if (options?.status) records = records.filter((record) => record.status === options.status);
  const sorted = [...records].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return options?.limit ? sorted.slice(0, options.limit) : sorted;
}

/** Recurring open patterns (count >= threshold) — the ones worth flagging to the Lab. */
export async function recurringFailurePatterns(threshold = 2): Promise<FailureRecord[]> {
  const store = await read();
  return store.records
    .filter((record) => record.status === "open" && record.count >= threshold)
    .sort((a, b) => b.count - a.count);
}
