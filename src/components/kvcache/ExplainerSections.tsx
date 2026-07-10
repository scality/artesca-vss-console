import Link from "next/link";
import {
  AlertTriangle,
  Repeat,
  ShieldCheck,
  Layers,
  Lock,
  HardDrive,
} from "lucide-react";

/**
 * "The problem (why)" section — every visitor question re-reads the entire
 * store knowledge base from scratch before the first word comes back.
 */
export function ProblemSection() {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <AlertTriangle className="h-5 w-5 text-brand-teal" />
        The problem
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Every time a visitor asks the store&rsquo;s video AI a question, the model has to read
        the entire store knowledge base — policies, layouts, product notes — into its attention
        state before it can produce a single word. That read-and-attend pass is expensive GPU
        work, and today it happens{" "}
        <span className="font-medium text-foreground">from scratch, every single time</span> —
        even when a thousand visitors ask nearly the same question in the same afternoon.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {["Visitor 1", "Visitor 2", "Visitor 3", "Visitor 4"].map((who) => (
          <div
            key={who}
            className="flex items-center gap-1.5 rounded border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive"
          >
            <Repeat className="h-3 w-3" />
            {who} → recompute the whole knowledge base
          </div>
        ))}
        <span className="text-[11px] text-muted-foreground">× thousands / day</span>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        The cost isn&rsquo;t just slower answers — it&rsquo;s GPU time burned recomputing
        identical work, over and over, that could instead be doing new work.
      </p>
    </section>
  );
}

/** "Why ARTESCA" — 4 small cards closing the narrative loop. */
export function WhyArtescaSection() {
  const cards = [
    {
      icon: ShieldCheck,
      title: "On-prem, sovereign",
      body: "The KV cache never leaves the store. It's parked on ARTESCA, on-premises — the same principle as every other frame, incident, and clip this deployment produces.",
    },
    {
      icon: Layers,
      title: "S3-compatible, drop-in",
      body: "Any inference framework that speaks the S3 API can PUT/GET KV blocks here. The same pattern runs unchanged on Ceph or NetApp ONTAP S3 — no proprietary cache tier.",
    },
    {
      icon: Lock,
      title: "Immutable lineage, if you want it",
      body: (
        <>
          The same Object Lock / WORM machinery that seals incident evidence (see{" "}
          <Link href="/evidence" className="font-medium text-brand-teal hover:underline">
            Evidence
          </Link>
          ) can retain a KV snapshot for audit or reproducibility.
        </>
      ),
    },
    {
      icon: HardDrive,
      title: "Long-term memory, not just storage",
      body: (
        <>
          <Link href="/storage" className="font-medium text-brand-teal hover:underline">
            ARTESCA S3
          </Link>{" "}
          already holds everything the AI has seen. Now it holds everything the AI has
          already thought, too.
        </>
      ),
    },
  ];

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-lg font-bold">Why ARTESCA</h2>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-lg border border-border bg-muted/30 p-4">
            <Icon className="h-5 w-5 text-brand-teal" />
            <p className="mt-2 text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
