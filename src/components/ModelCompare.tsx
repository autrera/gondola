import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogModel } from "@/lib/app-types";
import { CheckIcon, CloseIcon, PlusIcon } from "./Icons";

interface ModelCompareProps {
  open: boolean;
  onClose: () => void;
  models: CatalogModel[];
  initialModels?: string[];
  initialPrompt?: string;
}

type ColumnStatus = "idle" | "streaming" | "done" | "error";

interface Column {
  key: string;
  model: string;
  text: string;
  status: ColumnStatus;
  ms?: number;
  firstTokenMs?: number;
  tokens?: number;
  error?: string;
}

const MIN_COLUMNS = 2;
const MAX_COLUMNS = 4;

let keySeq = 0;
const nextKey = () => `mc-${(keySeq += 1)}`;

function chooseModels(preferred: string[] | undefined, available: string[], count: number): string[] {
  const picks: string[] = [];
  for (const id of preferred ?? []) {
    if (available.includes(id) && !picks.includes(id)) picks.push(id);
  }
  for (const id of available) {
    if (picks.length >= count) break;
    if (!picks.includes(id)) picks.push(id);
  }
  while (picks.length < count && available.length) picks.push(available[picks.length % available.length]);
  return picks.slice(0, count);
}

const CSS = `
.mc-scrim { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 24px; background: rgba(4,5,9,.62); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: mc-fade .16s ease; }
@keyframes mc-fade { from { opacity: 0; } to { opacity: 1; } }
.mc-panel { display: flex; flex-direction: column; width: 100%; max-width: 1440px; height: min(90vh, 920px); border: 1px solid var(--line); border-radius: 22px; background: linear-gradient(160deg, rgba(20,22,28,.98), rgba(8,9,13,.99)); box-shadow: var(--shadow), 0 40px 100px -34px rgba(0,0,0,.85), inset 0 1px rgba(255,255,255,.025); overflow: hidden; }

.mc-head { display: flex; align-items: flex-start; gap: 14px; padding: 18px 20px 16px; border-bottom: 1px solid var(--line); }
.mc-head-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.mc-kicker { color: var(--mint); font-size: 8px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
.mc-head h2 { margin: 0; color: var(--ink); font-size: 17px; font-weight: 640; letter-spacing: -.02em; }
.mc-head p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-size: 11.5px; }
.mc-close { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); background: transparent; cursor: pointer; transition: color .14s, background .14s, border-color .14s; }
.mc-close:hover { color: var(--ink); border-color: var(--line-bright); background: rgba(255,255,255,.05); }

.mc-prompt { display: flex; align-items: flex-end; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.mc-prompt textarea { flex: 1; min-height: 48px; max-height: 168px; resize: none; padding: 13px 14px; border: 1px solid var(--line); border-radius: 13px; color: var(--ink); background: rgba(255,255,255,.025); font: inherit; font-size: 13.5px; line-height: 1.5; outline: none; transition: border-color .14s, background .14s, box-shadow .14s; }
.mc-prompt textarea:focus { border-color: rgba(184,207,232,.5); background: rgba(255,255,255,.045); box-shadow: 0 0 0 3px rgba(184,207,232,.12); }
.mc-prompt textarea::placeholder { color: var(--faint); }
.mc-run { flex: 0 0 auto; height: 48px; min-width: 104px; padding: 0 24px; border: 0; border-radius: 13px; color: #11151b; background: linear-gradient(145deg, #f7f6f2, #b7c9dd); box-shadow: 0 8px 22px -10px rgba(171,195,222,.55); font: inherit; font-size: 13px; font-weight: 660; cursor: pointer; transition: transform .14s, filter .14s, box-shadow .14s; }
.mc-run:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.03); box-shadow: 0 12px 26px -10px rgba(171,195,222,.7); }
.mc-run:disabled { opacity: .4; cursor: default; }
.mc-run.is-stop { color: var(--ink); background: rgba(255,255,255,.06); border: 1px solid var(--line); box-shadow: none; }
.mc-run.is-stop:hover { background: rgba(255,255,255,.1); border-color: var(--line-bright); }

.mc-cols { flex: 1; min-height: 0; display: flex; gap: 12px; padding: 16px 20px 20px; overflow-x: auto; scrollbar-width: thin; }
.mc-col { flex: 1 1 0; min-width: 300px; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: linear-gradient(160deg, rgba(255,255,255,.022), rgba(255,255,255,.006)); overflow: hidden; transition: border-color .15s, box-shadow .15s; }
.mc-col:hover { border-color: var(--line-bright); }
.mc-col.is-fastest { border-color: rgba(184,207,232,.42); box-shadow: inset 0 0 0 1px rgba(184,207,232,.12), 0 18px 40px -28px rgba(184,207,232,.5); }
.mc-col-head { display: flex; align-items: center; gap: 6px; padding: 8px 6px 8px 6px; border-bottom: 1px solid var(--line); }
.mc-select { flex: 1; min-width: 0; height: 30px; padding: 0 24px 0 8px; border: 1px solid transparent; border-radius: 8px; color: var(--ink); font: inherit; font-size: 12.5px; font-weight: 620; cursor: pointer; appearance: none; -webkit-appearance: none; text-overflow: ellipsis; background-color: transparent; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a93a0' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; transition: background-color .14s, border-color .14s; }
.mc-select:hover { background-color: rgba(255,255,255,.045); }
.mc-select:focus { outline: none; background-color: rgba(255,255,255,.045); border-color: rgba(184,207,232,.45); }
.mc-select option { color: var(--ink); background: #14161a; font-weight: 500; }
.mc-status { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; padding-right: 2px; color: var(--faint); font-size: 9.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.mc-status .mc-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.mc-status.is-streaming { color: var(--aqua); }
.mc-status.is-done { color: #8bbf9d; }
.mc-status.is-error { color: var(--coral); }
.mc-status.is-streaming .mc-dot { animation: mc-pulse 1s ease-in-out infinite; }
@keyframes mc-pulse { 0%,100% { opacity: .35; transform: scale(.82); } 50% { opacity: 1; transform: scale(1); } }
.mc-remove { flex: 0 0 auto; width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 7px; color: var(--faint); background: transparent; cursor: pointer; opacity: 0; transition: color .14s, background .14s, opacity .14s; }
.mc-col:hover .mc-remove { opacity: 1; }
.mc-remove:hover { color: var(--coral); background: rgba(255,142,122,.1); }
.mc-remove:disabled { opacity: 0; }

.mc-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 15px; color: #ccd2da; font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.13) transparent; }
.mc-body::-webkit-scrollbar { width: 9px; }
.mc-body::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 99px; background-clip: padding-box; background-color: rgba(255,255,255,.12); }
.mc-body::-webkit-scrollbar-thumb:hover { background-color: rgba(255,255,255,.2); }
.mc-body.is-empty { display: grid; place-items: center; padding: 24px; color: var(--faint); font-size: 12px; line-height: 1.5; text-align: center; }
.mc-body.is-error { color: var(--coral); }
.mc-caret { display: inline-block; width: 6px; height: 15px; margin-left: 2px; background: var(--mint); border-radius: 1px; vertical-align: text-bottom; animation: mc-blink 1s step-end infinite; }
@keyframes mc-blink { 50% { opacity: 0; } }

.mc-foot { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 6px 8px 6px 14px; border-top: 1px solid var(--line); }
.mc-fast { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 8px; border-radius: 999px; color: var(--mint); background: rgba(184,207,232,.1); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.mc-fast::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 6px rgba(184,207,232,.75); }
.mc-metrics { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; color: #656d79; font-size: 10.5px; }
.mc-metrics span { display: inline-flex; align-items: center; gap: 4px; }
.mc-metrics span + span::before { content: "·"; margin-right: 8px; color: #3d444e; }
.mc-metrics b { color: #98a1ad; font-weight: 650; font-variant-numeric: tabular-nums; }
.mc-copy { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: transparent; font: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer; transition: color .14s, border-color .14s, background .14s; }
.mc-copy:hover:not(:disabled) { color: var(--ink); border-color: var(--line-bright); background: rgba(255,255,255,.05); }
.mc-copy:disabled { opacity: .35; cursor: default; }
.mc-copy.is-copied { color: #8bbf9d; border-color: rgba(139,191,157,.32); }

.mc-add { flex: 0 0 46px; align-self: stretch; display: grid; place-items: center; border: 1px dashed var(--line-bright); border-radius: 16px; color: var(--faint); background: transparent; cursor: pointer; transition: color .14s, border-color .14s, background .14s; }
.mc-add:hover:not(:disabled) { color: var(--ink); border-color: rgba(184,207,232,.45); background: rgba(184,207,232,.06); }
.mc-add:disabled { opacity: .4; cursor: default; }

@media (max-width: 720px) {
  .mc-col { min-width: 80vw; }
  .mc-add { flex-basis: 44px; }
}
`;

