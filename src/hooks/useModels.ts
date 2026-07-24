import { useEffect, useState } from "react";
import type { CatalogModel } from "@/lib/app-types";

export interface UseModelsResult {
  models: CatalogModel[];
  loading: boolean;
  error?: string;
  connected: boolean;
  providerId?: string;
}

/**
 * Custom hook to fetch available models from /api/models.
 * Optionally accepts active providerId parameter to pass to /api/models.
 */
export function useModels(providerId?: string): UseModelsResult {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [connected, setConnected] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string | undefined>(providerId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const targetProvider = providerId ?? activeProvider;
    const url = `/api/models${targetProvider ? `?provider=${encodeURIComponent(targetProvider)}` : ""}`;
    void fetch(url)
      .then(async (response) => {
        const body = (await response.json()) as { connected?: boolean; providerId?: string; models?: CatalogModel[]; error?: string };
        if (cancelled) return;
        if (!response.ok) throw new Error(body.error ?? "Could not connect to provider");
        setModels(body.models ?? []);
        setConnected(Boolean(body.connected));
        if (body.providerId) setActiveProvider(body.providerId);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not connect to provider");
          setConnected(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [providerId, activeProvider]);

  return { models, loading, error, connected, providerId: activeProvider };
}
