import { DEFAULT_SCAN_LIMITS } from "../archaeology/selection";

export type EligibleTreeFile = { path: string; size: number; sha: string; mode: string; type: string };

const role = (path: string): number => {
  const parts = path.toLowerCase().split("/");
  if (parts.some(part => /^controllers?$/.test(part))) return 0;
  if (parts.some(part => /^models?$/.test(part))) return 1;
  if (parts.some(part => /^(?:services?|actions?|repositories?)$/.test(part))) return 2;
  if (parts.some(part => /^routes?$/.test(part))) return 3;
  if (["app", "application", "src", "wp-content"].includes(parts[0])) return 4;
  return 5;
};
const directory = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Round-robin by architectural role and parent directory; never reads source bodies. */
export function selectBoundedSource(files: readonly EligibleTreeFile[]): EligibleTreeFile[] {
  const groups = Array.from({ length: 6 }, () => new Map<string, EligibleTreeFile[]>());
  for (const file of files) {
    const bucket = groups[role(file.path)], dir = directory(file.path);
    const entries = bucket.get(dir);
    if (entries) entries.push(file); else bucket.set(dir, [file]);
  }
  const queues = groups.map(bucket => [...bucket].sort(([left], [right]) => left.localeCompare(right)).map(([, entries]) => entries.sort((a, b) => a.path.localeCompare(b.path))));
  const cursors = queues.map(queue => new Array(queue.length).fill(0) as number[]);
  const nextGroup = queues.map(() => 0);
  const selected: EligibleTreeFile[] = [];
  let totalBytes = 0;
  const weight = [0, 1, 2, 3, 0, 1, 2, 3, 4, 5];
  let remaining = files.length;
  while (remaining > 0 && selected.length < DEFAULT_SCAN_LIMITS.maxFiles) {
    let advanced = false;
    for (const roleIndex of weight) {
      const queue = queues[roleIndex], positions = cursors[roleIndex];
      for (let offset = 0; offset < queue.length && selected.length < DEFAULT_SCAN_LIMITS.maxFiles; offset++) {
        const group = (nextGroup[roleIndex] + offset) % queue.length;
        const index = positions[group];
        if (index >= queue[group].length) continue;
        positions[group]++; remaining--; advanced = true;
        nextGroup[roleIndex] = (group + 1) % queue.length;
        const file = queue[group][index];
        if (file.size > DEFAULT_SCAN_LIMITS.maxFileBytes || totalBytes + file.size > DEFAULT_SCAN_LIMITS.maxTotalBytes) continue;
        selected.push(file); totalBytes += file.size;
        break;
      }
      if (selected.length >= DEFAULT_SCAN_LIMITS.maxFiles) break;
    }
    if (!advanced) break;
  }
  return selected.sort((a, b) => a.path.localeCompare(b.path));
}
