import { Shell } from "@/components/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { collectAgentReachability } from "@/lib/agent-health";
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
  const { reachable, warnings } = await collectAgentReachability();

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
