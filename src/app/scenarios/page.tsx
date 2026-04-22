"use client";

import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { ScenarioTable } from "@/components/scenarios/ScenarioTable";

export default function ScenariosPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  return (
    <Shell>
      <div className="max-w-7xl mx-auto">
        <ScenarioTable />
      </div>
    </Shell>
  );
}
