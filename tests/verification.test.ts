import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only", () => ({}));
import { inventoryFixture } from "../src/lib/repository/inventory";
import { extractEvidence } from "../src/lib/repository/evidence";
import { PRICING_TEMPLATES, matchPricingTemplate, type PricingTemplate } from "../src/lib/verification/pricing-templates";
import { DockerPricingSandbox, executeDockerCommand, type CommandExecutor, type SandboxRunner } from "../src/lib/verification/docker-sandbox";
import { verifyInvestigation } from "../src/lib/verification/verification-engine";
import { investigateAndVerify } from "../src/lib/verification/investigate-and-verify";
import { MockModelProvider } from "../src/lib/ai/mock-provider";
import type { CandidateBusinessRule, InvestigationReport, RepositoryInventory } from "../src/types/investigation";

const fixtureRoot = path.resolve("tests/fixtures/legacy-pricing");
const inventory = () => inventoryFixture("legacy-pricing", fixtureRoot);
function rule(template: PricingTemplate, source: RepositoryInventory): CandidateBusinessRule {
  const start = Math.min(...template.requiredLines);
  const end = Math.max(...template.requiredLines);
  return { id: template.id, explanation: template.explanation, preconditions: [{ description: template.precondition }], expectedBehavior: { description: template.outcome }, confidence: 0.9, evidence: [extractEvidence(source, "pricing.js", start, end)], verificationStatus: "NOT_TESTED", supportStatus: "SUPPORTED" };
}
function report(source: RepositoryInventory, rules: CandidateBusinessRule[]): InvestigationReport {
  return { investigation: { id: "fixture", fixtureId: "legacy-pricing", status: "COMPLETED", startedAt: new Date().toISOString(), actions: [] }, inventory: source, summary: "Candidate rules", rules, rejectedHypotheses: [{ id: "rejected", reason: "Contradicted" }], limitations: ["Phase 3 sandbox execution is not implemented."] };
}
const goodOutput = (cases: readonly { id: string; expected: unknown }[]) => JSON.stringify({ observations: cases.map((item) => ({ id: item.id, ...(item.expected as object) })) });

