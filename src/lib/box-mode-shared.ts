// The box's GPU mode as the console reports it — shared by the server reader
// (src/lib/box-mode.ts), GET /api/box-mode and the banner. No server imports:
// client components import this file.

/** Where `mode` came from.
 *  - `configmap`: the AI Factory's GPU-mode record was read and parsed.
 *  - `absent`:    no record (no namespace or no ConfigMap) — a box without the
 *                 AI Factory. Reads as `vss`.
 *  - `error`:     the record could not be read (forbidden, timeout, API error)
 *                 or did not parse. Reads as `vss`, and `reason` says why. */
export type BoxModeSource = "configmap" | "absent" | "error";

export interface BoxMode {
  /** `vss` is the console's own world; any other value pauses the console's
   *  writes to the workloads the GPU switch scales. */
  mode: string;
  /** The switch refuses to move away from a pinned mode. */
  pinned: boolean;
  /** When the switch last wrote the record (ISO string), if it says. */
  updatedAt: string | null;
  source: BoxModeSource;
  /** Why the mode reads as it does, when it was not a clean read; else null. */
  reason: string | null;
}

/** The mode the console assumes when there is no usable record. */
export const DEFAULT_BOX_MODE = "vss";

export function isBoxPaused(m: Pick<BoxMode, "mode"> | null | undefined): boolean {
  return !!m && m.mode !== DEFAULT_BOX_MODE;
}

/** The one-line notice shown while the box is not in `vss` mode. */
export function pausedHeadline(mode: string): string {
  return mode === "llm"
    ? "VSS paused — the box is running the LLM (AI Factory)"
    : `VSS paused — the box is in '${mode}' mode (AI Factory)`;
}
