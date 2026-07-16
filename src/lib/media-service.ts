import { parseVeniceJson, veniceFetch } from "./venice";

// Shared Venice media retrieval, used by both the client route
// (src/app/api/media/retrieve/route.ts) and the agent-owned media task
// lifecycle (media-tasks.ts). Keeping this in one place means the polling and
// download rules stay identical no matter who awaits the job.

const PRIVATE_SHARE_HOST = "private-share.venice.ai";

// Statuses Venice returns for a finished-but-not-successful job.
export const TERMINAL_FAILURE_STATUSES = new Set([
  "FAILED",
  "ERROR",
  "CANCELLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

export function isTerminalFailureStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_FAILURE_STATUSES.has(status.toUpperCase());
}

export function isCompletedStatus(status: unknown): boolean {
  return typeof status === "string" && status.toUpperCase() === "COMPLETED";
}

export interface MediaRetrieveInput {
  kind: "video" | "music";
  model: string;
  queueId: string;
  /** One-time private-share URL returned by Venice at queue time (video). */
  downloadUrl?: string;
}

export type MediaRetrieveOutcome =
  | { state: "ready"; bytes: ArrayBuffer; contentType: string }
  | { state: "status"; body: Record<string, unknown> };

function assertPrivateShareUrl(downloadUrl: string): URL {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    throw new Error("Venice returned an invalid media URL");
  }
  // Never let this become an arbitrary URL fetch: the completed video URL must
  // be the one-time private-share link Venice issued.
  if (
    url.protocol !== "https:"
    || url.hostname !== PRIVATE_SHARE_HOST
    || (url.port && url.port !== "443")
    || !url.pathname.startsWith("/v1/share/read/")
    || url.username
    || url.password
  ) {
    throw new Error("Venice returned an invalid media URL");
  }
  return url;
}

async function downloadCompletedVideo(input: MediaRetrieveInput, downloadUrl: string, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const url = assertPrivateShareUrl(downloadUrl);
  const downloaded = await fetch(url, { cache: "no-store", signal });
  if (!downloaded.ok) throw new Error("The completed Venice video could not be downloaded");
  const contentType = downloaded.headers.get("content-type") ?? "video/mp4";
  const bytes = await downloaded.arrayBuffer();
  // Fire-and-forget completion so Venice can release the job's storage.
  void veniceFetch("/video/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, queue_id: input.queueId }),
  }, { retries: 0 }).then((completion) => completion.arrayBuffer()).catch(() => undefined);
  return { bytes, contentType };
}

/**
 * Poll a queued Venice media job once. Returns the finished binary when ready,
 * or the raw provider status object so the caller can decide whether to keep
 * polling or treat it as failed.
 */
export async function retrieveMediaOnce(input: MediaRetrieveInput, signal?: AbortSignal): Promise<MediaRetrieveOutcome> {
  const mediaPath = input.kind === "video" ? "/video/retrieve" : "/audio/retrieve";
  const response = await veniceFetch(
    mediaPath,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: input.model, queue_id: input.queueId, delete_media_on_completion: true }),
    },
    { retries: 0, signal },
  );
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
    return { state: "ready", bytes: await response.arrayBuffer(), contentType };
  }
  const body = await parseVeniceJson<Record<string, unknown>>(response);
  if (isCompletedStatus(body.status) && input.downloadUrl && input.kind === "video") {
    const downloaded = await downloadCompletedVideo(input, input.downloadUrl, signal);
    return { state: "ready", bytes: downloaded.bytes, contentType: downloaded.contentType };
  }
  return { state: "status", body };
}
