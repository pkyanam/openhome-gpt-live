import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  CHATGPT_REALTIME_VOICES,
  connectChatGPTRealtimeAppServer,
  type ChatGPTRealtimeAppServerConnection,
  type ChatGPTRealtimeAppServerEvent,
  type ChatGPTRealtimeState,
} from "@opencoredev/loginwithchatgpt-core";
import { LoginWithChatGPT } from "@opencoredev/loginwithchatgpt-react";

interface TranscriptLine {
  id: number;
  kind: "user_transcript" | "assistant_caption";
  text: string;
}

interface ActivityLine {
  id: number;
  text: string;
  tone: "neutral" | "good" | "warn";
}

interface PendingConfirmation {
  callId: string;
  name: string;
  review: unknown;
}

type UiState = ChatGPTRealtimeState | "closed" | "failed";

let nextLineId = 1;

export function App() {
  const liveRef = useRef<ChatGPTRealtimeAppServerConnection | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("juniper");
  const [state, setState] = useState<UiState>("closed");
  const [connecting, setConnecting] = useState(false);
  const [inputMuted, setInputMuted] = useState(false);
  const [outputMuted, setOutputMuted] = useState(false);
  const [relayText, setRelayText] = useState("");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  const [pending, setPending] = useState<PendingConfirmation[]>([]);
  const [error, setError] = useState<string>();

  const addActivity = useCallback((text: string, tone: ActivityLine["tone"] = "neutral") => {
    setActivity((current) => [
      { id: nextLineId++, text, tone },
      ...current,
    ].slice(0, 80));
  }, []);

  const loadModels = useCallback(async () => {
    setError(undefined);
    const response = await fetch("/api/chatgpt/models", { credentials: "include" });
    if (response.status === 401) {
      setModels([]);
      setModel("");
      return;
    }
    const payload = await response.json() as { models?: unknown; message?: unknown };
    if (!response.ok || !Array.isArray(payload.models)) {
      throw new Error(typeof payload.message === "string" ? payload.message : "Could not discover ChatGPT models.");
    }
    const discovered = payload.models.filter((entry): entry is string => typeof entry === "string");
    setModels(discovered);
    setModel((current) => discovered.includes(current) ? current : (discovered[0] ?? ""));
    addActivity(`Discovered ${discovered.length} model${discovered.length === 1 ? "" : "s"}.`, "good");
  }, [addActivity]);

  useEffect(() => {
    void loadModels().catch((cause) => setError(errorMessage(cause)));
    return () => {
      liveRef.current?.close();
      liveRef.current = undefined;
    };
  }, [loadModels]);

  const handleBridgeEvent = useCallback((event: ChatGPTRealtimeAppServerEvent) => {
    switch (event.type) {
      case "session.started":
        addActivity("GPT Live session started.", "good");
        break;
      case "session.closed":
        addActivity("GPT Live session closed.");
        setState("closed");
        break;
      case "handoff":
        addActivity(event.transcript ? `Codex handoff: ${event.transcript}` : "Codex handoff started.");
        break;
      case "tool.running":
        addActivity(`Running ${event.name}…`);
        break;
      case "tool.completed":
        addActivity(`${event.name} completed.`, "good");
        setPending((current) => current.filter((item) => item.callId !== event.callId));
        break;
      case "tool.pending_confirmation":
        setPending((current) => [
          ...current.filter((item) => item.callId !== event.callId),
          { callId: event.callId, name: event.name, review: event.review },
        ]);
        addActivity(`${event.name} is waiting for confirmation.`, "warn");
        break;
      case "tool.failed":
        addActivity(`${event.name ?? "Tool"} failed: ${event.message}`, "warn");
        break;
      case "error":
        setError(event.message);
        addActivity(event.message, "warn");
        break;
      case "keepalive":
        break;
    }
  }, [addActivity]);

  async function startCall() {
    if (!model) {
      setError("Sign in and select one of the models available to this ChatGPT account.");
      return;
    }
    setConnecting(true);
    setError(undefined);
    setTranscript([]);
    try {
      const live = await connectChatGPTRealtimeAppServer({
        session: { model, voice },
        onStateChange: (next) => setState(next),
        onTranscript: ({ kind, text }) => {
          setTranscript((current) => [
            ...current,
            { id: nextLineId++, kind, text },
          ].slice(-80));
        },
        onBridgeEvent: handleBridgeEvent,
        onError: (cause) => {
          const message = errorMessage(cause);
          setError(message);
          addActivity(message, "warn");
        },
      });
      liveRef.current = live;
      setInputMuted(false);
      setOutputMuted(false);
    } catch (cause) {
      setError(errorMessage(cause));
      setState("closed");
    } finally {
      setConnecting(false);
    }
  }

  async function endCall() {
    const live = liveRef.current;
    liveRef.current = undefined;
    if (!live) return;
    live.close();
    await live.closeServer().catch((cause) => setError(errorMessage(cause)));
    setState("closed");
    setPending([]);
  }

  function toggleInput() {
    const live = liveRef.current;
    if (!live) return;
    const next = !inputMuted;
    live.setInputMuted(next);
    setInputMuted(next);
  }

  function toggleOutput() {
    const live = liveRef.current;
    if (!live) return;
    const next = !outputMuted;
    live.setOutputMuted(next);
    setOutputMuted(next);
  }

  function submitRelay(event: FormEvent) {
    event.preventDefault();
    const text = relayText.trim();
    if (!text || !liveRef.current) return;
    liveRef.current.relayMessage(text);
    setRelayText("");
    addActivity(`Typed message relayed: ${text}`);
  }

  async function resolveConfirmation(callId: string, approved: boolean) {
    const live = liveRef.current;
    if (!live) return;
    try {
      await live.resolveConfirmation(callId, { approved });
      setPending((current) => current.filter((item) => item.callId !== callId));
      addActivity(approved ? "Action approved in the application UI." : "Action rejected in the application UI.", approved ? "good" : "warn");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const active = state !== "closed" && state !== "failed";

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">OPENHOME × GPT LIVE</p>
          <h1>Voice with hands.</h1>
          <p className="lede">
            Subscription-backed live voice with delegated Codex execution on the paired Mac.
          </p>
        </div>
        <LoginWithChatGPT
          consent={{ appName: "OpenHome GPT Live" }}
          onAuthenticated={() => void loadModels().catch((cause) => setError(errorMessage(cause)))}
        />
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="control-deck" aria-label="Live voice controls">
        <div className="selector-group">
          <label>
            <span>Execution model</span>
            <select value={model} onChange={(event) => setModel(event.target.value)} disabled={active || connecting}>
              {models.length === 0 && <option value="">Sign in to discover models</option>}
              {models.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
            </select>
          </label>
          <button className="quiet-button" type="button" onClick={() => void loadModels().catch((cause) => setError(errorMessage(cause)))} disabled={active}>
            Refresh
          </button>
        </div>

        <label>
          <span>Voice</span>
          <select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={active || connecting}>
            {CHATGPT_REALTIME_VOICES.map((entry) => <option value={entry} key={entry}>{entry}</option>)}
          </select>
        </label>

        <div className="session-control">
          <div className={`state-orb state-${state}`} aria-hidden="true" />
          <div>
            <span className="status-label">Session</span>
            <strong>{connecting ? "connecting" : state}</strong>
          </div>
          {!active ? (
            <button className="primary-button" type="button" onClick={() => void startCall()} disabled={connecting || !model}>
              {connecting ? "Opening…" : "Start live voice"}
            </button>
          ) : (
            <button className="danger-button" type="button" onClick={() => void endCall()}>End call</button>
          )}
        </div>

        <div className="button-row">
          <button type="button" onClick={toggleInput} disabled={!active}>{inputMuted ? "Unmute mic" : "Mute mic"}</button>
          <button type="button" onClick={toggleOutput} disabled={!active}>{outputMuted ? "Unmute sound" : "Mute sound"}</button>
          <button type="button" onClick={() => liveRef.current?.stopSpeaking()} disabled={!active}>Interrupt</button>
        </div>

        <form className="relay" onSubmit={submitRelay}>
          <input
            value={relayText}
            onChange={(event) => setRelayText(event.target.value)}
            placeholder="Type into the live conversation"
            disabled={!active}
            aria-label="Typed live message"
          />
          <button type="submit" disabled={!active || !relayText.trim()}>Send</button>
        </form>
      </section>

      {pending.length > 0 && (
        <section className="confirmations" aria-live="assertive">
          <div className="section-heading">
            <p className="eyebrow">APPLICATION CONFIRMATION</p>
            <h2>Review before anything changes.</h2>
          </div>
          {pending.map((item) => (
            <article className="confirmation-card" key={item.callId}>
              <div>
                <strong>{item.name}</strong>
                <pre>{JSON.stringify(item.review, null, 2)}</pre>
              </div>
              <div className="button-row">
                <button type="button" onClick={() => void resolveConfirmation(item.callId, false)}>Cancel</button>
                <button className="primary-button" type="button" onClick={() => void resolveConfirmation(item.callId, true)}>Approve</button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="workbench">
        <article className="panel transcript-panel">
          <div className="section-heading">
            <p className="eyebrow">LIVE TRANSCRIPT</p>
            <h2>Conversation</h2>
          </div>
          <div className="scroll-stack" aria-live="polite">
            {transcript.length === 0 && <p className="empty">Your transcript appears after the call begins.</p>}
            {transcript.map((line) => (
              <p className={`transcript-line ${line.kind}`} key={line.id}>
                <span>{line.kind === "user_transcript" ? "You" : "GPT Live"}</span>
                {line.text}
              </p>
            ))}
          </div>
        </article>

        <article className="panel activity-panel">
          <div className="section-heading">
            <p className="eyebrow">CODEX BRIDGE</p>
            <h2>Tool activity</h2>
          </div>
          <div className="scroll-stack">
            {activity.length === 0 && <p className="empty">Handoffs and OpenHome tool status appear here.</p>}
            {activity.map((line) => <p className={`activity-line ${line.tone}`} key={line.id}>{line.text}</p>)}
          </div>
        </article>
      </section>

      <footer>
        <span>Audio stays on the native WebRTC path.</span>
        <span>OpenHome mutations require an authenticated click.</span>
      </footer>
    </main>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
