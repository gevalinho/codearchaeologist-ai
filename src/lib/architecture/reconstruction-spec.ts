import type { Graph, SourceRef } from "../archaeology/scanner";
import { safePath } from "./graph";

export type ReconstructionField = { id: string; label: string; type: "text" | "number" | "select"; required: boolean; options?: { value: string; label: string }[]; min?: number; max?: number };
export type ReconstructionScreen = { id: string; state: "draft" | "submitted"; title: string; description: string; fields: ReconstructionField[]; action?: { id: string; label: string; kind: "submit"; toState: "submitted" }; readOnlySummary: boolean };
export type ReconstructionSpec = { schemaVersion: "1.0.0"; id: string; featureId: string; sourceSnapshotId: string; status: "synthetic-proposal"; evidence: { ruleIds: string[]; sourceRefs: SourceRef[] }; screens: ReconstructionScreen[]; syntheticData: Record<string, string | number>; assumptions: string[]; uncertainty: string[] };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const plain = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);
const id = (value: unknown): value is string => plain(value, 160) && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const unique = (values: string[]) => new Set(values).size === values.length;
const stringList = (value: unknown, max = 12): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => plain(item));
const ref = (value: unknown): value is SourceRef => record(value) && keys(value, ["path", "startLine", "endLine"]) && safePath(value.path) && Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine) && (value.startLine as number) > 0 && (value.endLine as number) >= (value.startLine as number);
const fail = (): never => { throw new Error("Invalid reconstruction specification."); };

