import type { Edge, Graph, Node, SourceRef } from "../archaeology/scanner";

export const ARCHITECTURE_HEALTH_THRESHOLDS = {
  oversizedLines: 200,
  veryOversizedLines: 400,
  concentratedMethods: 15,
  veryConcentratedMethods: 25,
  concentratedDependencies: 8,
  veryConcentratedDependencies: 15,
  mixedTopicMethodsPerGroup: 2,
  mixedTopicGroups: 2,
  maximumNodes: 20_000,
  maximumEdges: 50_000,
  maximumFindings: 500,
  maximumEvidenceItems: 100,
} as const;

export type HealthCategory =
  | "oversized-component"
  | "method-concentration"
  | "mixed-responsibility-signal"
  | "dependency-concentration";
export type ReviewPriority = "high" | "medium" | "low";
type EvidenceBasis = "observed-structure" | "heuristic";

export type HealthMetric = {
  label: string;
  value: number | string;
  threshold: string;
  basis: EvidenceBasis;
};

export type ArchitectureHealthFinding = {
  id: string;
  category: HealthCategory;
  categoryLabel: string;
  component: Node;
  sourcePath: string | null;
  priority: ReviewPriority;
  severity: "high" | "moderate" | "review";
  priorityExplanation: string;
  explanation: string;
  basis: EvidenceBasis;
  metrics: HealthMetric[];
  evidence: {
    nodes: Node[];
    edges: Edge[];
    sourceRefs: SourceRef[];
    totalNodes: number;
    totalEdges: number;
    totalSourceRefs: number;
    truncated: boolean;
  };
  limitations: string[];
  nextSteps: string[];
};

export type ArchitectureHealthResult = {
  findings: ArchitectureHealthFinding[];
  totalFindings: number;
  componentsRequiringAttention: number;
  categoryCounts: Record<HealthCategory, number>;
  priorityCounts: Record<ReviewPriority, number>;
  truncatedFindings: boolean;
  analysisSkipped: boolean;
  limitMessage: string | null;
  limitations: string[];
};

const categoryLabels: Record<HealthCategory, string> = {
  "oversized-component": "Large source span",
  "method-concentration": "Method concentration",
  "mixed-responsibility-signal": "Mixed-topic naming signal",
  "dependency-concentration": "Dependency concentration",
};

const componentKinds = new Set<Node["kind"]>([
  "class",
  "controller",
  "service",
  "factory",
  "component",
]);
const ignoredRelationshipKinds = new Set(["declares", "registers"]);
const actionWords = new Set([
  "add", "assign", "build", "call", "check", "clean", "clear", "close",
  "compute", "configure", "create", "delete", "destroy", "dispatch", "do",
  "edit", "execute", "fetch", "find", "get", "handle", "has", "index",
  "init", "initialize", "is", "list", "load", "make", "open", "process",
  "read", "remove", "render", "reset", "save", "send", "set", "show",
  "store", "update", "validate", "write",
]);
const genericWords = new Set(["a", "all", "an", "by", "for", "from", "id", "of", "the"]);
const priorityRank: Record<ReviewPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

type EvidenceBucket = {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
};

function validSource(source: SourceRef | undefined): source is SourceRef {
  return !!source &&
    typeof source.path === "string" &&
    source.path.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(source.path) &&
    Number.isSafeInteger(source.startLine) &&
    Number.isSafeInteger(source.endLine) &&
    source.startLine > 0 &&
    source.endLine >= source.startLine;
}

function sourceKey(source: SourceRef): string {
  return `${source.path}:${source.startLine}:${source.endLine}`;
}

function sourceLineCount(source: SourceRef): number | null {
  return validSource(source) ? source.endLine - source.startLine + 1 : null;
}

function methodTopic(method: Node): string | null {
  const name = method.name.split("#").at(-1)?.split("::").at(-1) ?? "";
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
    .filter((word) => !actionWords.has(word) && !genericWords.has(word))
    .map((word) => word.endsWith("ies")
      ? `${word.slice(0, -3)}y`
      : word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word);
  return words[0] ?? null;
}

function addEvidenceNode(bucket: EvidenceBucket, node: Node | undefined): void {
  if (node) bucket.nodes.set(node.id, node);
}

function addEvidenceEdge(bucket: EvidenceBucket, edge: Edge): void {
  bucket.edges.set(edge.id, edge);
}

