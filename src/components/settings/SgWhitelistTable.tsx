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
import { formatAgeMs } from "@/lib/utils";
import type { SgWhitelistEntry } from "@/lib/types";

interface SgWhitelistTableProps {
  entries: SgWhitelistEntry[];
  onDelete: (id: string) => void;
}

export function SgWhitelistTable({ entries, onDelete }: SgWhitelistTableProps) {
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>CIDR</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Added by</TableHead>
            <TableHead>Added</TableHead>
            <TableHead>Port</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                No CIDR entries. Add your IP below.
              </TableCell>
            </TableRow>
          )}
          {entries.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="font-mono text-sm">{e.cidr}</TableCell>
              <TableCell className="text-sm">{e.label}</TableCell>
              <TableCell className="text-sm">{e.addedBy}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {/* eslint-disable-next-line react-hooks/purity -- Date.now() for display age only */}
                {formatAgeMs(Date.now() - new Date(e.addedAt).getTime())} ago
              </TableCell>
              <TableCell className="text-sm">{e.port}</TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onDelete(e.id)}
                >
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
