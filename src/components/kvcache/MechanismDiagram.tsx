import { Cpu, HardDrive, ArrowRight, ArrowLeft, Lightbulb } from "lucide-react";

/**
 * "The idea" section — the KV cache *is* the computation. Compute once, park
 * it on ARTESCA, reuse forever. A plain CSS/SVG-free diagram (flex boxes +
 * arrows) since this is a static explainer, not an animated beat.
 */
export function MechanismDiagram() {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Lightbulb className="h-5 w-5 text-brand-teal" />
        The idea
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        The KV cache <span className="font-medium text-foreground">is</span>{" "}
        that recomputation — the model&rsquo;s attention state for every token it has already read.
        Compute it once, park it on ARTESCA object storage, and every later question that shares
        the same store knowledge just reads it back instead of recomputing it.
      </p>

      {/* GPU <-> ARTESCA diagram */}
      <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center sm:gap-6">
        <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-4 sm:flex-none sm:w-44">
          <Cpu className="h-5 w-5 text-brand-teal" />
          <span className="text-sm font-semibold">GPU / VLM</span>
        </div>

        <div className="flex flex-col items-center gap-2 sm:w-56">
          <div className="flex w-full items-center gap-2 text-[11px] font-medium text-destructive">
            <span className="whitespace-nowrap">miss → PUT block</span>
            <div className="h-px flex-1 bg-destructive/30" />
            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
          </div>
          <div className="flex w-full items-center gap-2 text-[11px] font-medium text-brand-teal">
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
            <div className="h-px flex-1 bg-brand-teal/30" />
            <span className="whitespace-nowrap">hit → GET block</span>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-4 sm:flex-none sm:w-44">
          <HardDrive className="h-5 w-5 text-brand-teal" />
          <span className="text-sm font-semibold">ARTESCA S3</span>
        </div>
      </div>

      {/* Object key */}
      <div className="mt-5 rounded border border-border bg-muted/40 p-3">
        <code className="block break-all text-xs font-mono text-foreground">
          kv_block(model, tenant, prompt_hash, layer, block_id)
        </code>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Content-addressed by a hash of the token sequence — no index needed. Two visitors
          asking the same question, on the same store knowledge, land on the same key.
        </p>
      </div>
    </section>
  );
}