function makeFinding(
  input: Omit<ArchitectureHealthFinding, "evidence" | "sourcePath"> & {
    evidence: EvidenceBucket;
  },
): ArchitectureHealthFinding {
  const allNodes = [...input.evidence.nodes.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const allEdges = [...input.evidence.edges.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const allSourceRefs = new Map<string, SourceRef>();
  for (const node of allNodes) {
    if (validSource(node.source)) allSourceRefs.set(sourceKey(node.source), node.source);
  }
  for (const edge of allEdges) {
    if (validSource(edge.source)) allSourceRefs.set(sourceKey(edge.source), edge.source);
  }
  if (validSource(input.component.source)) {
    allSourceRefs.set(sourceKey(input.component.source), input.component.source);
  }
  const sourceRefs = [...allSourceRefs.values()]
    .sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine,
    );
  const evidenceLimit = ARCHITECTURE_HEALTH_THRESHOLDS.maximumEvidenceItems;
  const componentSourcePath = typeof input.component.source?.path === "string" &&
      input.component.source.path.trim()
    ? input.component.source.path
    : null;
  return {
    ...input,
    sourcePath: validSource(input.component.source)
      ? input.component.source.path
      : componentSourcePath,
    evidence: {
      nodes: allNodes.slice(0, evidenceLimit),
      edges: allEdges.slice(0, evidenceLimit),
      sourceRefs: sourceRefs.slice(0, evidenceLimit),
      totalNodes: allNodes.length,
      totalEdges: allEdges.length,
      totalSourceRefs: sourceRefs.length,
      truncated:
        allNodes.length > evidenceLimit ||
        allEdges.length > evidenceLimit ||
        sourceRefs.length > evidenceLimit,
    },
  };
}

function createBucket(component: Node): EvidenceBucket {
  return { nodes: new Map([[component.id, component]]), edges: new Map() };
}

function limitationList(
  component: Node,
  methods: Node[],
  edges: Edge[],
): string[] {
  const limitations = new Set<string>();
  if (!validSource(component.source)) {
    limitations.add("The component source reference is incomplete; line-span measurement and source navigation are unavailable.");
  }
  if (methods.some((method) => !validSource(method.source))) {
    limitations.add("Some declared methods lack usable source references.");
  }
  if (edges.some((edge) => edge.certainty === "inferred")) {
    limitations.add("Inferred relationships are not included in confirmed structural counts.");
  }
  return [...limitations];
}

function makeEmptyResult(
  message: string,
  limitations: string[] = [],
): ArchitectureHealthResult {
  return {
    findings: [],
    totalFindings: 0,
    componentsRequiringAttention: 0,
    categoryCounts: {
      "oversized-component": 0,
      "method-concentration": 0,
      "mixed-responsibility-signal": 0,
      "dependency-concentration": 0,
    },
    priorityCounts: { high: 0, medium: 0, low: 0 },
    truncatedFindings: false,
    analysisSkipped: true,
    limitMessage: message,
    limitations,
  };
}

export function analyzeArchitectureHealth(graph: Graph): ArchitectureHealthResult {
  if (
    graph.nodes.length > ARCHITECTURE_HEALTH_THRESHOLDS.maximumNodes ||
    graph.edges.length > ARCHITECTURE_HEALTH_THRESHOLDS.maximumEdges
  ) {
    return makeEmptyResult(
      `Health analysis is limited to ${ARCHITECTURE_HEALTH_THRESHOLDS.maximumNodes.toLocaleString()} nodes and ${ARCHITECTURE_HEALTH_THRESHOLDS.maximumEdges.toLocaleString()} edges. This graph exceeds that bound, so no partial findings are shown.`,
    );
  }

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const components = graph.nodes
    .filter((node) => componentKinds.has(node.kind))
    .sort((left, right) => left.id.localeCompare(right.id));
  const componentIds = new Set(components.map((node) => node.id));
  const methodsByComponent = new Map<string, Map<string, Node>>();
  const declarationsByComponent = new Map<string, Map<string, Edge>>();
  const relationshipsByComponent = new Map<
    string,
    {
      incoming: Map<string, Map<string, Edge>>;
      outgoing: Map<string, Map<string, Edge>>;
    }
  >();

  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;

    if (edge.kind === "declares" && componentIds.has(from.id) && to.kind === "method") {
      if (!methodsByComponent.has(from.id)) {
        methodsByComponent.set(from.id, new Map());
        declarationsByComponent.set(from.id, new Map());
      }
      if (edge.certainty === "observed") {
        methodsByComponent.get(from.id)!.set(to.id, to);
        declarationsByComponent.get(from.id)!.set(edge.id, edge);
      }
    }

    if (
      edge.certainty !== "observed" ||
      ignoredRelationshipKinds.has(edge.kind) ||
      from.id === to.id
    ) continue;

    if (componentIds.has(from.id)) {
      const relationships = relationshipsByComponent.get(from.id) ?? {
        incoming: new Map<string, Map<string, Edge>>(),
        outgoing: new Map<string, Map<string, Edge>>(),
      };
      const neighborEdges = relationships.outgoing.get(to.id) ?? new Map<string, Edge>();
      neighborEdges.set(edge.id, edge);
      relationships.outgoing.set(to.id, neighborEdges);
      relationshipsByComponent.set(from.id, relationships);
    }
    if (componentIds.has(to.id)) {
      const relationships = relationshipsByComponent.get(to.id) ?? {
        incoming: new Map<string, Map<string, Edge>>(),
        outgoing: new Map<string, Map<string, Edge>>(),
      };
      const neighborEdges = relationships.incoming.get(from.id) ?? new Map<string, Edge>();
      neighborEdges.set(edge.id, edge);
      relationships.incoming.set(from.id, neighborEdges);
      relationshipsByComponent.set(to.id, relationships);
    }
  }

  const findings: ArchitectureHealthFinding[] = [];
  const categoryCounts: Record<HealthCategory, number> = {
    "oversized-component": 0,
    "method-concentration": 0,
    "mixed-responsibility-signal": 0,
    "dependency-concentration": 0,
  };
  const priorityCounts: Record<ReviewPriority, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  const affectedComponents = new Set<string>();
  const appendFinding = (finding: ArchitectureHealthFinding) => {
    findings.push(finding);
    categoryCounts[finding.category]++;
    priorityCounts[finding.priority]++;
    affectedComponents.add(finding.component.id);
  };

  for (const component of components) {
    const methods = [...(methodsByComponent.get(component.id)?.values() ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id));
    const declarationEdges = [
      ...(declarationsByComponent.get(component.id)?.values() ?? []),
    ];
    const relationships = relationshipsByComponent.get(component.id) ?? {
      incoming: new Map<string, Map<string, Edge>>(),
      outgoing: new Map<string, Map<string, Edge>>(),
    };
    const allRelationships = [
      ...[...relationships.incoming.values()].flatMap((edges) => [...edges.values()]),
      ...[...relationships.outgoing.values()].flatMap((edges) => [...edges.values()]),
    ];
    const limitations = limitationList(component, methods, [
      ...declarationEdges,
      ...allRelationships,
    ]);

    const lineCount = sourceLineCount(component.source);
    if (
      (component.kind === "controller" || component.kind === "class") &&
      component.certainty === "observed" &&
      lineCount !== null &&
      lineCount >= ARCHITECTURE_HEALTH_THRESHOLDS.oversizedLines
    ) {
      const severe = lineCount >= ARCHITECTURE_HEALTH_THRESHOLDS.veryOversizedLines;
      const bucket = createBucket(component);
      for (const method of methods) addEvidenceNode(bucket, method);
      for (const edge of declarationEdges) addEvidenceEdge(bucket, edge);
      appendFinding(makeFinding({
        id: `oversized-component:${component.id}`,
        category: "oversized-component",
        categoryLabel: categoryLabels["oversized-component"],
        component,
        priority: severe ? "high" : "medium",
        severity: severe ? "high" : "moderate",
        priorityExplanation: severe
          ? "The measured source span is at least twice the review threshold; inspect it early, but size alone does not establish a design defect."
          : "The measured source span crossed the review threshold and merits a closer look; size alone does not establish a design defect.",
        explanation: `The extracted source reference spans ${lineCount} lines. This is a structural size indicator, not proof of excessive complexity or a design violation.`,
        basis: "observed-structure",
        metrics: [{
          label: "Measured source span",
          value: lineCount,
          threshold: `≥ ${ARCHITECTURE_HEALTH_THRESHOLDS.oversizedLines} lines; high review priority at ≥ ${ARCHITECTURE_HEALTH_THRESHOLDS.veryOversizedLines}`,
          basis: "observed-structure",
        }],
        evidence: bucket,
        limitations: [
          ...limitations,
          "Line spans measure the cited source range only; they do not measure complexity, runtime behavior, or responsibility cohesion.",
        ],
        nextSteps: [
          "Inspect cohesive method groups and their source references.",
          "Review incoming routes and downstream calls before proposing a boundary.",
          "If responsibilities appear separable, refactor incrementally with regression tests.",
        ],
      }));
    }

    const methodCount = methods.length;
    if (methodCount >= ARCHITECTURE_HEALTH_THRESHOLDS.concentratedMethods) {
      const severe = methodCount >= ARCHITECTURE_HEALTH_THRESHOLDS.veryConcentratedMethods;
      const bucket = createBucket(component);
      for (const method of methods) addEvidenceNode(bucket, method);
      for (const edge of declarationEdges) addEvidenceEdge(bucket, edge);
      appendFinding(makeFinding({
        id: `method-concentration:${component.id}`,
        category: "method-concentration",
        categoryLabel: categoryLabels["method-concentration"],
        component,
        priority: severe ? "high" : "medium",
        severity: severe ? "high" : "moderate",
        priorityExplanation: severe
          ? "The component has at least 25 observed declared methods; investigate method cohesion and change frequency."
          : "The component has at least 15 observed declared methods; review method grouping and cohesion.",
        explanation: `${methodCount} distinct methods are connected by observed declaration relationships. A method count alone does not establish poor design.`,
        basis: "observed-structure",
        metrics: [{
          label: "Observed declared methods",
          value: methodCount,
          threshold: `≥ ${ARCHITECTURE_HEALTH_THRESHOLDS.concentratedMethods}; high review priority at ≥ ${ARCHITECTURE_HEALTH_THRESHOLDS.veryConcentratedMethods}`,
          basis: "observed-structure",
        }],
        evidence: bucket,
        limitations: [
          ...limitations,
          "Only methods connected by observed `declares` edges are counted; incomplete extraction can undercount methods.",
        ],
        nextSteps: [
          "Group the listed methods by cohesive behavior before considering extraction.",
          "Inspect incoming routes and downstream dependencies for each group.",
          "Add regression tests before making incremental changes.",
        ],
      }));
    }

    const topics = new Map<string, Node[]>();
    for (const method of methods) {
      const topic = methodTopic(method);
      if (!topic) continue;
      topics.set(topic, [...(topics.get(topic) ?? []), method]);
    }
    const repeatedTopics = [...topics]
      .filter(([, topicMethods]) =>
        topicMethods.length >= ARCHITECTURE_HEALTH_THRESHOLDS.mixedTopicMethodsPerGroup,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    if (
      repeatedTopics.length >= ARCHITECTURE_HEALTH_THRESHOLDS.mixedTopicGroups
    ) {
      const bucket = createBucket(component);
      const topicMethodIds = new Set<string>();
      for (const [, topicMethods] of repeatedTopics) {
        for (const method of topicMethods) {
          topicMethodIds.add(method.id);
          addEvidenceNode(bucket, method);
        }
      }
      for (const edge of declarationEdges) {
        if (topicMethodIds.has(edge.to)) addEvidenceEdge(bucket, edge);
      }
      const topicsLabel = repeatedTopics
        .map(([topic, topicMethods]) => `${topic} (${topicMethods.length})`)
        .join(", ");
      appendFinding(makeFinding({
        id: `mixed-responsibility-signal:${component.id}`,
        category: "mixed-responsibility-signal",
        categoryLabel: categoryLabels["mixed-responsibility-signal"],
        component,
        priority: "low",
        severity: "review",
        priorityExplanation: "This low-priority naming signal is a prompt for investigation, not a confirmed responsibility boundary or Single Responsibility Principle violation.",
        explanation: `Method names form repeated topic groups: ${topicsLabel}. Naming patterns can be misleading and should be checked against behavior and source.`,
        basis: "heuristic",
        metrics: [{
          label: "Repeated method-name topics",
          value: topicsLabel,
          threshold: `${ARCHITECTURE_HEALTH_THRESHOLDS.mixedTopicGroups}+ distinct topics, each appearing in ${ARCHITECTURE_HEALTH_THRESHOLDS.mixedTopicMethodsPerGroup}+ observed declared methods`,
          basis: "heuristic",
        }],
        evidence: bucket,
        limitations: [
          ...limitations,
          "Topics are inferred from method names only; naming is not proof of separate responsibilities or an SRP violation.",
        ],
        nextSteps: [
          "Inspect each method-name group and verify whether the methods share behavior and domain rules.",
          "Compare the groups with incoming routes and their downstream dependencies.",
          "Treat service extraction only as a hypothesis; validate it with tests and maintainers.",
        ],
      }));
    }

    const incomingCount = relationships.incoming.size;
    const outgoingCount = relationships.outgoing.size;
    const concentrated = Math.max(incomingCount, outgoingCount);
    if (concentrated >= ARCHITECTURE_HEALTH_THRESHOLDS.concentratedDependencies) {
      const severe = concentrated >= ARCHITECTURE_HEALTH_THRESHOLDS.veryConcentratedDependencies;
      const bucket = createBucket(component);
      for (const [neighborId, edges] of relationships.incoming) {
        addEvidenceNode(bucket, nodes.get(neighborId));
        for (const edge of edges.values()) addEvidenceEdge(bucket, edge);
      }
      for (const [neighborId, edges] of relationships.outgoing) {
        addEvidenceNode(bucket, nodes.get(neighborId));
        for (const edge of edges.values()) addEvidenceEdge(bucket, edge);
      }
      appendFinding(makeFinding({
        id: `dependency-concentration:${component.id}`,
        category: "dependency-concentration",
        categoryLabel: categoryLabels["dependency-concentration"],
        component,
        priority: severe ? "high" : "medium",
        severity: severe ? "high" : "moderate",
        priorityExplanation: severe
          ? "At least 15 distinct graph nodes are connected in one direction; inspect change impact and dependency boundaries."
          : "At least 8 distinct graph nodes are connected in one direction; inspect coupling and change impact.",
        explanation: `Observed graph edges connect ${incomingCount} distinct incoming and ${outgoingCount} distinct outgoing graph nodes. This reflects extracted relationships only, not runtime coupling.`,
        basis: "observed-structure",
        metrics: [
          {
            label: "Distinct incoming graph nodes",
            value: incomingCount,
            threshold: `≥ ${ARCHITECTURE_HEALTH_THRESHOLDS.concentratedDependencies} in either direction`,
            basis: "observed-structure",
          },
          {
            label: "Distinct outgoing graph nodes",
            value: outgoingCount,
            threshold: `≥ ${ARCHITECTURE_HEALTH_THRESHOLDS.concentratedDependencies} in either direction`,
            basis: "observed-structure",
          },
        ],
        evidence: bucket,
        limitations: [
          ...limitations,
          "Counts include observed direct edges to distinct graph nodes; unresolved or unextracted relationships are not represented.",
        ],
        nextSteps: [
          "Inspect the cited incoming routes/callers and outgoing dependencies.",
          "Check whether the relationship concentration reflects one cohesive workflow or unrelated change paths.",
          "Consider a service boundary only after verifying ownership and regression-test coverage.",
        ],
      }));
    }
  }

  findings.sort((left, right) =>
    priorityRank[left.priority] - priorityRank[right.priority] ||
    (left.sourcePath ?? "").localeCompare(right.sourcePath ?? "") ||
    left.category.localeCompare(right.category) ||
    left.component.id.localeCompare(right.component.id),
  );
  const maximumFindings = ARCHITECTURE_HEALTH_THRESHOLDS.maximumFindings;
  const partialLimitations = [...graph.limitations];
  if (graph.sourceCoverage?.partial) {
    partialLimitations.push(
      `Repository source coverage is partial (${graph.sourceCoverage.analyzedFiles} of ${graph.sourceCoverage.selectedFiles} selected files analyzed).`,
    );
  }

  return {
    findings: findings.slice(0, maximumFindings),
    totalFindings: findings.length,
    componentsRequiringAttention: affectedComponents.size,
    categoryCounts,
    priorityCounts,
    truncatedFindings: findings.length > maximumFindings,
    analysisSkipped: false,
    limitMessage: findings.length > maximumFindings
      ? `Showing the highest-priority ${maximumFindings} of ${findings.length} findings.`
      : null,
    limitations: [...new Set(partialLimitations)],
  };
}
