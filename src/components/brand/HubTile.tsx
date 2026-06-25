import Link from "next/link";
import { ArrowRight } from "lucide-react";

export interface HubTileProps {
  href: string;
  title: string;
  blurb?: string;
  /** Accent colour (CSS value) for the icon circle + arrow — see accentFor(). */
  accent: string;
  badge?: string;
  Icon: React.ComponentType<{ className?: string; size?: number; style?: React.CSSProperties }>;
  /** Open in a new tab (external links). */
  external?: boolean;
}

/** Accent-coloured row tile from the /portal hub: icon circle (accent @ 12%),
 *  Space Grotesk title, muted blurb, trailing arrow. Presentational. Vendored
 *  from @scality/portal-ui (scality-portal). */
export function HubTile({ href, title, blurb, accent, badge, Icon, external }: HubTileProps) {
  const inner = (
    <>
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `${accent}1f`, color: accent }}
      >
        <Icon className="h-[18px] w-[18px]" style={{ color: accent }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="block truncate text-[15px] font-semibold text-brand-almost-black" style={{ fontFamily: "var(--font-display)" }}>
            {title}
          </span>
          {badge ? (
            <span
              className="rounded px-[6px] py-[2px] text-[9px] font-bold uppercase tracking-[1.5px] text-brand-white"
              style={{ backgroundColor: "var(--color-brand-indigo)", fontFamily: "var(--font-display)" }}
            >
              {badge}
            </span>
          ) : null}
        </div>
        {blurb ? <p className="mt-[2px] truncate text-[12px] text-brand-slate">{blurb}</p> : null}
      </div>
      <ArrowRight className="h-[18px] w-[18px] shrink-0" style={{ color: accent }} />
    </>
  );

  const className =
    "group flex items-center gap-[14px] rounded-[14px] border border-brand-light-gray bg-brand-white px-[14px] py-3 no-underline transition-colors hover:bg-[#f8f9fb]";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}
