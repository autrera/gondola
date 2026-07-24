"use client";

import { useCallback, useEffect, useState } from "react";
import type { SetupStatusView } from "./Onboarding";

// Phase 7: Providers and capabilities. Replaces the old Connection panel.
// Reads the local /api/setup/* routes. Shows the active provider + the model
// behind every capability, and offers test/replace/remove/rediscover/reset/
// diagnose actions. Never displays the full saved credential.

const CAPS: Array<{ key: string; label: string }> = [
  { key: "chat", label: "Conversation" },
  { key: "reasoning", label: "Reasoning" },
  { key: "vision", label: "Vision" },
  { key: "search", label: "Search" },
  { key: "transcription", label: "Transcription" },
  { key: "speech", label: "Speech" },
  { key: "image", label: "Images" },
  { key: "video", label: "Video" },
  { key: "music", label: "Music" },
  { key: "embedding", label: "Embeddings" },
];

type Busy = "" | "test" | "discover" | "reset" | "remove" | "replace" | "diagnose";

export function ProvidersPanel() {
  const [selectedProvider, setSelectedProvider] = useState<"venice" | "surplus">("venice");
  const [status, setStatus] = useState<SetupStatusView>();
  const [busy, setBusy] = useState<Busy>("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [newKey, setNewKey] = useState("");

  const providerName = selectedProvider === "surplus" ? "Surplus Intelligence" : "Venice AI";

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/setup/status?providerId=${selectedProvider}`, { cache: "no-store" });
      setStatus((await response.json()) as SetupStatusView);
    } catch {
      setError("Could not read setup status.");
    }
  }, [selectedProvider]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (action: Busy, fn: () => Promise<{ status?: SetupStatusView; note?: string; error?: string }>) => {
    setBusy(action);
    setNote("");
    setError("");
    try {
      const result = await fn();
      if (result.status) setStatus(result.status);
      if (result.note) setNote(result.note);
      if (result.error) setError(result.error);
    } catch {
      setError(`Gondola couldn't reach ${providerName}. Check your connection and try again.`);
    } finally {
      setBusy("");
    }
  }, [providerName]);

  const postJson = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return (await response.json()) as SetupStatusView;
  };

  const testConnection = () => run("test", async () => {
    const next = await postJson("/api/setup/verify", { providerId: selectedProvider });
    return { status: next, note: next.state === "ready" ? "Connection verified." : undefined, error: next.state === "ready" ? undefined : (next.message ?? "Verification failed.") };
  });

  const runDiagnostics = () => run("diagnose", async () => {
    const next = await postJson("/api/setup/verify", { providerId: selectedProvider });
    const summary = next.state === "ready"
      ? `Catalog + test completion OK. ${Object.values(next.capabilities ?? {}).filter(Boolean).length} capabilities ready.`
      : (next.message ?? "Diagnostics failed.");
    return { status: next, note: next.state === "ready" ? summary : undefined, error: next.state === "ready" ? undefined : summary };
  });

  const rediscover = () => run("discover", async () => {
    const next = await postJson("/api/setup/repair", { providerId: selectedProvider });
    return { status: next, note: next.state === "ready" ? "Model discovery refreshed." : undefined, error: next.state === "ready" ? undefined : (next.message ?? "Discovery failed.") };
  });

  const resetRoutes = () => run("reset", async () => {
    const next = await postJson("/api/setup/repair", { providerId: selectedProvider });
    return { status: next, note: next.state === "ready" ? `Capability routes reset to ${providerName} defaults.` : undefined, error: next.state === "ready" ? undefined : (next.message ?? "Reset failed.") };
  });

  const removeCredential = () => run("remove", async () => {
    const response = await fetch(`/api/setup/credentials?providerId=${selectedProvider}`, { method: "DELETE" });
    const next = (await response.json()) as SetupStatusView;
    return { status: next, note: "Local credential removed." };
  });

  const saveNewKey = () => run("replace", async () => {
    const trimmed = newKey.trim();
    if (!trimmed) return { error: "Enter a key to save." };
    const next = await postJson("/api/setup/credentials", { providerId: selectedProvider, apiKey: trimmed, override: true });
    setNewKey("");
    if (next.state === "ready") setReplacing(false);
    return { status: next, note: next.state === "ready" ? "Credential replaced." : undefined, error: next.state === "ready" ? undefined : (next.message ?? "Verification failed.") };
  });

  const connected = status?.state === "ready";
  const cred = status?.credential;
  const stateLabel = !status ? "…"
    : status.state === "ready" ? "Connected"
    : status.state === "repair_required" ? "Repair needed"
    : status.state === "not_configured" ? "Not connected"
    : status.state === "unreachable" ? "Offline"
    : "Needs verification";

  return (
    <section className="settings-group">
      <div className="settings-group-heading">
        <h3>Providers and capabilities</h3>
        <p>Manage inference providers and capability routes. Everything runs locally against your own keys.</p>
      </div>

      <nav className="prov-selector-tabs" role="tablist" aria-label="Provider sections">
        <button
          type="button"
          role="tab"
          aria-selected={selectedProvider === "venice"}
          className={`prov-tab ${selectedProvider === "venice" ? "is-active" : ""}`}
          onClick={() => { setSelectedProvider("venice"); setReplacing(false); setError(""); setNote(""); }}
        >
          Venice AI
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={selectedProvider === "surplus"}
          className={`prov-tab ${selectedProvider === "surplus" ? "is-active" : ""}`}
          onClick={() => { setSelectedProvider("surplus"); setReplacing(false); setError(""); setNote(""); }}
        >
          Surplus Intelligence
        </button>
      </nav>

      <div className="prov-header">
        <div className="prov-id">
          <span className={`prov-dot ${connected ? "is-on" : ""}`} aria-hidden="true" />
          <div>
            <strong>{providerName}</strong>
            <small>{stateLabel} · {selectedProvider === "surplus" ? "GLM 5.2, DeepSeek v4, Grok 4.5" : "Default capability layer"}</small>
          </div>
        </div>
        <div className="prov-cred">
          {cred?.configured
            ? <span>{cred.maskedSuffix} <small>({cred.source === "environment" ? "environment" : "local"})</small></span>
            : <span className="prov-muted">No credential</span>}
        </div>
      </div>

      {status?.capabilities && (
        <div className="prov-caps">
          {CAPS.map(({ key, label }) => {
            const ready = Boolean(status.capabilities?.[key]);
            const model = status.routes?.[key]?.modelId;
            return (
              <div key={key} className={`prov-cap ${ready ? "is-ready" : "is-off"}`}>
                <span className="prov-cap-label">{label}</span>
                <span className="prov-cap-model">{ready ? (model ?? providerName) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}

      {replacing && (
        <label className="settings-field">
          <span className="field-heading"><span>New {providerName} key</span><small>Overrides the environment key</small></span>
          <input type="password" autoComplete="off" spellCheck={false} placeholder={`${providerName} API key`} value={newKey} onChange={(event) => setNewKey(event.target.value)} />
        </label>
      )}

      <div className="prov-actions">
        <button className="prov-btn" disabled={busy !== ""} onClick={testConnection}>{busy === "test" ? "Testing…" : "Test"}</button>
        <button className="prov-btn" disabled={busy !== ""} onClick={runDiagnostics}>{busy === "diagnose" ? "Diagnosing…" : "Diagnose"}</button>
        <button className="prov-btn" disabled={busy !== ""} onClick={rediscover}>{busy === "discover" ? "Discovering…" : "Rediscover"}</button>
        <button className="prov-btn" disabled={busy !== ""} onClick={resetRoutes}>{busy === "reset" ? "Resetting…" : "Reset routes"}</button>
        {replacing
          ? <button className="prov-btn is-primary" disabled={busy !== ""} onClick={saveNewKey}>{busy === "replace" ? "Saving…" : "Save"}</button>
          : <button className="prov-btn" disabled={busy !== ""} onClick={() => setReplacing(true)}>Replace</button>}
        {cred?.hasFile && <button className="prov-btn is-danger" disabled={busy !== ""} onClick={removeCredential}>{busy === "remove" ? "Removing…" : "Remove"}</button>}
      </div>

      {note && <p className="prov-note">{note}</p>}
      {error && <p className="prov-error" role="alert">{error}</p>}
    </section>
  );
}
