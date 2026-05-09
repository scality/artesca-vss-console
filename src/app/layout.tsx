import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { QueryProvider } from "@/components/QueryProvider";
import { KioskProvider } from "@/components/KioskProvider";
import { isKioskFromHeaders } from "@/lib/kiosk";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Scality VSS Console",
  description: "Operator console for the ARTESCA × Pyramid × NVIDIA VSS stack",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const hdrs = await headers();
  const kiosk = isKioskFromHeaders(hdrs);

  return (
    <html lang="en" className="dark">
      <body>
        <AuthProvider>
          <QueryProvider>
            <KioskProvider initialKiosk={kiosk}>{children}</KioskProvider>
          </QueryProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
