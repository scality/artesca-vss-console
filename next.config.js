/** @type {import('next').NextConfig} */
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
  // Mark them as server-side externals so Node resolves them at runtime.
  serverExternalPackages: ["ssh2", "better-sqlite3", "cpu-features", "sshcrypto"],
  // Reverse-proxy the upstream NVIDIA VSS chat UI (metropolis-vss-ui) behind
  // /chat/__upstream so it shares the console origin (no CORS, no second
  // SSH tunnel, and the iframe can post messages to the parent).
  // Override CHAT_UPSTREAM_URL to point at a different host (e.g. when
  // running the console outside the docker-compose mdx_default network).
  async rewrites() {
    const upstream =
      process.env.CHAT_UPSTREAM_URL ?? "http://metropolis-vss-ui:3000";
    return [
      { source: "/chat/__upstream", destination: `${upstream}/` },
      { source: "/chat/__upstream/:path*", destination: `${upstream}/:path*` },
    ];
  },
};

