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
};