export function ModelCompare({ open, onClose, models, initialModels, initialPrompt }: ModelCompareProps) {
  const textModels = useMemo(
    () => models.filter((model) => model.type === "text").sort((a, b) => a.name.localeCompare(b.name)),
    [models],
  );
  const availableIds = useMemo(() => textModels.map((model) => model.id), [textModels]);

  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [columns, setColumns] = useState<Column[]>([]);
  const [running, setRunning] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const controllersRef = useRef<AbortController[]>([]);
  const columnsRef = useRef<Column[]>([]);
  columnsRef.current = columns;

  // Seed columns with sensible defaults once models are available / on open.
  useEffect(() => {
    if (!open || !availableIds.length) return;
    setColumns((current) => {
      if (current.some((column) => column.model)) return current;
      return chooseModels(initialModels, availableIds, 3).map((model) => ({ key: nextKey(), model, text: "", status: "idle" as const }));
    });
  }, [open, availableIds, initialModels]);

  useEffect(() => {
    if (open && initialPrompt) setPrompt((current) => current || initialPrompt);
  }, [open, initialPrompt]);

  const stopAll = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current = [];
    setRunning(false);
    setColumns((current) => current.map((column) => (column.status === "streaming" ? { ...column, status: column.text ? "done" : "idle" } : column)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => () => controllersRef.current.forEach((controller) => controller.abort()), []);

  const patch = useCallback((key: string, update: (column: Column) => Column) => {
    setColumns((current) => current.map((column) => (column.key === key ? update(column) : column)));
  }, []);

  const runColumn = useCallback(async (key: string, model: string, text: string, controller: AbortController) => {
    const startedAt = Date.now();
    try {
      const response = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, model }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        patch(key, (column) => ({ ...column, status: "error", error: payload.error ?? `Request failed (${response.status}).` }));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: { type?: string; delta?: string; ms?: number; firstTokenMs?: number; usage?: { output?: number }; message?: string };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === "delta" && event.delta) {
            patch(key, (column) => ({ ...column, text: column.text + event.delta, status: "streaming" }));
          } else if (event.type === "done") {
            patch(key, (column) => ({ ...column, status: "done", ms: event.ms ?? Date.now() - startedAt, firstTokenMs: event.firstTokenMs, tokens: event.usage?.output }));
          } else if (event.type === "error") {
            patch(key, (column) => ({ ...column, status: "error", error: event.message ?? "The model returned an error." }));
          }
        }
      }
      patch(key, (column) => (column.status === "streaming" ? { ...column, status: "done", ms: Date.now() - startedAt } : column));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      patch(key, (column) => ({ ...column, status: "error", error: "The request could not be completed." }));
    }
  }, [patch]);

  const run = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current = [];
    const active = columnsRef.current.filter((column) => column.model);
    if (!active.length) return;
    setRunning(true);
    setColumns((current) => current.map((column) => (column.model ? { ...column, text: "", status: "streaming", ms: undefined, firstTokenMs: undefined, tokens: undefined, error: undefined } : column)));
    await Promise.all(active.map((column) => {
      const controller = new AbortController();
      controllersRef.current.push(controller);
      return runColumn(column.key, column.model, text, controller);
    }));
    setRunning(false);
  }, [prompt, runColumn]);

  const copyColumn = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? "" : current)), 1400);
    } catch {
      // Clipboard blocked; nothing else to do.
    }
  }, []);

  if (!open) return null;

  const modelName = (id: string) => textModels.find((model) => model.id === id)?.name ?? id;

  // Once at least two columns finish, flag the quickest so the comparison has a
  // clear, at-a-glance takeaway.
  const doneDurations = columns.filter((column) => column.status === "done" && typeof column.ms === "number").map((column) => column.ms as number);
  const fastestMs = doneDurations.length >= 2 ? Math.min(...doneDurations) : undefined;

  return (
    <div className="mc-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <section className="mc-panel" role="dialog" aria-modal="true" aria-label="Compare models">
        <header className="mc-head">
          <div className="mc-head-titles">
            <span className="mc-kicker">Compare</span>
            <h2>Models, side by side</h2>
            <p>One prompt, every model at once. Isolated from your chats, nothing is saved.</p>
          </div>
          <button className="mc-close" onClick={onClose} aria-label="Close comparison"><CloseIcon size={16} /></button>
        </header>

        <div className="mc-prompt">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void run(); }
            }}
            placeholder="Ask the same thing of every model… (⌘/Ctrl + Enter to run)"
            rows={2}
          />
          {running
            ? <button className="mc-run is-stop" onClick={stopAll}>Stop</button>
            : <button className="mc-run" onClick={() => void run()} disabled={!prompt.trim() || !columns.some((column) => column.model)}>Run</button>}
        </div>

        <div className="mc-cols">
          {columns.map((column) => {
            const isFastest = fastestMs !== undefined && column.status === "done" && column.ms === fastestMs;
            return (
              <div className={`mc-col${isFastest ? " is-fastest" : ""}`} key={column.key}>
                <div className="mc-col-head">
                  <select
                    className="mc-select"
                    value={column.model}
                    onChange={(event) => patch(column.key, (current) => ({ ...current, model: event.target.value }))}
                    disabled={running}
                    aria-label="Model"
                  >
                    {!availableIds.includes(column.model) && column.model && <option value={column.model}>{column.model}</option>}
                    {textModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}{model.privacy === "private" ? " · private" : ""}
                      </option>
                    ))}
                  </select>
                  <span className={`mc-status is-${column.status}`}>
                    <span className="mc-dot" />
                    {column.status === "streaming" ? "Running" : column.status === "done" ? "Done" : column.status === "error" ? "Error" : "Idle"}
                  </span>
                  {columns.length > MIN_COLUMNS && (
                    <button className="mc-remove" onClick={() => setColumns((current) => current.filter((other) => other.key !== column.key))} disabled={running} aria-label="Remove model"><CloseIcon size={13} /></button>
                  )}
                </div>
                <div className={`mc-body${column.status === "error" ? " is-error" : ""}${!column.text && column.status !== "error" ? " is-empty" : ""}`}>
                  {column.status === "error"
                    ? (column.error ?? "Something went wrong.")
                    : column.text
                      ? (<>{column.text}{column.status === "streaming" && <span className="mc-caret" />}</>)
                      : (running ? "Waiting for the first token…" : "Run a prompt to see this model's answer.")}
                </div>
                <div className="mc-foot">
                  {isFastest && <span className="mc-fast">Fastest</span>}
                  <div className="mc-metrics">
                    {column.ms !== undefined && <span><b>{(column.ms / 1000).toFixed(1)}s</b> total</span>}
                    {column.firstTokenMs !== undefined && <span><b>{(column.firstTokenMs / 1000).toFixed(1)}s</b> first token</span>}
                    {column.tokens !== undefined && <span><b>{column.tokens}</b> tokens</span>}
                  </div>
                  <button
                    className={`mc-copy${copiedKey === column.key ? " is-copied" : ""}`}
                    onClick={() => void copyColumn(column.key, column.text)}
                    disabled={!column.text}
                    aria-label={`Copy ${modelName(column.model)} answer`}
                  >
                    {copiedKey === column.key ? <><CheckIcon size={11} /> Copied</> : "Copy"}
                  </button>
                </div>
              </div>
            );
          })}
          {columns.length < MAX_COLUMNS && (
            <button
              className="mc-add"
              onClick={() => setColumns((current) => [...current, { key: nextKey(), model: chooseModels(undefined, availableIds.filter((id) => !current.some((column) => column.model === id)), 1)[0] ?? availableIds[0] ?? "", text: "", status: "idle" }])}
              disabled={running}
              aria-label="Add a model column"
              title="Add a model"
            >
              <PlusIcon size={18} />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
