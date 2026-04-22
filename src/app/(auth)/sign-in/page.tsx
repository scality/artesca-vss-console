"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function SignInPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [kiosk, setKiosk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (kiosk) {
      document.cookie = "kiosk=1; Path=/; SameSite=Strict";
    } else {
      document.cookie = "kiosk=; Path=/; SameSite=Strict; Max-Age=0";
    }

    const result = await signIn("credentials", {
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid password. Try again.");
    } else {
      router.push("/");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-lg">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Demo Console</h1>
          <p className="text-sm text-muted-foreground">
            ARTESCA × Pyramid × NVIDIA VSS
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="password"
              className="text-sm font-medium text-foreground"
            >
              Console password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter password"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="kiosk"
              type="checkbox"
              checked={kiosk}
              onChange={(e) => setKiosk(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <label htmlFor="kiosk" className="text-sm text-muted-foreground">
              Kiosk mode (showroom view — hides operator tabs)
            </label>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/20 px-3 py-2 text-sm text-destructive-foreground">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
