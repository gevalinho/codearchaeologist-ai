import "server-only";
import { timingSafeEqual } from "node:crypto";

const privateJson = (value: object, status: number) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

export function authorizeGitHubJob(request: Request, mutation: boolean): Response | null {
  const secret = process.env.GITHUB_INGESTION_ACCESS_KEY;
  const origin = process.env.GITHUB_INGESTION_ORIGIN;
  if (process.env.ENABLE_GITHUB_INGESTION !== "1" || !secret || secret.length < 32 || !origin || !/^https:\/\/[^/]+$/.test(origin) && !/^http:\/\/localhost(?::\d+)?$/.test(origin)) return privateJson({ error: "GitHub analysis is unavailable on this deployment." }, 503);
  const suppliedOrigin = request.headers.get("origin");
  if (mutation && suppliedOrigin !== origin || suppliedOrigin && suppliedOrigin !== origin || request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") return privateJson({ error: "Request origin is not allowed." }, 403);
  const supplied = request.headers.get("x-codearchaeologist-access-key") ?? "";
  const expectedBytes = Buffer.from(secret), suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return privateJson({ error: "GitHub analysis access key is invalid." }, 401);
  return null;
}

export async function readSmallJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("JSON request body is required.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON request body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_024) throw new Error("Request body exceeds the 1 KB limit.");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { throw new Error("Invalid JSON request body."); }
}

export const jobJson = privateJson;