export function parseReconstructionSpec(value: unknown, graph?: Graph): ReconstructionSpec {
  if (!record(value)) throw new Error("Invalid reconstruction specification.");
  if (!keys(value, ["schemaVersion", "id", "featureId", "sourceSnapshotId", "status", "evidence", "screens", "syntheticData", "assumptions", "uncertainty"]) || value.schemaVersion !== "1.0.0" || !id(value.id) || !id(value.featureId) || !plain(value.sourceSnapshotId, 128) || value.status !== "synthetic-proposal" || !stringList(value.assumptions) || !stringList(value.uncertainty)) fail();
  if (!record(value.evidence) || !record(value.syntheticData)) throw new Error("Invalid reconstruction specification.");
  const evidence = value.evidence;
  if (!keys(evidence, ["ruleIds", "sourceRefs"]) || !Array.isArray(evidence.ruleIds) || evidence.ruleIds.length < 1 || evidence.ruleIds.length > 30 || !evidence.ruleIds.every((value: unknown) => plain(value, 500)) || !unique(evidence.ruleIds) || !Array.isArray(evidence.sourceRefs) || evidence.sourceRefs.length < 1 || evidence.sourceRefs.length > 30 || !evidence.sourceRefs.every(ref)) throw new Error("Invalid reconstruction specification.");
  const ruleIds = evidence.ruleIds as string[];
  if (!Array.isArray(value.screens) || value.screens.length !== 2) throw new Error("Invalid reconstruction specification.");
  const screens = value.screens;
  for (const screen of screens) {
    if (!record(screen) || !keys(screen, ["id", "state", "title", "description", "fields", "action", "readOnlySummary"]) || !id(screen.id) || !["draft", "submitted"].includes(screen.state as string) || !plain(screen.title) || !plain(screen.description) || typeof screen.readOnlySummary !== "boolean" || !Array.isArray(screen.fields) || screen.fields.length > 12) fail();
    if (screen.action !== undefined && (!record(screen.action) || !keys(screen.action, ["id", "label", "kind", "toState"]) || !id(screen.action.id) || !plain(screen.action.label) || screen.action.kind !== "submit" || screen.action.toState !== "submitted")) fail();
    for (const field of screen.fields) {
      if (!record(field) || !keys(field, ["id", "label", "type", "required", "options", "min", "max"]) || !id(field.id) || !plain(field.label) || !["text", "number", "select"].includes(field.type as string) || typeof field.required !== "boolean") fail();
      if (field.type === "select") {
        if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 12 || !field.options.every((option: unknown) => record(option) && keys(option, ["value", "label"]) && id(option.value) && plain(option.label)) || !unique(field.options.map((option: { value: string }) => option.value))) fail();
      } else if (field.options !== undefined) fail();
      if (field.type !== "number" && (field.min !== undefined || field.max !== undefined)) fail();
      if (field.min !== undefined && (!Number.isFinite(field.min) || Math.abs(field.min as number) > 1_000_000) || field.max !== undefined && (!Number.isFinite(field.max) || Math.abs(field.max as number) > 1_000_000) || field.min !== undefined && field.max !== undefined && (field.min as number) > (field.max as number)) fail();
    }
    if (!unique(screen.fields.map((field: ReconstructionField) => field.id))) fail();
  }
  const draft = screens.find((screen: ReconstructionScreen) => screen.state === "draft"), submitted = screens.find((screen: ReconstructionScreen) => screen.state === "submitted");
  if (!draft || !submitted || !draft.action || draft.readOnlySummary || draft.fields.length < 1 || submitted.action || !submitted.readOnlySummary || submitted.fields.length) fail();
  if (!unique(screens.map((screen: ReconstructionScreen) => screen.id))) fail();
  const fields = draft.fields as ReconstructionField[];
  if (Object.keys(value.syntheticData).length > fields.length || Object.entries(value.syntheticData).some(([key, item]) => {
    const field = fields.find(field => field.id === key);
    if (!field) return true;
    if (field.type === "number") return typeof item !== "number" || !Number.isFinite(item) || field.min !== undefined && item < field.min || field.max !== undefined && item > field.max;
    return typeof item !== "string" || item.length > 100 || field.type === "select" && !field.options?.some(option => option.value === item);
  })) fail();
  if (graph) {
    const rules = new Map((graph.rules ?? []).map(rule => [rule.id, rule]));
    if (value.sourceSnapshotId !== graph.snapshotId || ruleIds.some(ruleId => !rules.has(ruleId)) || evidence.sourceRefs.some((source: SourceRef) => !ruleIds.some(ruleId => { const rule = rules.get(ruleId); return rule && rule.source.path === source.path && rule.source.startLine === source.startLine && rule.source.endLine === source.endLine; }))) fail();
  }
  if (JSON.stringify(value).length > 32_000) fail();
  return value as ReconstructionSpec;
}

export type ReconstructionState = { screen: "draft" | "submitted"; values: Record<string, string | number>; error: string };
export const initialReconstructionState = (spec: ReconstructionSpec): ReconstructionState => ({ screen: "draft", values: { ...spec.syntheticData }, error: "" });
export const updateReconstructionField = (state: ReconstructionState, fieldId: string, value: string | number): ReconstructionState => ({ ...state, values: { ...state.values, [fieldId]: value }, error: "" });
export function submitReconstruction(spec: ReconstructionSpec, state: ReconstructionState): ReconstructionState {
  if (state.screen !== "draft") return state;
  for (const field of spec.screens.find(screen => screen.state === "draft")!.fields) {
    const value = state.values[field.id];
    if (field.required && (value === undefined || value === "")) return { ...state, error: `${field.label} is required for this synthetic demonstration.` };
    if (field.type === "text" && value !== undefined && (typeof value !== "string" || value.length > 100)) return { ...state, error: `${field.label} must be a short synthetic text value.` };
    if (field.type === "number" && value !== undefined && value !== "" && (typeof value !== "number" || !Number.isFinite(value) || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max)) return { ...state, error: `${field.label} is outside the proposed numeric range.` };
    if (field.type === "select" && value !== undefined && value !== "" && !field.options?.some(option => option.value === value)) return { ...state, error: `${field.label} has an invalid synthetic option.` };
  }
  return { ...state, screen: "submitted", error: "" };
}
