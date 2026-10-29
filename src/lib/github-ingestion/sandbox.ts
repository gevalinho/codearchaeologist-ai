import "server-only";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const IMAGE = "node:22-bookworm-slim";
const seccompStatusScript = 'const lines=require("node:fs").readFileSync("/proc/self/status","utf8").split(String.fromCharCode(10));for(const key of ["Seccomp","Seccomp_filters"]){const line=lines.find(value=>value.startsWith(key+":"));if(line)console.log(key+":"+line.split(":")[1].trim())}';
const trustedFiles = ["scripts/register-types.mjs", "scripts/run-github-scan.ts", "src/lib/archaeology/scanner.ts", "src/lib/archaeology/scanner-core.ts", "src/lib/archaeology/rule-patterns.ts", "src/lib/archaeology/selection.ts"];
type CommandResult = { exitCode: number | null; stdout: string; timedOut: boolean; failed: boolean };
export type DockerCommand = (args: string[], timeoutMs: number, maxOutput: number, signal?: AbortSignal) => Promise<CommandResult>;

/** B5 boundary: production web requests cannot execute Docker until a separate worker handoff exists. */
export function assertScannerProcessBoundary(): void {
  if (process.env.NODE_ENV === "production") throw new Error("Isolated scanner unavailable: production worker handoff is not configured.");
}

export const dockerCommand: DockerCommand = (args, timeoutMs, maxOutput, signal) => new Promise(resolve => {
  assertScannerProcessBoundary();
  if (signal?.aborted) { resolve({ exitCode: null, stdout: "", timedOut: false, failed: true }); return; }
  const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", NODE_ENV: "production" } });
  let stdout = "", failed = false, timedOut = false, settled = false;
  const finish = (exitCode: number | null) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(fallback); signal?.removeEventListener("abort", cancel); resolve({ exitCode, stdout, timedOut, failed }); };
  const stop = () => { child.kill("SIGKILL"); fallback ??= setTimeout(() => finish(null), 500); };
  const cancel = () => { failed = true; stop(); };
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  child.stdout.on("data", (chunk: Buffer) => { if (settled) return; if (stdout.length + chunk.length > maxOutput) { failed = true; stop(); } else stdout += chunk.toString("utf8"); });
  child.stderr.on("data", () => undefined);
  child.on("error", () => { failed = true; finish(null); });
  child.on("close", finish);
});

export async function scannerAvailable(execute: DockerCommand = dockerCommand): Promise<string> {
  assertScannerProcessBoundary();
  const info = await execute(["info", "--format", "{{json .SecurityOptions}}"], 2_500, 4_096);
  if (info.exitCode !== 0 || info.timedOut || info.failed) throw new Error("Isolated scanner unavailable: Docker daemon cannot be reached.");
  let options: unknown;
  try { options = JSON.parse(info.stdout); } catch { throw new Error("Isolated scanner unavailable: Docker security options are unreadable."); }
  if (!Array.isArray(options) || !options.some(value => typeof value === "string" && (value === "name=seccomp" || /^name=seccomp,profile=[A-Za-z0-9._/-]+$/.test(value)))) throw new Error("Isolated scanner unavailable: Docker does not report seccomp support.");
  const image = await execute(["image", "inspect", IMAGE, "--format", "{{.Id}}"], 2_500, 256);
  if (image.exitCode !== 0 || image.timedOut || image.failed || !/^sha256:[a-f0-9]{64}$/.test(image.stdout.trim())) throw new Error("Isolated scanner unavailable: trusted local Node image is missing.");
  const probe = async (profile: "unconfined" | "builtin") => execute(["run", "--rm", "--pull=never", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", `--security-opt=seccomp=${profile}`, "--pids-limit=32", "--memory=128m", "--memory-swap=128m", "--cpus=0.5", image.stdout.trim(), "node", "-e", seccompStatusScript], 5_000, 128);
  const baseline = await probe("unconfined"), enforced = await probe("builtin");
  const filters = (result: CommandResult): number | null => {
    if (result.exitCode !== 0 || result.timedOut || result.failed) return null;
    const match = /^Seccomp:2\nSeccomp_filters:([0-9]+)\n?$/.exec(result.stdout.trimEnd());
    return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
  };
  const baselineCount = filters(baseline), enforcedCount = filters(enforced);
  if (baselineCount === null || enforcedCount === null || enforcedCount <= baselineCount) throw new Error("Isolated scanner unavailable: Docker seccomp enforcement could not be verified. Enable the built-in profile for scanner containers.");
  return image.stdout.trim();
}

async function stageRunner(root: string) {
  const runner = path.join(root, "runner");
  for (const relative of trustedFiles) {
    const target = path.join(runner, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(path.resolve(process.cwd(), relative), target);
    await chmod(target, 0o644);
  }
  return runner;
}

async function containerAbsent(name: string, execute: DockerCommand): Promise<boolean> {
  const check = async () => {
    const result = await execute(["container", "ls", "-a", "--no-trunc", `--filter=name=^/${name}$`, "--format", "{{.Names}}"], 2_500, 512);
    return result.exitCode === 0 && !result.failed && !result.timedOut && !result.stdout.trim();
  };
  if (await check()) return true;
  await execute(["rm", "-f", name], 2_500, 512);
  return check();
}

export async function runIsolatedScanner(root: string, imageId: string, signal: AbortSignal, execute: DockerCommand = dockerCommand): Promise<string> {
  assertScannerProcessBoundary();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Invalid scanner image identity.");
  const runner = await stageRunner(root);
  const name = `codearchaeologist-scan-${randomUUID()}`;
  const args = ["run", "--rm", "--pull=never", `--name=${name}`, "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--security-opt=seccomp=builtin", "--pids-limit=32", "--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m", "--workdir=/runner", `--mount=type=bind,src=${path.join(root, "repo")},dst=/repo,readonly`, `--mount=type=bind,src=${runner},dst=/runner,readonly`, imageId, "node", "--experimental-transform-types", "--import", "/runner/scripts/register-types.mjs", "/runner/scripts/run-github-scan.ts"];
  const result = await execute(args, 30_000, 6 * 1024 * 1024, signal);
  if (!await containerAbsent(name, execute)) throw new Error("Isolated scanner cleanup could not be confirmed.");
  if (signal.aborted) throw new Error("GitHub analysis cancelled.");
  if (result.timedOut) throw new Error("Isolated scanner exceeded its 30-second limit.");
  if (result.failed || result.exitCode !== 0) throw new Error("Isolated scanner failed. Check Docker availability and scanner limits.");
  return result.stdout;
}
