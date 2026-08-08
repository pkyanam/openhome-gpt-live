import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CHATGPT_REALTIME_VOICES,
  type ChatGPTRealtimeVoice,
} from "@opencoredev/loginwithchatgpt-core";

interface PendingConfirmation {
  callId: string;
  name: string;
  review: unknown;
}

interface PairedSession {
  deviceId: string;
  name: string;
  paired: boolean;
  loginStatus: "unauthenticated" | "pending" | "authenticated" | "expired" | "error";
  loginUser?: { email?: string; name?: string; plan?: string };
  userCode?: string;
  verificationUrl?: string;
  loginExpiresAt?: number;
  liveSessionId?: string;
  selectedModel?: string;
  voice?: string;
  connectionState?: string;
  codexState?: "idle" | "working";
  codexQueueDepth?: number;
  lastCodexTaskStatus?: "completed" | "failed" | "interrupted";
  lastCodexTaskAt?: number;
  lastVoiceRoute?: "native" | "openai_search" | "codex";
  lastVoiceRouteAt?: number;
  pendingConfirmations: PendingConfirmation[];
  lastError?: string;
  lastSeenAt: number;
}

export function PairingApp() {
  const [code, setCode] = useState(() => formatPairingCode(
    new URLSearchParams(window.location.hash.slice(1)).get("pairing") ?? "",
  ));
  const [session, setSession] = useState<PairedSession>();
  const [voice, setVoice] = useState<ChatGPTRealtimeVoice>("vale");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async () => {
    const response = await fetch("/api/pairing/session", { credentials: "include" });
    if (response.status === 401) {
      setSession(undefined);
      setLoading(false);
      return;
    }
    const payload = await response.json() as { session?: PairedSession; message?: string };
    if (!response.ok || !payload.session) throw new Error(payload.message ?? "Could not read the paired DevKit session.");
    setSession(payload.session);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => {
      setError(errorMessage(cause));
      setLoading(false);
    });
  }, [refresh]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, session]);

  useEffect(() => {
    if (session) window.scrollTo({ top: 0 });
  }, [session?.deviceId]);

  useEffect(() => {
    if (isRealtimeVoice(session?.voice)) setVoice(session.voice);
  }, [session?.voice]);

  async function claim(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/pairing/claim", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await response.json() as { session?: PairedSession; message?: string };
      if (!response.ok || !payload.session) throw new Error(payload.message ?? "Pairing failed.");
      setSession(payload.session);
      setCode("");
      window.history.replaceState(null, "", "/setup");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function saveVoice() {
    setSubmitting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch("/api/pairing/voice", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice }),
      });
      const payload = await response.json() as {
        session?: PairedSession;
        reconnecting?: boolean;
        message?: string;
      };
      if (!response.ok || !payload.session) throw new Error(payload.message ?? "Voice update failed.");
      setSession(payload.session);
      setNotice(payload.reconnecting
        ? `${voiceLabel(voice)} saved. GPT Live is reconnecting; give the speaker about ten seconds.`
        : `${voiceLabel(voice)} saved. It will be used when GPT Live next connects.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirm(callId: string, approved: boolean) {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/pairing/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, approved }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Confirmation failed.");
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="pairing-shell"><p className="eyebrow">OPENHOME × GPT LIVE</p><h1>Finding your DevKit…</h1></main>;
  }

  return (
    <main className="pairing-shell">
      <header className="pairing-header">
        <p className="eyebrow">OPENHOME × GPT LIVE</p>
        <h1>{session ? "Your phone is the control surface." : "Pair this phone."}</h1>
        <p className="lede">
          ChatGPT authorization and consequential-action approvals happen here. Live audio stays on the OpenHome DevKit.
        </p>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="notice-banner" role="status">{notice}</div>}

      {!session ? (
        <section className="pairing-card">
          <div className="section-heading">
            <p className="eyebrow">ONE-TIME PAIRING</p>
            <h2>Enter the eight digits from the setup command or speaker.</h2>
          </div>
          <form className="pairing-form" onSubmit={claim}>
            <input
              className="pairing-code-input"
              value={code}
              onChange={(event) => setCode(formatPairingCode(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="0000 0000"
              aria-label="Eight digit pairing code"
              maxLength={9}
              autoFocus
            />
            <button className="primary-button" type="submit" disabled={submitting || code.replace(/\D/g, "").length !== 8}>
              {submitting ? "Pairing…" : "Pair DevKit"}
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="pairing-card device-card">
            <div>
              <p className="eyebrow">PAIRED DEVICE</p>
              <h2>{session.name}</h2>
            </div>
            <div className={`connection-pill connection-${session.connectionState ?? session.loginStatus}`}>
              {session.connectionState ?? session.loginStatus}
            </div>
          </section>

          <section className="pairing-card voice-settings-card">
            <div>
              <p className="eyebrow">GPT LIVE VOICE</p>
              <h2>Choose how the speaker sounds.</h2>
              <p>Changing this restarts only the Live connection. The wake phrase remains “Juniper.”</p>
            </div>
            <div className="voice-picker">
              <label>
                <span>Voice</span>
                <select value={voice} onChange={(event) => setVoice(event.target.value as ChatGPTRealtimeVoice)}>
                  {CHATGPT_REALTIME_VOICES.map((entry) => (
                    <option value={entry} key={entry}>{voiceLabel(entry)}</option>
                  ))}
                </select>
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={submitting || voice === session.voice || session.codexState === "working"}
                onClick={() => void saveVoice()}
              >
                {submitting ? "Saving…" : "Save voice"}
              </button>
              {session.codexState === "working" && (
                <small>Wait for the active Codex task before restarting Live.</small>
              )}
            </div>
          </section>

          {session.loginStatus !== "authenticated" ? (
            <section className="pairing-card authorization-card">
              <div className="section-heading">
                <p className="eyebrow">CHATGPT AUTHORIZATION</p>
                <h2>{session.userCode ? "Authorize this DevKit." : "Waiting for the DevKit to request a code…"}</h2>
              </div>
              {session.userCode && session.verificationUrl && (
                <div className="authorization-grid">
                  <div>
                    <span className="status-label">Device code</span>
                    <strong className="user-code">{session.userCode}</strong>
                    <button type="button" onClick={() => void navigator.clipboard.writeText(session.userCode!)}>Copy code</button>
                  </div>
                  <div className="authorization-actions">
                    <p>Open ChatGPT authorization, then enter the code shown here.</p>
                    <a className="primary-link" href={session.verificationUrl} target="_blank" rel="noreferrer">Open ChatGPT authorization</a>
                  </div>
                </div>
              )}
            </section>
          ) : (
            <section className="pairing-card authenticated-card">
              <div>
                <p className="eyebrow">CHATGPT CONNECTED</p>
                <h2>{session.loginUser?.email ?? "Authenticated account"}</h2>
              </div>
              <dl className="session-facts">
                <div><dt>Plan</dt><dd>{session.loginUser?.plan ?? "Account default"}</dd></div>
                <div><dt>Model</dt><dd>{session.selectedModel ?? "Waiting for Live"}</dd></div>
                <div><dt>Voice</dt><dd>{voiceLabel(session.voice ?? "vale")}</dd></div>
                <div>
                  <dt>Codex</dt>
                  <dd>
                    {session.codexState ?? "idle"}
                    {(session.codexQueueDepth ?? 0) > 0 ? ` · ${session.codexQueueDepth} queued` : ""}
                  </dd>
                </div>
                {session.lastCodexTaskStatus && (
                  <div><dt>Last task</dt><dd>{session.lastCodexTaskStatus}</dd></div>
                )}
                {session.lastVoiceRoute && (
                  <div>
                    <dt>Last routed request</dt>
                    <dd>{session.lastVoiceRoute === "native"
                      ? "GPT Live"
                      : session.lastVoiceRoute === "openai_search"
                        ? "OpenAI web search"
                        : "Codex"}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {session.pendingConfirmations.length > 0 && (
            <section className="pairing-card mobile-confirmations" aria-live="assertive">
              <div className="section-heading">
                <p className="eyebrow">APPROVAL REQUIRED</p>
                <h2>Review before OpenHome changes anything.</h2>
              </div>
              {session.pendingConfirmations.map((item) => (
                <article className="confirmation-card" key={item.callId}>
                  <div>
                    <strong>{item.name}</strong>
                    <pre>{JSON.stringify(item.review, null, 2)}</pre>
                  </div>
                  <div className="button-row">
                    <button type="button" disabled={submitting} onClick={() => void confirm(item.callId, false)}>Reject</button>
                    <button className="primary-button" type="button" disabled={submitting} onClick={() => void confirm(item.callId, true)}>Approve</button>
                  </div>
                </article>
              ))}
            </section>
          )}

          {session.lastError && <div className="error-banner" role="alert">{session.lastError}</div>}

          <p className="pairing-note">
            Keep this page available for approvals. It refreshes automatically and never receives ChatGPT bearer tokens or DevKit credentials.
          </p>
        </>
      )}
    </main>
  );
}

function formatPairingCode(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRealtimeVoice(value: unknown): value is ChatGPTRealtimeVoice {
  return typeof value === "string"
    && (CHATGPT_REALTIME_VOICES as readonly string[]).includes(value);
}

function voiceLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
