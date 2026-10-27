import "server-only";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationCase } from "../../types/investigation";
import { PRICING_SOURCE_SHA256 } from "./pricing-templates";

const IMAGE = "node:22-bookworm-slim";
const MAX_OUTPUT = 16_000;
const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/legacy-pricing/pricing.js");
const RUNNER = path.resolve(process.cwd(), "src/lib/verification/container-runner.mjs");

export interface CommandResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; outputLimit?: boolean; spawnError?: boolean }
export type CommandExecutor = (args: string[], input: string, timeoutMs: number) => Promise<CommandResult>;
export type SandboxResult =
  | { kind: "BLOCKED"; reason: string; durationMs: number }
  | { kind: "TIMEOUT"; reason: string; durationMs: number; exitCode: number | null }
  | { kind: "EXECUTED"; stdout: string; stderr: string; exitCode: number | null; durationMs: number };
export interface SandboxRunner { run(cases: readonly VerificationCase[]): Promise<SandboxResult> }

/** Executes only the Docker CLI; fixture code runs solely inside the container. */
export const executeDockerCommand: CommandExecutor = (args, input, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputLimit = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: CommandResult) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(terminationTimer); resolve(result); } };
  const child = spawn("docker", args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", NODE_ENV: "production" },
  });
  const terminate = () => {
    child.kill("SIGKILL");
    // A CLI that does not emit close must not hold verification indefinitely.
    terminationTimer ??= setTimeout(() => finish({ exitCode: null, stdout, stderr, timedOut, outputLimit }), 250);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { if (settled) return; if (stdout.length + chunk.length > MAX_OUTPUT) { stdout += chunk.slice(0, MAX_OUTPUT - stdout.length); outputLimit = true; terminate(); } else stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { if (settled) return; if (stderr.length + chunk.length > MAX_OUTPUT) { stderr += chunk.slice(0, MAX_OUTPUT - stderr.length); outputLimit = true; terminate(); } else stderr += chunk; });
  child.on("error", () => finish({ exitCode: null, stdout: "", stderr: "", timedOut, outputLimit, spawnError: true }));
  child.on("close", (exitCode) => finish({ exitCode, stdout, stderr, timedOut, outputLimit }));
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
});

export class DockerPricingSandbox implements SandboxRunner {
  constructor(private readonly execute: CommandExecutor = executeDockerCommand) {}

  private async bounded(args: string[]): Promise<CommandResult | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.execute(args, "", 2_000),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2_250); }),
      ]);
    } catch { return undefined; }
    finally { clearTimeout(timer); }
  }

  private async containerPresent(name: string): Promise<boolean | undefined> {
    const result = await this.bounded(["container", "ls", "-a", "--no-trunc", `--filter=name=^/${name}$`, "--format", "{{.Names}}"]);
    if (!result || result.spawnError || result.timedOut || result.outputLimit || result.exitCode !== 0) return undefined;
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return false;
    return lines.length === 1 && lines[0] === name ? true : undefined;
  }

  private async confirmContainerAbsent(name: string): Promise<boolean> {
    const present = await this.containerPresent(name);
    if (present === false) return true;
    // An unavailable first inspection still gets one bounded removal attempt.
    await this.bounded(["rm", "-f", name]);
    return await this.containerPresent(name) === false;
  }

  async run(cases: readonly VerificationCase[]): Promise<SandboxResult> {
    const start = performance.now();
    const blocked = (reason: string): SandboxResult => ({ kind: "BLOCKED", reason, durationMs: performance.now() - start });
    if (cases.length < 1 || cases.length > 16 || new Set(cases.map((c) => c.id)).size !== cases.length) return blocked("Invalid trusted case set");
    try {
      const fixtureStat = await lstat(FIXTURE);
      const runnerStat = await lstat(RUNNER);
      if (!fixtureStat.isFile() || fixtureStat.isSymbolicLink() || !runnerStat.isFile() || runnerStat.isSymbolicLink()) return blocked("Trusted source or runner is not a regular file");
      const bytes = await readFile(FIXTURE);
      if (createHash("sha256").update(bytes).digest("hex") !== PRICING_SOURCE_SHA256) return blocked("Trusted pricing fixture changed");
    } catch { return blocked("Trusted verification files unavailable"); }

    const info = await this.execute(["info", "--format", "{{json .SecurityOptions}}"], "", 2_000);
    if (info.spawnError || info.timedOut || info.outputLimit || info.exitCode !== 0) return blocked("Docker daemon unavailable");
    let securityOptions: unknown;
    try { securityOptions = JSON.parse(info.stdout); } catch { return blocked("Docker security configuration unavailable"); }
    if (!Array.isArray(securityOptions) || !securityOptions.some((value) => typeof value === "string" && value.includes("seccomp"))) return blocked("Docker seccomp protection unavailable");
    const inspected = await this.execute(["image", "inspect", IMAGE, "--format", "{{.Id}}"], "", 2_000);
    if (inspected.spawnError || inspected.timedOut || inspected.outputLimit || inspected.exitCode !== 0) return blocked("Trusted local Node image unavailable");
    const imageId = inspected.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) return blocked("Invalid local image identity");

    const name = `codearchaeologist-verify-${randomUUID()}`;
    const args = [
      "run", "-i", "--rm", "--pull=never", `--name=${name}`, "--network=none", "--read-only",
      "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--pids-limit=32", "--memory=128m", "--memory-swap=128m", "--cpus=0.5",
      "--tmpfs=/tmp:rw,noexec,nosuid,size=16m", "--workdir=/tmp",
      `--mount=type=bind,src=${FIXTURE},dst=/fixture/pricing.mjs,readonly`,
      `--mount=type=bind,src=${RUNNER},dst=/runner/execute.mjs,readonly`,
      imageId, "node", "/runner/execute.mjs",
    ];
    const result = await this.execute(args, JSON.stringify({ cases: cases.map(({ id, input }) => ({ id, input })) }), 5_000);
    if (result.timedOut || result.outputLimit || result.spawnError || result.exitCode !== 0) {
      if (!await this.confirmContainerAbsent(name)) return blocked("Container absence could not be confirmed after cleanup");
      if (result.outputLimit) return { kind: "TIMEOUT", reason: "Docker CLI output exceeded limit", durationMs: performance.now() - start, exitCode: result.exitCode };
      if (result.timedOut) return { kind: "TIMEOUT", reason: "Container exceeded five-second limit", durationMs: performance.now() - start, exitCode: result.exitCode };
      if (result.spawnError) return blocked("Docker CLI failed to start");
    }
    if (result.exitCode !== 0 && ([125, 126, 127].includes(result.exitCode ?? -1) || /(?:permission denied|unknown flag|invalid argument|operation not permitted)/i.test(result.stderr))) return blocked("Required Docker isolation controls unavailable");
    return { kind: "EXECUTED", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: performance.now() - start };
  }
}
