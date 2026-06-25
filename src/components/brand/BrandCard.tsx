import { clsx } from "clsx";

/** White rounded brand card (light-gray border + soft shadow). The base
 *  surface for content tiles on the light portal surface. Vendored from
 *  @scality/portal-ui (scality-portal). */
export function BrandCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={clsx("rounded-2xl border border-brand-light-gray bg-brand-white shadow-soft-1", className)}>
      {children}
    </div>
  );
}
