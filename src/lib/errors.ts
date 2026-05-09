import "server-only";

export interface NormalizedError {
  status: number;
  message: string;
}

/**
 * Normalizes a caught error from @kubernetes/client-node API calls.
 * The client throws ApiException<T> objects with a numeric `code` and
 * a `body` that may carry `{ message?: string }`. Falls back gracefully
 * for plain Error or unknown values.
 */
export function extractK8sError(err: unknown): NormalizedError {
  if (err !== null && typeof err === "object") {
    const e = err as { code?: number; statusCode?: number; body?: { message?: string }; message?: string };
    const status = e.code ?? e.statusCode ?? 500;
    const message = e.body?.message ?? e.message ?? "kubernetes error";
    return { status, message };
  }
  if (err instanceof Error) return { status: 500, message: err.message };
  return { status: 500, message: String(err) };
}
