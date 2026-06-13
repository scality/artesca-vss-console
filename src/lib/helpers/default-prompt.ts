import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read the bundled default VLM system prompt (Pyramid retail loss-prevention
 *  scenario). Returns "" if the file is missing — callers fall back to leaving
 *  the prompt unset. Same text applied at deploy time by
 *  scripts/stacks/nvidia-vss/bootstrap-compose.sh. */
export function readDefaultPrompt(): string {
  try {
    return readFileSync(join(process.cwd(), "public/default-vlm-prompt.txt"), "utf8")
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}
