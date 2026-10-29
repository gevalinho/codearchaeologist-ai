import { defineConfig } from "vitest/config";

/** Explicit, paid smoke-test entry point; excluded from ordinary test runs. */
export default defineConfig({ test: { environment: "node", include: ["tests/live-smoke.test.ts"] } });
