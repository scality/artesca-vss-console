import { Shell } from "@/components/Shell";
import { ExternalLink } from "lucide-react";

export const metadata = {
  title: "Sizing Studio",
};

export default function SizingStudioPage() {
  return (
    <Shell className="flex flex-col p-0">
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold">Sizing Studio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Size cameras, light-rails, AKHET® servers, GPUs, AI systems and ARTESCA
            storage for any store — by surface area and use case.
          </p>
        </div>
        <a
          href="/sizing-studio.html"
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1.5 text-sm text-primary hover:underline"
        >
          Open full screen
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </div>
      <iframe
        src="/sizing-studio.html"
        title="Invisible Retail AI · Sizing Studio"
        className="w-full flex-1 border-0"
        style={{ minHeight: "calc(100vh - 9rem)" }}
      />
    </Shell>
  );
}
