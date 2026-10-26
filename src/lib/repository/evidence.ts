import type { RepositoryInventory, SourceEvidence } from "../../types/investigation";
import { validateEvidence } from "../schemas/investigation";

export function extractEvidence(inventory: RepositoryInventory, path: string, startLine: number, endLine: number): SourceEvidence {
  return validateEvidence(inventory, { path, startLine, endLine });
}
