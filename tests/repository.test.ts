import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inventoryFixture } from "../src/lib/repository/inventory";
import { extractEvidence } from "../src/lib/repository/evidence";
import { isSafeRelativePath, validateCandidateRule } from "../src/lib/schemas/investigation";

const fixture = path.resolve("tests/fixtures/legacy-pricing");
const temporary: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), "archaeologist-")); temporary.push(dir); return dir; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("repository inventory and evidence", () => {
  it("inventories the trusted fixture and extracts exact source lines", async () => {
    const inventory = await inventoryFixture("legacy-pricing", fixture);
    expect(inventory.files.map((file) => file.path)).toEqual(["pricing.js"]);
    expect(extractEvidence(inventory, "pricing.js", 5, 6).excerpt).toContain("WELCOME");
    expect(inventory.totalBytes).toBeGreaterThan(0);
  });
  it.each(["../secret.js", "/tmp/secret.js", "a//b.js", "a/./b.js", "a\\b.js", "C:/secret.js", ""])("rejects malformed path %s", (value) => {
    expect(isSafeRelativePath(value)).toBe(false);
  });
  it("excludes hidden, generated, binary, test, and linked files", async () => {
    const dir = await temp();
    await writeFile(path.join(dir, "valid.ts"), "export const x = 1;\n");
    await writeFile(path.join(dir, ".env"), "SECRET=example");
    await writeFile(path.join(dir, "ignored.test.ts"), "throw Error()");
    await writeFile(path.join(dir, "image.png"), "binary");
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "node_modules", "bad.js"), "throw Error()");
    await symlink(path.join(dir, "valid.ts"), path.join(dir, "link.ts"));
    expect((await inventoryFixture("sample", dir)).files.map((f) => f.path)).toEqual(["valid.ts"]);
  });
  it("enforces file count, per-file, and total size limits", async () => {
    const dir = await temp();
    await writeFile(path.join(dir, "a.js"), "12345");
    await writeFile(path.join(dir, "b.js"), "12345");
    await expect(inventoryFixture("sample", dir, { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 20 })).rejects.toThrow("File count");
    await expect(inventoryFixture("sample", dir, { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 20 })).rejects.toThrow("File size");
    await expect(inventoryFixture("sample", dir, { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 9 })).rejects.toThrow("Total input");
  });
  it("rejects invalid and invented evidence ranges", async () => {
    const inventory = await inventoryFixture("legacy-pricing", fixture);
    expect(() => extractEvidence(inventory, "pricing.js", 0, 1)).toThrow();
    expect(() => extractEvidence(inventory, "pricing.js", 2, 1)).toThrow();
    expect(() => extractEvidence(inventory, "pricing.js", 1, 100)).toThrow();
    expect(() => extractEvidence(inventory, "invented.js", 1, 1)).toThrow();
    expect(() => extractEvidence(inventory, "../pricing.js", 1, 1)).toThrow();
  });
  it("validates a candidate rule against actual source", async () => {
    const inventory = await inventoryFixture("legacy-pricing", fixture);
    const rule = validateCandidateRule(inventory, { id: "loyalty", explanation: "Long-term customers receive a discount", preconditions: [{ description: "At least five years" }], expectedBehavior: { description: "15% discount" }, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }], confidence: 0.8, verificationStatus: "NOT_TESTED" });
    expect(rule.evidence[0].excerpt).toContain("customerYears");
    expect(() => validateCandidateRule(inventory, { ...rule, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5, excerpt: "invented" }] })).toThrow();
  });
});
