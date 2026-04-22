"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAge } from "@/lib/utils";
import type { DemoProfile } from "@/lib/types";

interface ProfileRow {
  name: string;
  savedAt: string;
  savedBy: string;
  numScenarios: number;
  numCameras: number;
  nimModel: string;
}

interface ProfileTableProps {
  profiles: ProfileRow[];
  activeProfile?: string;
  onLoad: (name: string) => void;
  onDuplicate: (name: string) => void;
  onExport: (name: string) => void;
  onDelete: (name: string) => void;
}

export function ProfileTable({
  profiles,
  activeProfile,
  onLoad,
  onDuplicate,
  onExport,
  onDelete,
}: ProfileTableProps) {
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Saved at</TableHead>
            <TableHead>By</TableHead>
            <TableHead className="text-right">Scenarios</TableHead>
            <TableHead className="text-right">Cameras</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profiles.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No profiles saved yet.
              </TableCell>
            </TableRow>
          )}
          {profiles.map((p) => (
            <TableRow
              key={p.name}
              className={p.name === activeProfile ? "bg-accent/30" : undefined}
            >
              <TableCell className="font-mono font-medium">
                {p.name}
                {p.name === activeProfile && (
                  <Badge className="ml-2 text-[10px] bg-primary/20 text-primary">active</Badge>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {/* eslint-disable-next-line react-hooks/purity -- Date.now() for display age only */}
                {formatAge(Date.now() - new Date(p.savedAt).getTime())} ago
              </TableCell>
              <TableCell className="text-sm">{p.savedBy}</TableCell>
              <TableCell className="text-right text-sm">{p.numScenarios}</TableCell>
              <TableCell className="text-right text-sm">{p.numCameras}</TableCell>
              <TableCell className="font-mono text-xs">{p.nimModel}</TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => onLoad(p.name)}>
                    Load
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDuplicate(p.name)}>
                    Duplicate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onExport(p.name)}>
                    Export
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => onDelete(p.name)}
                  >
                    Delete
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
