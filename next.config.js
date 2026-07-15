/** @type {import('next').NextConfig} */

const { withSentryConfig } = require("@sentry/nextjs");

const SAFE_DEFAULT = "http://metropolis-nvidia-vss-ui:3000";

// Blocked host patterns: link-local, loopback, metadata service, RFC1918 literals.
const BLOCKED_HOST_RE =
  /^(127\.|169\.254\.|0\.0\.0\.0|::1|localhost$|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)/i;

// Accepted in-cluster K8s DNS hostname pattern: lowercase alphanumeric + hyphens, dot-separated segments.
const INCLUSTER_HOST_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

function resolveUpstreamOrigin() {
  const raw = process.env.CHAT_UPSTREAM_URL;
  if (!raw) return SAFE_DEFAULT;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    process.stderr.write(
      `[next.config] CHAT_UPSTREAM_URL is not a valid URL ("${raw}"); falling back to safe default\n`
    );
    return SAFE_DEFAULT;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    process.stderr.write(
      `[next.config] CHAT_UPSTREAM_URL scheme must be http or https ("${raw}"); falling back to safe default\n`
    );
    return SAFE_DEFAULT;
  }

  // hostname strips the port; check the bare host for blocked patterns.
  const host = parsed.hostname;
  if (BLOCKED_HOST_RE.test(host) || !INCLUSTER_HOST_RE.test(host)) {
    process.stderr.write(
      `[next.config] CHAT_UPSTREAM_URL host "${host}" is not an allowed in-cluster hostname; falling back to safe default\n`
    );
    return SAFE_DEFAULT;
  }

  // Return only protocol + host[:port], stripping any path or query.
  return `${parsed.protocol}//${parsed.host}`;
}

module.exports = {
  output: "standalone",
  env: {
    // Expose git SHA baked in at build time; CI should set GIT_SHA or VERCEL_GIT_COMMIT_SHA.
    NEXT_PUBLIC_GIT_SHA:
      process.env.GIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.GITHUB_SHA ??
      "dev",
  },
  // ssh2 and better-sqlite3 ship native bindings that Turbopack cannot bundle.
  // @google-cloud/firestore is a gRPC/protobuf package whose dynamic requires
  // and .proto assets do not survive bundling — left bundled, the standalone
  // output omits it and the runtime `await import("@google-cloud/firestore")`
  // in lib/config-store/firestore.ts throws MODULE_NOT_FOUND, breaking the k8s
  // Firestore config-store (cameras / scenarios / prompt read+write).
  // Mark them all as server-side externals so Node resolves them at runtime and
  // `output: standalone` traces them into .next/standalone/node_modules.
  serverExternalPackages: ["ssh2", "better-sqlite3", "cpu-features", "sshcrypto", "@google-cloud/firestore"],
  // Reverse-proxy the upstream NVIDIA VSS chat UI (metropolis-nvidia-vss-ui) behind
  // /chat/__upstream so it shares the console origin (no CORS, no second
  // SSH tunnel, and the iframe can post messages to the parent).
  // Override CHAT_UPSTREAM_URL to point at a different in-cluster hostname (validated
  // against BLOCKED_HOST_RE + INCLUSTER_HOST_RE; falls back to safe default on rejection).
  async rewrites() {
    const upstream = resolveUpstreamOrigin();
    return [
      { source: "/chat/__upstream", destination: `${upstream}/` },
      { source: "/chat/__upstream/:path*", destination: `${upstream}/:path*` },
    ];
  },
  // /capabilities was merged into /agent (config editor + tool catalog + health
  // on one page) — keep any bookmarked/linked URL landing on the unified page.
  async redirects() {
    return [{ source: "/capabilities", destination: "/agent", permanent: true }];
  },
};

module.exports = withSentryConfig(module.exports, {
  // Source-map upload only runs when SENTRY_AUTH_TOKEN is set (build-time
  // secret, passed into the Docker build). Without it the build proceeds and
  // upload is skipped — the SDK still reports events, only stack frames stay
  // minified.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  widenClientFileUpload: true,

  // Proxy API route so browser events bypass ad-blockers.
  tunnelRoute: "/monitoring",

  silent: !process.env.CI,
});

