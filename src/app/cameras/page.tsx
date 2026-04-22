"use client";

import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { CameraTable } from "@/components/cameras/CameraTable";

export default function CamerasPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  return (
    <Shell>
      <div className="max-w-6xl mx-auto">
        <CameraTable />
      </div>
    </Shell>
  );
}
