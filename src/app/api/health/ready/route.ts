import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { coreV1 } from "@/lib/k8s";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export async function GET() {
  const [dbResult, k8sResult] = await Promise.allSettled([
    withTimeout(
      Promise.resolve().then(() => {
        getDb().prepare("SELECT 1").get();
      }),
      TIMEOUT_MS,
      "db"
    ),
    withTimeout(
      coreV1().listNamespace({ limit: 1 }).then(() => undefined),
      TIMEOUT_MS,
      "k8s"
    ),
  ]);

  const checks = {
    db: dbResult.status === "fulfilled" ? "ok" : "fail",
    k8s: k8sResult.status === "fulfilled" ? "ok" : "fail",
  } as const;

  const errors: string[] = [];
  if (dbResult.status === "rejected") {
    errors.push(`db: ${dbResult.reason instanceof Error ? dbResult.reason.message : String(dbResult.reason)}`);
  }
  if (k8sResult.status === "rejected") {
    errors.push(`k8s: ${k8sResult.reason instanceof Error ? k8sResult.reason.message : String(k8sResult.reason)}`);
  }

  const ok = errors.length === 0;

  if (ok) {
    return NextResponse.json(
      {
        ok: true,
        ts: new Date().toISOString(),
        version: process.env.NEXT_PUBLIC_VERSION ?? "dev",
        checks,
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    { ok: false, checks, errors },
    { status: 503 }
  );
}
