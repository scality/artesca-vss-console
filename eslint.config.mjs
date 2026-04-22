// Flat config for ESLint 9 — uses the native flat export from eslint-config-next v16.
import nextConfig from "eslint-config-next";

export default [
  // eslint-config-next v16 exports an array of flat config objects.
  // Spread all entries (next base + next/typescript).
  ...(Array.isArray(nextConfig) ? nextConfig : [nextConfig]),
];
