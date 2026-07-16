import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Durable project asset manifest.
//
// Every artifact the agent generates, downloads, edits, analyzes, or composes
// is registered here so later steps and later phases (budget, composition,
// taste learning) can reference stable ids and paths instead of shoving binary
// content through the model context.

const ROOT = path.join(process.cwd(), ".gondola");
const FILE = path.join(ROOT, "assets.json");
const MAX_ASSETS = 2_000;

export type AssetKind = "image" | "video" | "audio" | "document" | "subtitle";
export type AssetStatus = "draft" | "approved" | "rejected" | "final";

export interface ProjectAsset {
  id: string;
  projectId?: string;
  kind: AssetKind;
  path?: string;
  url?: string;
  sourceTaskId?: string;
  parentAssetIds?: string[];
  prompt?: string;
  model?: string;
  version: number;
  status: AssetStatus;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface AssetStore {
  version: 1;
  assets: ProjectAsset[];
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function read(): Promise<AssetStore> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Partial<AssetStore>;
    return { version: 1, assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
  } catch {
    return { version: 1, assets: [] };
  }
}

async function write(store: AssetStore): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temporary, FILE);
}

export interface RegisterAssetInput {
  kind: AssetKind;
  projectId?: string;
  path?: string;
  url?: string;
  sourceTaskId?: string;
  parentAssetIds?: string[];
  prompt?: string;
  model?: string;
  version?: number;
  status?: AssetStatus;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  metadata?: Record<string, unknown>;
}

export async function registerAsset(input: RegisterAssetInput): Promise<ProjectAsset> {
  const now = new Date().toISOString();
  const asset: ProjectAsset = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    kind: input.kind,
    path: input.path,
    url: input.url,
    sourceTaskId: input.sourceTaskId,
    parentAssetIds: input.parentAssetIds,
    prompt: input.prompt,
    model: input.model,
    version: input.version ?? 1,
    status: input.status ?? "draft",
    estimatedCostUsd: input.estimatedCostUsd,
    actualCostUsd: input.actualCostUsd,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
  return serial(async () => {
    const store = await read();
    store.assets.push(asset);
    if (store.assets.length > MAX_ASSETS) store.assets = store.assets.slice(-MAX_ASSETS);
    await write(store);
    return asset;
  });
}

export async function getAsset(id: string): Promise<ProjectAsset | undefined> {
  const store = await read();
  return store.assets.find((asset) => asset.id === id);
}

export async function listAssets(filter?: { kind?: AssetKind; projectId?: string; limit?: number }): Promise<ProjectAsset[]> {
  const store = await read();
  let assets = store.assets;
  if (filter?.kind) assets = assets.filter((asset) => asset.kind === filter.kind);
  if (filter?.projectId) assets = assets.filter((asset) => asset.projectId === filter.projectId);
  const sorted = [...assets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return filter?.limit ? sorted.slice(0, filter.limit) : sorted;
}

export async function updateAsset(id: string, patch: Partial<Omit<ProjectAsset, "id" | "createdAt">>): Promise<ProjectAsset | undefined> {
  return serial(async () => {
    const store = await read();
    const index = store.assets.findIndex((asset) => asset.id === id);
    if (index === -1) return undefined;
    const next: ProjectAsset = { ...store.assets[index], ...patch, id, updatedAt: new Date().toISOString() };
    store.assets[index] = next;
    await write(store);
    return next;
  });
}

export async function deleteAsset(id: string): Promise<boolean> {
  return serial(async () => {
    const store = await read();
    const before = store.assets.length;
    store.assets = store.assets.filter((asset) => asset.id !== id);
    if (store.assets.length === before) return false;
    await write(store);
    return true;
  });
}
