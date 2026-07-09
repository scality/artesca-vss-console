/**
 * Normalize the on-box TTS NIM's /v1/audio/list_voices response into a flat
 * list of voice-name strings. The exact JSON shape varies by NIM version
 * (array of strings, array of objects, or a { "<lang>": [...] } map), so parse
 * defensively. Pure + dependency-free → unit-testable without the cluster.
 */
export function parseVoiceList(data: unknown): string[] {
  const out: string[] = [];

  const pushName = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.trim()) out.push(v.trim());
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const name = o.name ?? o.voice_name ?? o.voice ?? o.id;
      if (typeof name === "string" && name.trim()) out.push(name.trim());
    }
  };

  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(pushName);
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (Array.isArray(o.voices)) {
        o.voices.forEach(pushName);
        return;
      }
      // { "en-US": [...], "de-DE": [...] } — flatten each language's list.
      for (const val of Object.values(o)) {
        if (Array.isArray(val)) val.forEach(pushName);
        else pushName(val);
      }
    }
  };

  walk(data);
  return [...new Set(out)];
}
