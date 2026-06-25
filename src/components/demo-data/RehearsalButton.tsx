"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const REHEARSAL_DURATION = 60;

interface RehearsalButtonProps {
  disabled?: boolean;
}

export function RehearsalButton({ disabled }: RehearsalButtonProps) {
  const [active, setActive] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function startRehearsal() {
    try {
      const res = await fetch("/api/demo-data/rehearsal", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());

      setActive(true);
      setRemaining(REHEARSAL_DURATION);

      intervalRef.current = setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            clearInterval(intervalRef.current!);
            setActive(false);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    } catch (err) {
      toast({
        title: "Rehearsal failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="lg"
        className="bg-brand-orange hover:bg-brand-orange/90 text-white font-semibold px-6"
        disabled={disabled || active}
        onClick={startRehearsal}
      >
        {active ? `Rehearsal active — ${remaining}s remaining` : "Start Rehearsal Mode"}
      </Button>
      {active && (
        <p className="text-sm text-muted-foreground">
          High-probability burst for {REHEARSAL_DURATION}s — demo scenario will fire repeatedly.
        </p>
      )}
    </div>
  );
}
