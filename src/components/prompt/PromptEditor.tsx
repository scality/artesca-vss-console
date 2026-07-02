"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Columns2, FileText } from "lucide-react";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false, loading: () => <EditorSkeleton /> }
);

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  { ssr: false, loading: () => <EditorSkeleton /> }
);

function EditorSkeleton() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm bg-[#1e1e1e] rounded">
      Loading editor...
    </div>
  );
}

interface PromptEditorProps {
  original: string;
  value: string;
  onChange: (v: string) => void;
}

export function PromptEditor({ original, value, onChange }: PromptEditorProps) {
  const [diffMode, setDiffMode] = React.useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant={diffMode ? "secondary" : "outline"}
          size="sm"
          onClick={() => setDiffMode((v) => !v)}
        >
          {diffMode ? (
            <>
              <FileText className="h-4 w-4 mr-1" />
              Edit
            </>
          ) : (
            <>
              <Columns2 className="h-4 w-4 mr-1" />
              Diff
            </>
          )}
        </Button>
        {diffMode && (
          <span className="text-xs text-muted-foreground">
            Left: current (read-only) — Right: proposed (editable)
          </span>
        )}
      </div>

      <div className="h-96 rounded border border-border overflow-hidden">
        {diffMode ? (
          <DiffEditor
            original={original}
            modified={value}
            language="markdown"
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              renderSideBySide: true,
              originalEditable: false,
              wordWrap: "on",
            }}
            onMount={(editor) => {
              editor.getModifiedEditor().onDidChangeModelContent(() => {
                onChange(editor.getModifiedEditor().getValue());
              });
            }}
          />
        ) : (
          <div className="flex h-full">
            <div className="w-1/2 border-r border-border flex flex-col">
              <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/20">
                Current (read-only)
              </div>
              <div className="flex-1">
                <MonacoEditor
                  value={original}
                  language="markdown"
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    lineNumbers: "on",
                    wordWrap: "on",
                  }}
                />
              </div>
            </div>
            <div className="w-1/2 flex flex-col">
              <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/20">
                Proposed (editable)
              </div>
              <div className="flex-1">
                <MonacoEditor
                  value={value}
                  language="markdown"
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    lineNumbers: "on",
                    wordWrap: "on",
                  }}
                  onChange={(v) => onChange(v ?? "")}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