describe("trusted verification engine", () => {
  it("matches the sanitized saved Muse subtotal claim only to reviewed cases", async () => {
    const source = await inventory();
    const savedClaim: CandidateBusinessRule = {
      id: "claim",
      explanation: "subtotalCents must be an integer >= 0 or throws 'Invalid subtotal'",
      preconditions: [],
      expectedBehavior: { description: "function enforces validation on subtotalCents input" },
      confidence: 0.9,
      evidence: [extractEvidence(source, "pricing.js", 3, 3)],
      supportStatus: "SUPPORTED",
      verificationStatus: "NOT_TESTED",
    };
    expect(matchPricingTemplate(savedClaim, source)?.id).toBe("invalid-subtotal");
    const runner = { run: vi.fn(async (cases: readonly { id: string; expected: unknown }[]) => ({ kind: "EXECUTED" as const, stdout: goodOutput(cases), stderr: "", exitCode: 0, durationMs: 1 })) };
    const result = await verifyInvestigation(report(source, [savedClaim]), runner);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run.mock.calls[0][0].map((item) => item.id)).toEqual(["negative-subtotal", "fractional-subtotal"]);
    expect(result.rules[0].verificationStatus).toBe("VERIFIED");
    expect(result.rules[0].verification?.cases).toHaveLength(2);
  });
  it("rejects misleading, contradictory, unsupported, and unpinned subtotal claims", async () => {
    const source = await inventory();
    const base: CandidateBusinessRule = {
      id: "claim", explanation: "subtotalCents must be an integer >= 0 or throws 'Invalid subtotal'",
      preconditions: [], expectedBehavior: { description: "function enforces validation on subtotalCents input" },
      confidence: 0.9, evidence: [extractEvidence(source, "pricing.js", 3, 3)],
      supportStatus: "SUPPORTED", verificationStatus: "NOT_TESTED",
    };
    const rejected: CandidateBusinessRule[] = [
      { ...base, evidence: [extractEvidence(source, "pricing.js", 4, 4)] },
      { ...base, evidence: [{ ...base.evidence[0], excerpt: "invented source" }] },
      { ...base, explanation: "promoCode throws Invalid subtotal" },
      { ...base, explanation: "subtotalCents may be fractional or throws 'Invalid subtotal'" },
      { ...base, expectedBehavior: { description: "function accepts fractional subtotalCents input" } },
      { ...base, supportStatus: "REJECTED" },
      { ...base, verificationStatus: "VERIFIED" },
      { ...base, verificationCases: PRICING_TEMPLATES[5].cases.map((item) => ({ ...item })) },
      { ...base, test: { id: "untrusted", description: "AI supplied", source: "untrusted code" } },
      { ...base, preconditions: [{ description: "unreviewed" }] },
    ];
    for (const claim of rejected) expect(matchPricingTemplate(claim, source)).toBeUndefined();
    expect(matchPricingTemplate(base, { ...source, fixtureId: "other" })).toBeUndefined();
    expect(matchPricingTemplate(base, { ...source, files: [{ ...source.files[0], content: `${source.files[0].content}\n` }] })).toBeUndefined();
    const runner = { run: vi.fn() };
    const result = await verifyInvestigation(report(source, rejected), runner);
    expect(result.rules.every((item) => item.verificationStatus === "NOT_TESTED")).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
  });
  it("verifies every reviewed pricing template against observed cases", async () => {
    const source = await inventory();
    const sandbox: SandboxRunner = { run: async (cases) => ({ kind: "EXECUTED", stdout: goodOutput(cases), stderr: "", exitCode: 0, durationMs: 12 }) };
    const result = await verifyInvestigation(report(source, PRICING_TEMPLATES.map((template) => rule(template, source))), sandbox);
    expect(result.rules).toHaveLength(6);
    expect(result.rules.every((item) => item.verificationStatus === "VERIFIED")).toBe(true);
    expect(result.rules.flatMap((item) => item.verification?.cases ?? [])).toHaveLength(13);
    expect(result.rules[0].verification?.cases?.[0]).toMatchObject({ input: { subtotalCents: 10000, customerYears: 4 }, expected: { kind: "return", value: 10000 }, observed: { kind: "return", value: 10000 }, passed: true });
    expect(result.rejectedHypotheses).toEqual([{ id: "rejected", reason: "Contradicted" }]);
    expect(result.investigation.actions.at(-1)?.kind).toBe("VERIFY");
  });
  it("fails an incorrect expectation on observed output", async () => {
    const source = await inventory();
    const sandbox: SandboxRunner = { run: async (cases) => ({ kind: "EXECUTED", stdout: JSON.stringify({ observations: cases.map((item, index) => ({ id: item.id, kind: "return", value: index === 0 ? 9999 : 8500 })) }), stderr: "", exitCode: 0, durationMs: 12 }) };
    const result = await verifyInvestigation(report(source, [rule(PRICING_TEMPLATES[0], source)]), sandbox);
    expect(result.rules[0].verificationStatus).toBe("FAILED");
    expect(result.rules[0].verification?.cases?.[0]).toMatchObject({ passed: false, observed: { kind: "return", value: 9999 } });
  });
  it("does not execute unsupported or contradicted claims", async () => {
    const source = await inventory();
    const unsupported = { ...rule(PRICING_TEMPLATES[0], source), explanation: "Customers receive no loyalty discount" };
    const runner = { run: vi.fn() };
    const result = await verifyInvestigation(report(source, [unsupported]), runner);
    expect(result.rules[0].verificationStatus).toBe("NOT_TESTED");
    expect(runner.run).not.toHaveBeenCalled();
    expect(result.rejectedHypotheses).toHaveLength(1);
  });
  it("blocks when isolation is unavailable", async () => {
    const source = await inventory();
    const sandbox: SandboxRunner = { run: async () => ({ kind: "BLOCKED", reason: "Docker unavailable", durationMs: 1 }) };
    const result = await verifyInvestigation(report(source, [rule(PRICING_TEMPLATES[0], source)]), sandbox);
    expect(result.rules[0].verification).toMatchObject({ status: "BLOCKED", reason: "Docker unavailable" });
  });
  it("reports timeout and malformed isolated output as failures", async () => {
    const source = await inventory();
    const original = report(source, [rule(PRICING_TEMPLATES[0], source)]);
    const timeout = await verifyInvestigation(original, { run: async () => ({ kind: "TIMEOUT", reason: "Container timeout", durationMs: 5000, exitCode: null }) });
    expect(timeout.rules[0].verification).toMatchObject({ status: "FAILED", reason: "Container timeout" });
    const malformed = await verifyInvestigation(original, { run: async () => ({ kind: "EXECUTED", stdout: '{"observations":[{"id":"wrong","kind":"return","value":1}]}', stderr: "", exitCode: 0, durationMs: 1 }) });
    expect(malformed.rules[0].verification).toMatchObject({ status: "FAILED", reason: "Malformed isolated runner output" });
  });
  it("keeps container runtime errors out of the report", async () => {
    const source = await inventory();
    const result = await verifyInvestigation(report(source, [rule(PRICING_TEMPLATES[0], source)]), { run: async () => ({ kind: "EXECUTED", stdout: "", stderr: "sensitive source text", exitCode: 1, durationMs: 1 }) });
    expect(result.rules[0].verification).toMatchObject({ status: "FAILED", reason: "Isolated runner exited unsuccessfully", exitCode: 1 });
    expect(JSON.stringify(result)).not.toContain("sensitive source text");
  });
  it("keeps Phase 2 behavior and opts into verification explicitly", async () => {
    const template = PRICING_TEMPLATES[0];
    const provider = new MockModelProvider([{ rules: [{ id: template.id, explanation: template.explanation, preconditions: [{ description: template.precondition }], expectedBehavior: { description: template.outcome }, confidence: 0.9, evidence: [{ path: "pricing.js", startLine: 5, endLine: 5 }] }] }, { assessments: [{ id: template.id, supported: true, reason: "Line 5 supports it" }] }]);
    const sandbox: SandboxRunner = { run: async (cases) => ({ kind: "EXECUTED", stdout: goodOutput(cases), stderr: "", exitCode: 0, durationMs: 1 }) };
    const result = await investigateAndVerify({ fixtureId: "legacy-pricing", fixtureRoot, provider }, sandbox);
    expect(result.model?.provider).toBe("MOCK");
    expect(result.rules[0].verificationStatus).toBe("VERIFIED");
    expect(result.rules[0].evidence[0].excerpt).toContain("discountPercent = 15");
  });
});

