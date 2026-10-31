import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Dashboard from "../../dashboard";

export const instant = false;
export const metadata: Metadata = {
  title: "Legacy Pricing Example — CodeArchaeologist AI",
  description:
    "Trusted fixture investigation with source evidence and isolated operator verification.",
};

async function trustedSource() {
  return readFile(
    path.resolve(process.cwd(), "tests/fixtures/legacy-pricing/pricing.js"),
    "utf8",
  );
}

export default async function LegacyPricingExample() {
  const source = await trustedSource();
  return <Dashboard source={source} />;
}
