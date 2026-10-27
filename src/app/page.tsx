import { readFile } from "node:fs/promises";
import path from "node:path";
import Dashboard from "./dashboard";

async function trustedSource() {
  "use cache";
  return readFile(path.resolve(process.cwd(), "tests/fixtures/legacy-pricing/pricing.js"), "utf8");
}

export default async function Home() {
  const source = await trustedSource();
  return <Dashboard source={source} />;
}
