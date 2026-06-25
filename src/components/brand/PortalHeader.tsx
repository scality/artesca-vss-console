import Link from "next/link";

interface PortalHeaderProps {
  /** Small teal-light eyebrow shown next to the logo (e.g. "Scality · Portal"). */
  eyebrow?: string;
  /** Where the logo links to. */
  homeHref?: string;
  /** White linear Scality logo path (served from the app's /public). */
  logoSrc?: string;
  /** Right-aligned slot for app controls (search, publish, account, …). */
  children?: React.ReactNode;
}

/** Near-black brand header bar — the shared chrome used across the Scality 2026
 *  portal surfaces. Presentational + server-safe. Vendored from
 *  @scality/portal-ui (scality-portal). */
export function PortalHeader({
  eyebrow,
  homeHref = "/",
  logoSrc = "/brand/scality_logo_linear_dark.png",
  children,
}: PortalHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-brand-deep-navy bg-brand-near-black text-brand-white">
      <div className="flex items-center gap-4 px-6 py-3">
        <Link href={homeHref} className="flex shrink-0 items-center gap-3 no-underline">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} alt="Scality" className="h-6 w-auto object-contain" />
        </Link>
        {eyebrow ? (
          <span className="eyebrow hidden text-[10px] text-brand-teal-light sm:inline-block" aria-hidden>
            {eyebrow}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      </div>
    </header>
  );
}
