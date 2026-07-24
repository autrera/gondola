import { NextResponse } from "next/server";
import { resolveCredential } from "@/lib/credential-store";
import { requireProvider, resolveCapabilityRoute, resolveDefaultProviderId } from "@/lib/providers/registry";
import { rejectUntrustedLocalRequest } from "@/lib/request-security";
import { toPublicError } from "@/lib/venice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PublicModel {
  id: string;
  type: string;
  name: string;
  beta?: boolean;
  privacy?: string;
  capabilities?: Record<string, boolean | number | string | string[]> | string[];
  constraints?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  traits?: string[];
  voices?: string[];
  defaultVoice?: string;
}

const catalogCache = globalThis as typeof globalThis & {
  __providerModelCatalog?: Record<string, { models: PublicModel[]; checkedAt: string; expiresAt: number }>;
};

export async function GET(request: Request) {
  const rejected = rejectUntrustedLocalRequest(request);
  if (rejected) return rejected;

  const url = new URL(request.url);
  const providerId = url.searchParams.get("provider") || url.searchParams.get("providerId") || resolveDefaultProviderId((id) => Boolean(resolveCredential(id)));

  if (!catalogCache.__providerModelCatalog) {
    catalogCache.__providerModelCatalog = {};
  }
  const cached = catalogCache.__providerModelCatalog[providerId];
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(
      { connected: true, providerId, models: cached.models, checkedAt: cached.checkedAt, cached: true },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  }

  try {
    const credential = resolveCredential(providerId);
    if (!credential) {
      return NextResponse.json(
        { connected: false, error: `${providerId.toUpperCase()}_API_KEY is not configured` },
        { status: 400 },
      );
    }
    const adapter = requireProvider(providerId);
    const rawModels = await adapter.listModels(credential);
    const models: PublicModel[] = rawModels.map((model) => ({
      id: model.id,
      type: model.type,
      name: model.name,
      beta: model.beta,
      privacy: model.privacy,
      capabilities: model.capabilitiesObject ?? (
        Array.isArray(model.capabilities)
          ? {
              supportsFunctionCalling: model.type === "text",
              supportsVision: model.capabilities.includes("vision"),
              supportsReasoning: model.capabilities.includes("reasoning"),
            }
          : model.capabilities
      ),
      constraints: model.constraints,
      pricing: model.pricing,
      traits: model.traits,
      voices: model.voices,
      defaultVoice: model.defaultVoice,
    }));

    const checkedAt = new Date().toISOString();
    catalogCache.__providerModelCatalog[providerId] = { models, checkedAt, expiresAt: Date.now() + 5 * 60_000 };
    return NextResponse.json(
      { connected: true, providerId, models, checkedAt },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  } catch (error) {
    if (cached) {
      return NextResponse.json(
        { connected: true, providerId, models: cached.models, checkedAt: cached.checkedAt, cached: true, stale: true },
        { headers: { "Cache-Control": "private, max-age=30" } },
      );
    }
    const publicError = toPublicError(error);
    return NextResponse.json(
      { connected: false, error: publicError.message, requestId: publicError.requestId },
      { status: publicError.status },
    );
  }
}
