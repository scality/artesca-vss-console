"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import type { PodSummary } from "@/lib/types";

interface Selection {
  namespace: string;
  pod: string;
  container: string;
}

interface PodPickerProps {
  onSelect: (sel: Selection | null) => void;
}

export function PodPicker({ onSelect }: PodPickerProps) {
  const [pods, setPods] = useState<PodSummary[]>([]);
  const [namespace, setNamespace] = useState("");
  const [pod, setPod] = useState("");
  const [container, setContainer] = useState("");

  useEffect(() => {
    fetch("/api/pods?ns=all")
      .then((r) => r.json())
      .then((data: { pods?: PodSummary[] } | PodSummary[]) => {
        setPods(Array.isArray(data) ? data : (data.pods ?? []));
      })
      .catch(() => {});
  }, []);

  const namespaces = Array.from(new Set(pods.map((p) => p.namespace))).sort();
  const podsInNs = pods.filter((p) => p.namespace === namespace);
  const containers = podsInNs.find((p) => p.name === pod)?.containers ?? [];

  function handleNamespace(ns: string) {
    setNamespace(ns);
    setPod("");
    setContainer("");
    onSelect(null);
  }

  function handlePod(p: string) {
    // Default to the pod's first container — no pod has a "main" container, so a
    // hardcoded default 400s on the apiserver log request.
    const first = podsInNs.find((x) => x.name === p)?.containers?.[0] ?? "";
    setPod(p);
    setContainer(first);
    onSelect(namespace && p && first ? { namespace, pod: p, container: first } : null);
  }

  function handleContainer(c: string) {
    setContainer(c);
    onSelect(namespace && pod && c ? { namespace, pod, container: c } : null);
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="space-y-1">
        <Label>Namespace</Label>
        <select
          value={namespace}
          onChange={(e) => handleNamespace(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">— select —</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <Label>Pod</Label>
        <select
          value={pod}
          onChange={(e) => handlePod(e.target.value)}
          disabled={!namespace}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        >
          <option value="">— select —</option>
          {podsInNs.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <Label>Container</Label>
        <select
          value={container}
          onChange={(e) => handleContainer(e.target.value)}
          disabled={!pod}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        >
          <option value="">— select —</option>
          {containers.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
