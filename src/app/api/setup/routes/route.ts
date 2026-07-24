import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { readLimitedJson } from "@/lib/setup-api";
import { resolveActiveProviderId, saveCapabilityRoutes } from "@/lib/setup-state";
import type { Capability, CapabilityRoute } from "@/lib/providers/types";
import { assertAllowedCapabilityRoute, requireProvider } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request, "json");
  if (rejected) return rejected;
  const parsed = await readLimitedJson(request);
  if (!parsed.ok) return parsed.response;

  const providerId = typeof parsed.body?.providerId === "string" ? parsed.body.providerId.trim() : undefined;
  const activeId = resolveActiveProviderId(providerId);
  const provider = requireProvider(activeId);

  const selectedModels = (parsed.body?.selectedModels ?? {}) as Partial<Record<Capability, string>>;
  const routesInput = (parsed.body?.routes ?? {}) as Partial<Record<Capability, CapabilityRoute>>;

  const newRoutes: Partial<Record<Capability, CapabilityRoute>> = {};

  for (const [cap, modelId] of Object.entries(selectedModels)) {
    if (typeof modelId === "string" && modelId && provider.capabilities.includes(cap as Capability)) {
      const route: CapabilityRoute = {
        capability: cap as Capability,
        providerId: activeId,
        modelId,
      };
      assertAllowedCapabilityRoute(route);
      newRoutes[cap as Capability] = route;
    }
  }

  for (const [cap, route] of Object.entries(routesInput)) {
    if (route && typeof route === "object" && provider.capabilities.includes(cap as Capability)) {
      assertAllowedCapabilityRoute(route);
      newRoutes[cap as Capability] = route;
    }
  }

  const status = saveCapabilityRoutes(newRoutes, activeId);
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
