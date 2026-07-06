import { Shell } from "@/components/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { collectAgentReachability } from "@/lib/agent-health";
import { collectAgentBehavior } from "@/lib/agent-config";
import { AGENT_CAPABILITY_GROUPS, type ToolKind } from "@/lib/agent-capabilities";

const KIND_STYLES: Record<ToolKind, string> = {
  Data: "bg-brand-teal/10 border-brand-teal/30 text-brand-teal",
  Image: "bg-brand-magenta/10 border-brand-magenta/30 text-brand-magenta",
  Video: "bg-brand-indigo/10 border-brand-indigo/30 text-brand-indigo",
  Text: "bg-brand-slate/10 border-brand-slate/30 text-brand-slate",
  Control: "bg-brand-orange/10 border-brand-orange/30 text-brand-orange",
  Report: "bg-brand-mid-gray/10 border-brand-mid-gray/40 text-brand-slate",
};

export default async function CapabilitiesPage() {
  const [{ reachable, warnings }, behavior] = await Promise.all([
    collectAgentReachability(),
    collectAgentBehavior(),
  ]);

  return (
    <Shell>
      <div className="max-w-3xl space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent Capabilities</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reference catalog of tools available to the VSS chat agent — what
            you can ask it to do, and what it returns. Hand-curated, not a
            live introspection of the agent.
          </p>
        </div>

        {/* Reachability chip */}
        <div>
          <StatusBadge
            health={reachable ? "ok" : "fail"}
            label={reachable ? "Agent reachable" : "Agent unreachable"}
          />
          {warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {warnings.map((w) => (
                <li key={w} className="font-mono text-xs text-muted-foreground">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Agent behavior — live vss-agent-config (prompt + reasoning budget) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agent behavior</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Reasoning budget + LLM endpoint row */}
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Reasoning budget</span>
                {behavior.maxIterations !== null ? (
                  <Badge variant="secondary" className="font-mono text-xs">
                    max_iterations&nbsp;=&nbsp;{behavior.maxIterations}
                  </Badge>
                ) : (
                  <span className="italic text-muted-foreground">unknown</span>
                )}
              </div>
              {behavior.llm !== null && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">LLM</span>
                  <code className="font-mono text-xs">
                    {behavior.llm.modelName || "(model)"}&nbsp;@&nbsp;{behavior.llm.baseUrl}
                  </code>
                </div>
              )}
            </div>

            {/* System prompt */}
            {behavior.prompt !== null ? (
              <div className="overflow-hidden rounded border border-border">
                <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                  workflow.prompt — system prompt
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                  {behavior.prompt}
                </pre>
              </div>
            ) : (
              <p className="italic text-sm text-muted-foreground">
                System prompt unavailable — see warnings below.
              </p>
            )}

            {/* Read-only caption */}
            <p className="text-xs text-muted-foreground">
              Read-only view of the live ConfigMap. To change the system prompt or
              reasoning budget, edit the source-controlled patch Job{" "}
              <code className="font-mono">
                k8s/nvidia-vss-helm-overlay/60-agent-config-patch-job.yaml
              </code>{" "}
              — changes made directly in the ConfigMap are reverted by the next
              Helm upgrade.
            </p>

            {/* Collector warnings */}
            {behavior.warnings.length > 0 && (
              <ul className="space-y-0.5">
                {behavior.warnings.map((w) => (
                  <li
                    key={w}
                    className="font-mono text-xs text-amber-600 dark:text-amber-400"
                  >
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Tool catalog */}
        {AGENT_CAPABILITY_GROUPS.map((group) => (
          <Card key={group.name}>
            <CardHeader>
              <CardTitle className="text-base">{group.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {group.entries.map((entry, i) =>
                entry.entryType === "note" ? (
                  <div
                    key={i}
                    className="rounded border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground"
                  >
                    <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide">
                      Note:
                    </span>
                    {entry.text}
                  </div>
                ) : (
                  <div key={entry.name} className="border-b border-border pb-4 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-sm font-semibold">
                        {entry.name}
                      </code>
                      {entry.subagent && (
                        <Badge variant="secondary" className="text-[10px]">
                          subagent
                        </Badge>
                      )}
                      {entry.kind.map((k) => (
                        <Badge
                          key={k}
                          variant="outline"
                          className={`text-[10px] ${KIND_STYLES[k]}`}
                        >
                          {k}
                        </Badge>
                      ))}
                      {entry.mutating && (
                        <Badge variant="destructive" className="text-[10px]">
                          mutating
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{entry.returns}</p>
                    {entry.examples.length > 0 && (
                      <div className="mt-1.5 space-y-0.5">
                        {entry.examples.map((ex) => (
                          <p key={ex} className="text-xs italic text-muted-foreground">
                            Try asking:{" "}
                            <span className="not-italic">&ldquo;{ex}&rdquo;</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </Shell>
  );
}
