import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../next.config";
import Home from "../src/app/page";
import LegacyPricingExample from "../src/app/examples/legacy-pricing/page";

describe("application routes", () => {
  it("renders the repository investigation workspace at the root", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).toContain("CODEARCHAEOLOGIST");
    expect(html).toContain('aria-label="Repository intelligence sections"');
    expect(html).toContain("Scan local repository directory");
    expect(html).toContain("Import existing graph JSON");
    expect(html).toContain("/examples/legacy-pricing");
  });
  it("permanently redirects legacy architecture bookmarks to the root", async () => {
    expect(await nextConfig.redirects?.()).toContainEqual({ source: "/architecture", destination: "/", permanent: true });
  });
  it("keeps the trusted pricing investigation at its example route", async () => {
    const html = renderToStaticMarkup(await LegacyPricingExample());
    expect(html).toContain("Legacy Pricing");
    expect(html).toContain("pricing.js");
    expect(html).toContain("Run AI investigation");
    expect(html).toContain("Load local report");
    expect(html).toContain('href="/"');
  });
});
