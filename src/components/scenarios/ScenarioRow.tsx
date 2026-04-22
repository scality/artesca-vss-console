"use client";

import * as React from "react";
import type { Scenario } from "@/lib/types";
import { TableCell, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Copy } from "lucide-react";
import { KeywordChips } from "./KeywordChips";
import { SensorFilterInput } from "./SensorFilterInput";

interface ScenarioRowProps {
  scenario: Scenario;
  onChange: (updated: Scenario) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

const CHANNELS: Array<"ui" | "slack"> = ["ui", "slack"];

export function ScenarioRow({
  scenario,
  onChange,
  onDelete,
  onDuplicate,
}: ScenarioRowProps) {
  const update = <K extends keyof Scenario>(key: K, value: Scenario[K]) => {
    onChange({ ...scenario, [key]: value });
  };

  const toggleChannel = (ch: "ui" | "slack") => {
    const has = scenario.channels.includes(ch);
    update(
      "channels",
      has
        ? scenario.channels.filter((c) => c !== ch)
        : [...scenario.channels, ch]
    );
  };

  return (
    <TableRow>
      <TableCell className="w-12">
        <Switch
          checked={scenario.enabled}
          onCheckedChange={(v) => update("enabled", v)}
        />
      </TableCell>
      <TableCell>
        <Input
          value={scenario.name}
          onChange={(e) => update("name", e.target.value)}
          className="h-8 text-sm"
          placeholder="Scenario name"
        />
      </TableCell>
      <TableCell className="min-w-[200px]">
        <KeywordChips
          keywords={scenario.keywords}
          onChange={(kw) => update("keywords", kw)}
        />
      </TableCell>
      <TableCell className="min-w-[180px]">
        <SensorFilterInput
          value={scenario.sensorFilter}
          onChange={(v) => update("sensorFilter", v)}
        />
      </TableCell>
      <TableCell>
        <Select
          value={scenario.severity}
          onValueChange={(v) => update("severity", v as Scenario["severity"])}
        >
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">low</SelectItem>
            <SelectItem value="medium">medium</SelectItem>
            <SelectItem value="high">high</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex gap-2">
          {CHANNELS.map((ch) => (
            <label key={ch} className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary"
                checked={scenario.channels.includes(ch)}
                onChange={() => toggleChannel(ch)}
              />
              <span className="text-xs">{ch}</span>
            </label>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          className="h-8 w-20 text-xs"
          placeholder="120"
          value={scenario.description ?? ""}
          onChange={(e) => update("description", e.target.value || undefined)}
          title="Cooldown override (seconds)"
        />
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDuplicate}
            title="Duplicate"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
