import "server-only";
const privateJson = (value: object, status: number) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

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
