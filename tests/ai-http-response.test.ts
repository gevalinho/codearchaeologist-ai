import { describe, expect, it } from "vitest";
import { readAiJsonResponse, serializeBoundedChatRequest } from "../src/lib/architecture/ai-http-response";

describe("AI HTTP response handling", () => {
  it("parses a valid JSON object response", async () => {
    await expect(readAiJsonResponse(new Response(JSON.stringify({ answer: "supported" }), { status: 200 })))
      .resolves.toEqual({ answer: "supported" });
  });

  it("reports empty and malformed responses with a useful HTTP status", async () => {
    await expect(readAiJsonResponse(new Response(null, { status: 502 })))
      .rejects.toThrow("empty response (HTTP 502)");
    await expect(readAiJsonResponse(new Response("<html>upstream failure</html>", { status: 502 })))
      .rejects.toThrow("invalid response (HTTP 502)");
  });

  it("drops only the oldest whole chat turns when necessary to stay within the request byte limit", () => {
    const history = Array.from({ length: 3 }, (_, index) => [
      { role: "user" as const, text: `Question ${index}` },
      { role: "assistant" as const, text: `Answer ${index} ${"x".repeat(800)}`, evidenceIds: ["evidence-1"] },
    ]).flat();
    const body = serializeBoundedChatRequest({
      consent: true,
      question: "What does this repository show?",
      packet: { snapshotId: "snapshot", evidence: "x".repeat(17_800) },
      history,
    });
    const parsed = JSON.parse(body);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(20_000);
    expect(parsed.history).toEqual(history.slice(-4));
  });

  it("fails clearly when evidence alone cannot fit the bounded request", () => {
    expect(() => serializeBoundedChatRequest({
      consent: true,
      question: "Review this",
      packet: { evidence: "x".repeat(20_000) },
      history: [],
    })).toThrow("exceeds the bounded request limit");
  });
});
