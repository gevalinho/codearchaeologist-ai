import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [
      "**/.env",
      "**/.env.*",
      "**/.git",
      "**/.git/**",
      "./docs/**",
      "./tests/*.test.ts",
      "./tests/*.test.tsx",
      "./tests/fixtures/architecture/**",
    ],
  },
  cacheComponents: true,
  partialPrefetching: true,
  devIndicators: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
        port: "",
        pathname: "/**",
        search: "?s=128",
      },
    ],
  },
  async redirects() {
    return [{ source: "/architecture", destination: "/", permanent: true }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
