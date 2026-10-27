import { invoiceTotal } from "/fixture/pricing.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString("utf8");
  if (input.length > 16_000) throw new Error("Input limit exceeded");
}
const request = JSON.parse(input);
if (!Array.isArray(request.cases) || request.cases.length < 1 || request.cases.length > 16) throw new Error("Invalid case count");
const observations = request.cases.map((item) => {
  if (!item || typeof item.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(item.id) || !item.input || typeof item.input.subtotalCents !== "number" || !Number.isFinite(item.input.subtotalCents) || typeof item.input.customerYears !== "number" || !Number.isFinite(item.input.customerYears) || !(typeof item.input.promoCode === "string" || item.input.promoCode === null)) throw new Error("Invalid case input");
  try {
    const value = invoiceTotal(item.input.subtotalCents, item.input.customerYears, item.input.promoCode);
    return { id: item.id, kind: "return", value };
  } catch (error) {
    return { id: item.id, kind: "throw", message: error instanceof Error ? error.message : "Unknown thrown value" };
  }
});
process.stdout.write(JSON.stringify({ observations }));
