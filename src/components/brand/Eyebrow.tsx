import { clsx } from "clsx";

/** Uppercase, letter-spaced Space Grotesk label shown above headings/sections.
 *  Vendored from @scality/portal-ui (scality-portal). */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={clsx("eyebrow", className)}>{children}</p>;
}
