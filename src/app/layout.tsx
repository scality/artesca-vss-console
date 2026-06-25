import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Poppins } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { QueryProvider } from "@/components/QueryProvider";
import { KioskProvider } from "@/components/KioskProvider";
import { isKioskFromHeaders } from "@/lib/kiosk";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});
const sans = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Scality VSS Console",
  description: "Operator console for the ARTESCA × Pyramid × NVIDIA VSS stack",
  icons: { icon: "/brand/scality_cube_mark.svg" },
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
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
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
