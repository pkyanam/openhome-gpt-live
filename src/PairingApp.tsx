import { useCallback, useEffect, useState, type FormEvent } from "react";

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
  pendingConfirmations: PendingConfirmation[];
  lastError?: string;
  lastSeenAt: number;
}

export function PairingApp() {
  const [code, setCode] = useState("");
  const [session, setSession] = useState<PairedSession>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

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

      {!session ? (
        <section className="pairing-card">
          <div className="section-heading">
            <p className="eyebrow">ONE-TIME PAIRING</p>
            <h2>Enter the eight digits spoken by OpenHome.</h2>
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
                <div><dt>Voice</dt><dd>{session.voice ?? "juniper"}</dd></div>
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
