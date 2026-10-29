import { describe, expect, it } from "vitest";
import { repositorySelection } from "../src/app/architecture/workspace";

const repositories = [
  { id: 1377149493, installationId: 176154930 },
  { id: 42, installationId: 176154930 },
];

describe("GitHub repository selection", () => {
  it("shows an authorized repository after a successful refresh", () => {
    expect(repositorySelection(repositories, "")).toBe("176154930:1377149493");
  });

  it("preserves a valid selection and clears a selection when access is removed", () => {
    expect(repositorySelection(repositories, "176154930:42")).toBe("176154930:42");
    expect(repositorySelection([], "176154930:42")).toBe("");
  });
});
