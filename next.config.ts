import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const phpParserBrowserLoader = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripts/loaders/php-parser-browser-arch-loader.cjs",
);

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
      "*.js": [
        {
          condition: {
            all: [
              "browser",
              { path: /node_modules\/php-parser\/dist\/php-parser\.js$/ },
            ],
          },
          loaders: [phpParserBrowserLoader],
          as: "*.js",
        },
      ],
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