describe("Docker isolation boundary", () => {
  it("blocks before execution when the daemon is unavailable", async () => {
    const execute: CommandExecutor = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: true });
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome).toMatchObject({ kind: "BLOCKED", reason: "Docker daemon unavailable" });
  });
  it("blocks when Docker rejects container creation", async () => {
    const execute: CommandExecutor = async (args) => {
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"a".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "container") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      return { exitCode: 125, stdout: "", stderr: "runtime failed", timedOut: false };
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome).toMatchObject({ kind: "BLOCKED", reason: "Required Docker isolation controls unavailable" });
  });
  it("uses local image identity and all required isolation flags", async () => {
    const calls: string[][] = [];
    const execute: CommandExecutor = async (args, input) => {
      calls.push(args);
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp,profile=builtin"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"a".repeat(64)}`, stderr: "", timedOut: false };
      expect(input).not.toContain("BASETEN_API_KEY");
      return { exitCode: 0, stdout: goodOutput(PRICING_TEMPLATES[0].cases), stderr: "", timedOut: false };
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome.kind).toBe("EXECUTED");
    const args = calls[2].join(" ");
    for (const flag of ["-i", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=32", "--memory=128m", "--memory-swap=128m", "--cpus=0.5", "--pull=never"]) expect(args).toContain(flag);
    expect(args).toContain(`sha256:${"a".repeat(64)}`);
  });
  it("accepts confirmed absence when the container was auto-removed after timeout", async () => {
    const calls: string[][] = [];
    const execute: CommandExecutor = async (args) => {
      calls.push(args);
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "run") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (args[0] === "container") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      throw new Error("Removal should not run for an absent container");
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome.kind).toBe("TIMEOUT");
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["container", "ls"]);
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });
  it("removes a present container and confirms its absence", async () => {
    const calls: string[][] = [];
    let present = true;
    const execute: CommandExecutor = async (args) => {
      calls.push(args);
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "run") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (args[0] === "rm") { present = false; return { exitCode: 0, stdout: args[2], stderr: "", timedOut: false }; }
      if (args[0] === "container") return { exitCode: 0, stdout: present ? `${args[4].slice("--filter=name=^/".length, -1)}\n` : "", stderr: "", timedOut: false };
      throw new Error("Unexpected command");
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome.kind).toBe("TIMEOUT");
    expect(calls.filter((args) => args[0] === "container")).toHaveLength(2);
    expect(calls.find((args) => args[0] === "rm")?.[2]).toBe(calls[2].find((arg) => arg.startsWith("--name="))?.slice(7));
  });
  it("blocks when a container remains present after failed removal", async () => {
    const execute: CommandExecutor = async (args) => {
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "run") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (args[0] === "container") return { exitCode: 0, stdout: `${args[4].slice("--filter=name=^/".length, -1)}\n`, stderr: "", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "cleanup failed", timedOut: false };
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome).toMatchObject({ kind: "BLOCKED", reason: "Container absence could not be confirmed after cleanup" });
  });
  it("accepts confirmed absence even when removal reports failure", async () => {
    let inspections = 0;
    const execute: CommandExecutor = async (args) => {
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "run") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (args[0] === "container") return { exitCode: 0, stdout: inspections++ === 0 ? `${args[4].slice("--filter=name=^/".length, -1)}\n` : "", stderr: "", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "already removed", timedOut: false };
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome.kind).toBe("TIMEOUT");
    expect(inspections).toBe(2);
  });
  it("blocks when Docker inspection cannot establish absence", async () => {
    const execute: CommandExecutor = async (args) => {
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "run") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      if (args[0] === "container") return { exitCode: 1, stdout: "", stderr: "daemon unavailable", timedOut: false };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome).toMatchObject({ kind: "BLOCKED", reason: "Container absence could not be confirmed after cleanup" });
  });
  it("rejects output-limit termination after cleanup", async () => {
    const calls: string[][] = [];
    const execute: CommandExecutor = async (args) => {
      calls.push(args);
      if (args[0] === "info") return { exitCode: 0, stdout: '["name=seccomp"]', stderr: "", timedOut: false };
      if (args[0] === "image") return { exitCode: 0, stdout: `sha256:${"b".repeat(64)}`, stderr: "", timedOut: false };
      if (args[0] === "run") return { exitCode: 0, stdout: goodOutput(PRICING_TEMPLATES[0].cases), stderr: "", timedOut: false, outputLimit: true };
      if (args[0] === "container") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const outcome = await new DockerPricingSandbox(execute).run(PRICING_TEMPLATES[0].cases);
    expect(outcome).toMatchObject({ kind: "TIMEOUT", reason: "Docker CLI output exceeded limit" });
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["container", "ls"]);
  });
  it("settles a Docker CLI spawn error without waiting for close", async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = "/nonexistent-codearchaeologist-test-path";
    try {
      const result = await Promise.race([
        executeDockerCommand(["version"], "", 1_000),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("spawn promise hung")), 1_500)),
      ]);
      expect(result).toMatchObject({ spawnError: true, exitCode: null });
    } finally { process.env.PATH = previousPath; }
  });
  it("marks actual Docker CLI output overflow even if the process exits normally", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codearchaeologist-docker-test-"));
    const previousPath = process.env.PATH;
    try {
      const executable = path.join(directory, "docker");
      await writeFile(executable, "#!/bin/sh\nprintf '%17000s' x\n");
      await chmod(executable, 0o700);
      process.env.PATH = directory;
      const result = await executeDockerCommand(["version"], "", 1_000);
      expect(result.outputLimit).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(16_000);
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps timeout status when the CLI closes after the deadline", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codearchaeologist-docker-test-"));
    const previousPath = process.env.PATH;
    try {
      const executable = path.join(directory, "docker");
      await writeFile(executable, "#!/bin/sh\n/bin/sleep 0.1\n");
      await chmod(executable, 0o700);
      process.env.PATH = directory;
      let settlements = 0;
      const result = await executeDockerCommand(["version"], "", 10).then((value) => { settlements++; return value; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(result.timedOut).toBe(true);
      expect(settlements).toBe(1);
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.env.CODEARCHAEOLOGIST_DOCKER_INTEGRATION !== "1")("executes the original pricing fixture in hardened Docker", async () => {
  const source = await inventory();
  const result = await verifyInvestigation(report(source, PRICING_TEMPLATES.map((template) => rule(template, source))));
  expect(result.rules.map((item) => item.verificationStatus)).toEqual(Array(6).fill("VERIFIED"));
}, 20_000);
