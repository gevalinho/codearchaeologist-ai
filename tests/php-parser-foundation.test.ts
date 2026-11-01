import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { graphFromSources } from "../src/lib/archaeology/scanner-core";
import { parsePhpSource } from "../src/lib/archaeology/php/parser";

const require = createRequire(import.meta.url);
const browserBundlePath = path.resolve(process.cwd(), "node_modules/php-parser/dist/php-parser.js");

describe("bounded PHP parser foundation", () => {
  it.each([
    ["5.6", `<?php
namespace Legacy;
use Vendor\\Base as ParentBase;
interface Savable { public function save($value); }
trait Records { public function record() {} }
class Invoice extends ParentBase implements Savable {
  use Records;
  public function save($value) {}
}
function make_invoice() {}
`],
    ["7.4", `<?php
namespace App\\Domain;
interface HasId { public function id(): int; }
trait HasTimestamp {}
class Invoice implements HasId {
  private int $id;
  public function id(): int { return $this->id; }
  public function map(): callable { return function (int $value): int { return $value; }; }
}
`],
    ["8.3", `<?php
namespace App\\Domain;
#[Attribute]
class Invoice {}
enum InvoiceState: string { case Open = 'open'; }
`],
  ])("indexes syntax supported by PHP %s", (phpVersion, source) => {
    const result = parsePhpSource("src/Invoice.php", source, { phpVersion });
    expect(result.status).toBe("complete");
    const kinds = result.symbols.map(symbol => symbol.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      "namespace",
      "class",
      ...(phpVersion === "5.6" ? ["interface", "trait", "function", "method"] : []),
      ...(phpVersion === "7.4" ? ["interface", "trait", "method"] : []),
      ...(phpVersion === "8.3" ? ["enum"] : []),
    ]));
    if (phpVersion === "5.6") expect(result.symbols.find(symbol => symbol.kind === "import")).toMatchObject({ name: "Vendor\\Base", alias: "ParentBase" });
    if (phpVersion === "8.3") expect(result.symbols.some(symbol => symbol.kind === "enum" && symbol.name === "App\\Domain\\InvoiceState")).toBe(true);
  });

  it("parses PHP 8.4 property hooks and reports older-version incompatibility", () => {
    const source = "<?php\nclass Invoice {\n  public string $name {\n    get => $this->name;\n    set => $value;\n  }\n}\n";
    expect(parsePhpSource("Invoice.php", source, { phpVersion: "8.4" }).status).toBe("complete");
    expect(parsePhpSource("Invoice.php", source, { phpVersion: "8.3" }).status).toBe("partial");
  });

  it("records exact source positions for multiline declarations", () => {
    const result = parsePhpSource("src/Invoice.php", "<?php\n\nclass Invoice {\n  public function save(\n    int $id\n  ): void {}\n}\n");
    expect(result.symbols.find(symbol => symbol.kind === "class")?.source).toMatchObject({
      startLine: 3,
      startColumn: 0,
    });
    expect(result.symbols.find(symbol => symbol.kind === "method")?.source).toMatchObject({
      startLine: 4,
      startColumn: 2,
    });
  });

  it("returns generic diagnostics for malformed source without echoing source text", () => {
    const secret = "PRIVATE_SOURCE_SENTINEL";
    const result = parsePhpSource("Broken.php", `<?php class Broken { public function leak( { ${secret}`);
    expect(result.status).toBe("partial");
    expect(result.issues.some(issue => issue.code === "syntax-error")).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });

  it("enforces source, AST-node, and AST-depth limits", () => {
    const source = "<?php class Invoice { public function save() {} }";
    expect(parsePhpSource("Invoice.php", source, { maxSourceBytes: 4 }).issues).toContainEqual({ code: "source-limit" });
    expect(parsePhpSource("Invoice.php", source, { maxAstNodes: 1 }).issues).toContainEqual({ code: "ast-node-limit" });
    expect(parsePhpSource("Invoice.php", source, { maxAstDepth: 0 }).issues).toContainEqual({ code: "ast-depth-limit" });
    expect(parsePhpSource("Invoice.php", source, { maxAstNodes: 0 }).issues).toContainEqual({ code: "ast-node-limit" });
  });

  it("uses the browser-only loader to run the parser bundle without a process global", () => {
    const loader = require("../scripts/loaders/php-parser-browser-arch-loader.cjs") as (source: string) => string;
    const source = readFileSync(browserBundlePath, "utf8");
    const transformed = loader(source);
    expect(transformed).not.toContain("process.arch");
    expect(transformed).toContain('if ("x64" == "x64")');
    expect(() => loader(source.replace("process.arch", "process.platform"))).toThrow(/Unexpected php-parser browser bundle/);

    const context: Record<string, unknown> = {};
    context.self = context;
    runInNewContext(transformed, context);
    expect(context.process).toBeUndefined();
    const exported = context.PhpParser as { Engine: new (options: object) => { parseCode: (code: string, filename: string) => { children: unknown[] } } };
    const parser = new exported.Engine({ parser: { version: 803 }, ast: { withPositions: true } });
    expect(parser.parseCode("<?php class BrowserSafe {}", "BrowserSafe.php").children).toHaveLength(1);
  });

  it("reports parser coverage in the shared graph without changing graph schema", async () => {
    const content = "<?php namespace App; class Invoice { public function save() {} }";
    const graph = await graphFromSources([{ path: "src/Invoice.php", content, bytes: Buffer.byteLength(content) }], []);
    expect(graph.schemaVersion).toBe("1.0.0");
    expect(graph.analysisCapabilities?.php).toMatchObject({
      parser: "php-parser",
      analyzedFiles: 1,
      partialFiles: 0,
      unsupportedFiles: 0,
    });
    expect(graph.analysisCapabilities?.php?.indexedSymbols).toBeGreaterThan(0);
    expect(graph.warnings).toEqual([]);
    expect(graph.limitations.some(item => item.includes("AST is never executed"))).toBe(true);
  });
});
