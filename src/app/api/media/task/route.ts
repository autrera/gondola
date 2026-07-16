import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { awaitMediaTask, getMediaTask, toTaskStatusView } from "@/lib/media-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UI-safe durable media task status. The browser polls this instead of calling
// the Venice retrieval endpoint directly. For a task still in flight, this kicks
// the idempotent shared retrieval so progress is made whether or not the agent
// is also awaiting; because retrieval has a single owner, Venice is still polled
// only once and one asset is registered.
export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "A task id is required" }, { status: 400 });

  const task = await getMediaTask(id);
  if (!task) return Response.json({ error: "Task not found" }, { status: 404 });

  if (task.status === "queued" || task.status === "running") {
    // Fire-and-forget: drive the shared retrieval, but do not hold the request.
    void awaitMediaTask(id).catch(() => undefined);
  }

  const latest = (await getMediaTask(id)) ?? task;
  return Response.json(toTaskStatusView(latest), { headers: { "Cache-Control": "no-store" } });
}
