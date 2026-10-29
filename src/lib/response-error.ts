/**
 * The `error` a console API route put in its JSON body, as an Error, for a
 * client handler to throw on `!res.ok`. A fixed message ("Patch failed") hid
 * every cause, the box-mode 409 ("VSS paused — …") among them.
 */
export async function responseError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(
    typeof body?.error === "string" && body.error ? body.error : `${fallback} (HTTP ${res.status})`,
  );
}
