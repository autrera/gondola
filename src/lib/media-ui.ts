import type { MediaArtifact } from "./app-types";

// Pure helpers shared by the media UI, kept out of the component so the
// retrieval-ownership decision and status mapping can be unit tested.

export type RetrievalMode = "gondola" | "legacy" | "none";

/**
 * Decide how the UI should resolve a media artifact:
 * - "gondola": a durable task exists, so observe /api/media/task (never Venice);
 * - "legacy": an old job with only a provider queue id, use the legacy route;
 * - "none": nothing to poll (e.g. a ready image or an unqueued quote).
 */
export function chooseRetrievalMode(artifact: Pick<MediaArtifact, "kind" | "taskId" | "queueId">): RetrievalMode {
  if (artifact.taskId) return "gondola";
  if ((artifact.kind === "video" || artifact.kind === "music") && artifact.queueId) return "legacy";
  return "none";
}

export interface TaskStatusView {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  assetId?: string;
  assetUrl?: string;
  error?: string;
}

export interface ArtifactPatch {
  status: MediaArtifact["status"];
  url?: string;
  assetId?: string;
  message?: string;
  progress?: number;
  terminal: boolean;
}

/** Map a durable task status view onto the artifact fields the UI renders. */
export function taskViewToArtifactPatch(view: TaskStatusView, attempt: number): ArtifactPatch {
  switch (view.status) {
    case "succeeded":
      return { status: "ready", url: view.assetUrl, assetId: view.assetId, progress: 100, terminal: true };
    case "failed":
      return { status: "error", message: view.error ?? "Media generation failed.", terminal: true };
    case "cancelled":
      return { status: "error", message: "This media task was cancelled.", terminal: true };
    default:
      return { status: "processing", progress: Math.min(90, Math.max(6, attempt * 6)), terminal: false };
  }
}
