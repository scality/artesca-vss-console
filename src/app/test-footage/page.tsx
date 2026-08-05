"use client";

import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { TestFootagePanel } from "@/components/test-footage/TestFootagePanel";

export default function TestFootagePage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  return (
    <Shell>
      <div className="max-w-4xl mx-auto">
        <TestFootagePanel />
      </div>
    </Shell>
  );
}
