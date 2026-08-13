"use client";

import { useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

/**
 * Grafana access card — URL and user in clear, password on request.
 *
 * The password is **not a prop**. This component is rendered by a server
 * component, so anything passed in would travel in the page payload on every
 * dashboard load, which is exactly what this change removes; `hasPassword` is a
 * boolean so the card can say whether there is one to ask for. The value is
 * fetched from `POST /api/grafana-credential`, which audits the reveal, and it
 * lives in component state only — never localStorage, so it does not survive a
 * reload or follow the operator to another tab (ISVD-550).
 */
export function GrafanaAccessCard({
  url,
  user,
  hasPassword,
  loginHint,
}: {
  url: string;
  user: string;
  hasPassword: boolean;
  loginHint: string;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/grafana-credential", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // 403 is kiosk mode, which is a deliberate refusal rather than a fault.
        setError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { password?: string };
      setPassword(body.password ?? null);
    } catch {
      setError("Could not reach the console API");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-brand-light-gray bg-muted p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Historical graphs — Grafana
        </p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-brand-teal hover:text-brand-teal/80 hover:underline"
        >
          Open Grafana ↗
        </a>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground uppercase tracking-wider">URL</dt>
          <dd className="font-mono text-xs break-all">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-teal hover:text-brand-teal/80 hover:underline"
            >
              {url}
            </a>
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground uppercase tracking-wider">User</dt>
          <dd className="font-mono text-xs select-all">{user}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground uppercase tracking-wider">Password</dt>
          <dd className="font-mono text-xs break-all">
            {!hasPassword ? (
              <span className="text-muted-foreground">—</span>
            ) : password !== null ? (
              <span className="inline-flex items-center gap-2">
                <span className="select-all">{password}</span>
                <button
                  type="button"
                  onClick={() => setPassword(null)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Hide password"
                  title="Hide"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={reveal}
                disabled={loading}
                className="inline-flex items-center gap-1.5 text-brand-teal hover:text-brand-teal/80 hover:underline disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                <span aria-hidden="true">••••••••</span>
                <span className="sr-only">Reveal Grafana password</span>
                <span className="not-sr-only text-[10px] uppercase tracking-wider">Reveal</span>
              </button>
            )}
          </dd>
          {error && <p className="text-[11px] text-brand-red">{error}</p>}
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{loginHint}</p>
      {hasPassword && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Revealing is recorded in the audit log. Take care on a shared screen.
        </p>
      )}
    </div>
  );
}
