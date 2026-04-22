"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface RbacSummary {
  serviceAccount: string;
  namespace: string;
  clusterRoles: string[];
  namespacedRoles: Array<{ namespace: string; role: string }>;
}

// Fallback based on k8s/console/01-rbac.yaml contents
const FALLBACK_RBAC: RbacSummary = {
  serviceAccount: "console",
  namespace: "console",
  clusterRoles: ["console-reader"],
  namespacedRoles: [
    { namespace: "vst", role: "console-writer" },
    { namespace: "rtvi", role: "console-writer" },
    { namespace: "agent", role: "console-writer" },
    { namespace: "alerts", role: "console-writer" },
    { namespace: "demo-data", role: "console-writer" },
    { namespace: "pyramid-ingress", role: "console-writer" },
  ],
};

export function RbacInspector() {
  const [rbac, setRbac] = useState<RbacSummary>(FALLBACK_RBAC);
  const [live, setLive] = useState(false);

  useEffect(() => {
    fetch("/api/settings/rbac")
      .then((r) => r.json())
      .then((data: RbacSummary) => {
        setRbac(data);
        setLive(true);
      })
      .catch(() => {
        // Use fallback silently
      });
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">ServiceAccount RBAC</CardTitle>
          {!live && (
            <Badge variant="secondary" className="text-[10px]">
              reference (live unavailable)
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <span className="text-muted-foreground">ServiceAccount: </span>
          <span className="font-mono">{rbac.namespace}/{rbac.serviceAccount}</span>
        </div>
        <div>
          <p className="text-muted-foreground mb-1">ClusterRoles:</p>
          <div className="flex flex-wrap gap-1">
            {rbac.clusterRoles.map((r) => (
              <Badge key={r} variant="outline" className="font-mono text-[11px]">{r}</Badge>
            ))}
          </div>
        </div>
        <div>
          <p className="text-muted-foreground mb-1">Namespaced roles:</p>
          <div className="space-y-1">
            {rbac.namespacedRoles.map((nr) => (
              <div key={nr.namespace} className="flex items-center gap-2">
                <Badge variant="secondary" className="font-mono text-[10px]">{nr.namespace}</Badge>
                <span className="text-xs font-mono text-muted-foreground">{nr.role}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
