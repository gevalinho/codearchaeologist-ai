"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { Edge, Graph, Node } from "../../lib/archaeology/scanner";
import {
  filterNodes,
  indexGraph,
  layout,
  MAX_ARTIFACT_BYTES,
  neighborhood,
  parseGraph,
  promotionInvestigation,
  sourceReference,
} from "../../lib/architecture/graph";
import {
  canStartCanvasDrag,
  fitNodes,
  panFromDrag,
  RESET_VIEW,
  zoomAt,
  type Point,
  type Viewport,
} from "../../lib/architecture/viewport";
import {
  discoverFeatures,
  type FeatureInvestigation,
} from "../../lib/architecture/features";
import { buildModernizationBlueprint } from "../../lib/architecture/blueprint";
import { createModernizationPreview } from "../../lib/architecture/preview";
import { planReconstruction } from "../../lib/architecture/reconstruction-planner";
import {
  createEvidencePacket,
  type EvidenceOrigin,
} from "../../lib/architecture/ai-evidence";
import { createRepositoryEvidencePacket } from "../../lib/architecture/ai-repository-evidence";
import {
  initialPreviewDrawerState,
  previewDrawerOpen,
  reducePreviewDrawer,
} from "../../lib/architecture/preview-drawer";
import { graphNodeLabel } from "../../lib/architecture/labels";
import { discoverModules } from "../../lib/architecture/modules";
import ModuleExplorer from "./module-explorer";
import {
  prepareDirectorySelection,
  type BrowserIngestion,
  type BrowserScanProgress,
} from "../../lib/archaeology/browser-ingestion";
import { scanInWorker } from "../../lib/archaeology/worker-client";
import type {
  GitHubJobStatus,
  GitHubJobPhase,
} from "../../lib/github-ingestion/jobs";
import FeatureWorkspace from "./feature-workspace";
import RepositoryAiPanel from "./repository-ai-panel";
import RepositoryPreviewCard from "./repository-preview-card";
import { repositoryPreview } from "../../lib/architecture/repository-preview";
import WorkspaceAssistant from "./workspace-assistant";
import SourceCoverageBanner from "./source-coverage-banner";
import PreviewDrawer from "./preview-drawer";
import LocalScanPanel, {
  localScanBusy,
  type LocalScanPhase,
} from "./local-scan-panel";
import BusinessRulesExplorer from "./business-rules-explorer";
import GitHubScanProgress, {
  appendObservedPhase,
} from "./github-scan-progress";
import {
  WorkspaceNavigation,
  workspaceSections,
  type WorkspaceSection,
} from "./workspace-navigation";
import "./workspace.css";
import "./workspace-shell.css";
import "./repository-preview-card.css";
import "./workspace-assistant.css";
import "./github-scan-progress.css";

const domains = [
  "school-management",
  "healthcare-legacy",
  "shared-infrastructure",
  "unknown",
];
const kinds = [
  "file",
  "class",
  "method",
  "angular-module",
  "controller",
  "service",
  "factory",
  "table",
  "endpoint",
  "branch",
];
const colors: Record<string, string> = {
  "school-management": "#5dd8be",
  "healthcare-legacy": "#b396ff",
  "shared-infrastructure": "#e9b766",
  unknown: "#8e9ba9",
};
export function repositorySelection(
  repositories: { id: number; installationId: number }[],
  selected: string,
): string {
  return repositories.some(
    (repo) => `${repo.installationId}:${repo.id}` === selected,
  )
    ? selected
    : repositories.length
      ? `${repositories[0].installationId}:${repositories[0].id}`
      : "";
}
export const workspacePanelKey = (
  panel: "business-rules" | "modules",
  artifactVersion: number,
) => `${panel}:${artifactVersion}`;
export default function ArchitectureWorkspace() {
  const [graph, setGraph] = useState<Graph | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const [domain, setDomain] = useState(""),
    [kind, setKind] = useState(""),
    [certainty, setCertainty] = useState("");
  const [focus, setFocus] = useState<string[]>([]),
    [depth, setDepth] = useState(1),
    [direction, setDirection] = useState<"both" | "incoming" | "outgoing">(
      "both",
    );
  const [selected, setSelected] = useState<{
      type: "node" | "edge";
      id: string;
    } | null>(null),
    [featured, setFeatured] = useState(false);
  const [selectedFeatureId, setSelectedFeatureId] =
    useState("feature:promotion");
  const [featureQuery, setFeatureQuery] = useState("");
  const [artifactVersion, setArtifactVersion] = useState(0);
  const [section, setSection] = useState<WorkspaceSection>("repository");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [workflowView, setWorkflowView] = useState<"features" | "rules">(
    "features",
  );
  const [featureAiActivation, setFeatureAiActivation] = useState(0);
  const [architectureView, setArchitectureView] = useState<"map" | "modules">(
    "map",
  );
  const [showNewInvestigation, setShowNewInvestigation] = useState(false);
  const [scanPhase, setScanPhase] = useState<LocalScanPhase>("idle");
  const [scanSelection, setScanSelection] = useState<{
    repositoryName: string;
    filesReceived: number;
  } | null>(null);
  const [scanProgress, setScanProgress] = useState<BrowserScanProgress | null>(
    null,
  );
  const [scanResult, setScanResult] = useState<BrowserIngestion | null>(null);
  const [scanOrigin, setScanOrigin] = useState<EvidenceOrigin | null>(null);
  const [showGitHub, setShowGitHub] = useState(false),
    [githubUrl, setGithubUrl] = useState("");
  const [sourceJobId, setSourceJobId] = useState<string | null>(null);
  const [githubJob, setGithubJob] = useState<GitHubJobStatus | null>(null),
    [githubError, setGithubError] = useState("");
  const [githubSubmitting, setGithubSubmitting] = useState(false);
  const [githubAttempt, setGithubAttempt] = useState<{
    repository: string;
    startedAt: number;
  } | null>(null);
  const [githubObservedPhases, setGithubObservedPhases] = useState<
    GitHubJobPhase[]
  >([]);
  const [githubCompletionVisible, setGithubCompletionVisible] = useState(false);
  const [githubConnection, setGithubConnection] = useState<{
    login: string;
    installations: {
      id: number;
      account: string;
      accountType: "User" | "Organization";
    }[];
    repositories: {
      id: number;
      owner: string;
      name: string;
      private: boolean;
      installationId: number;
    }[];
  } | null>(null);
  const [selectedGithubRepository, setSelectedGithubRepository] = useState(""),
    [githubPrivateJob, setGithubPrivateJob] = useState(false),
    [connectionError, setConnectionError] = useState("");
  const [drawer, dispatchDrawer] = useReducer(
    reducePreviewDrawer,
    undefined,
    initialPreviewDrawerState,
  );
  const [viewport, setViewport] = useState<Viewport>(RESET_VIEW),
    [canvasSize, setCanvasSize] = useState({ width: 1000, height: 580 }),
    [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null),
    directoryRef = useRef<HTMLInputElement>(null),
    scanAbort = useRef<AbortController | null>(null),
    scanPending = useRef(false),
    githubAbort = useRef<AbortController | null>(null),
    canvasRef = useRef<HTMLDivElement>(null);
  const githubCompletionTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const fittedGraph = useRef<Graph | null>(null);
  const drag = useRef<{
    pointerId: number;
    origin: Point;
    start: Viewport;
  } | null>(null);
  useEffect(() => {
    const input = directoryRef.current;
    input?.setAttribute("webkitdirectory", "");
    const cancelled = () => {
      scanPending.current = false;
      setScanPhase("failed");
      setError("Folder selection cancelled.");
    };
    input?.addEventListener("cancel", cancelled);
    return () => {
      scanAbort.current?.abort();
      githubAbort.current?.abort();
      if (githubCompletionTimer.current)
        clearTimeout(githubCompletionTimer.current);
      input?.removeEventListener("cancel", cancelled);
    };
  }, []);
  useEffect(() => {
    void refreshGitHubConnection();
  }, []);
  async function refreshGitHubConnection() {
    try {
      const response = await fetch("/api/github-app/repositories", {
        cache: "no-store",
      });
      if (response.status === 401) {
        setGithubConnection(null);
        setSelectedGithubRepository("");
        return;
      }
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "GitHub connection failed.");
      setGithubConnection({
        login: body.login,
        installations: body.installations,
        repositories: body.repositories,
      });
      setSelectedGithubRepository((current) =>
        repositorySelection(body.repositories, current),
      );
      setConnectionError("");
    } catch (cause) {
      setConnectionError(
        cause instanceof Error ? cause.message : "GitHub connection failed.",
      );
    }
  }
  const index = useMemo(() => (graph ? indexGraph(graph) : null), [graph]);
  const matches = useMemo(
    () =>
      graph
        ? filterNodes(graph.nodes, {
            query,
            domains: new Set(domain ? [domain] : []),
            kinds: new Set(kind ? [kind] : []),
            certainties: new Set(certainty ? [certainty] : []),
          })
        : [],
    [graph, query, domain, kind, certainty],
  );
  const promotion = useMemo(
    () => (graph ? promotionInvestigation(graph) : null),
    [graph],
  );
  const features = useMemo(
    () => (graph ? discoverFeatures(graph) : []),
    [graph],
  );
  const moduleDiscovery = useMemo(
    () => (graph ? discoverModules(graph, features) : null),
    [graph, features],
  );
  const promotionFeature = features.find(
    (feature) => feature.id === "feature:promotion",
  );
  const selectedFeature =
    features.find((feature) => feature.id === selectedFeatureId) ?? features[0];
  const blueprint = useMemo(
    () =>
      selectedFeature && graph
        ? buildModernizationBlueprint(selectedFeature, graph.snapshotId)
        : null,
    [selectedFeature, graph],
  );
  const preview = useMemo(
    () =>
      selectedFeature && blueprint
        ? createModernizationPreview(selectedFeature, blueprint)
        : null,
    [selectedFeature, blueprint],
  );
  const reconstructionPlan = useMemo(
    () =>
      graph && selectedFeature
        ? planReconstruction(graph, selectedFeature)
        : null,
    [graph, selectedFeature],
  );
  const aiPacket = useMemo(() => {
    try {
      return graph && selectedFeature && reconstructionPlan && scanOrigin
        ? createEvidencePacket(
            graph,
            selectedFeature,
            reconstructionPlan,
            scanOrigin,
          )
        : null;
    } catch {
      return null;
    }
  }, [graph, selectedFeature, reconstructionPlan, scanOrigin]);
  const repositoryAiPacket = useMemo(() => {
    try {
      return graph && scanOrigin
        ? createRepositoryEvidencePacket(graph, features, scanOrigin)
        : null;
    } catch {
      return null;
    }
  }, [graph, features, scanOrigin]);
  const reconstruction =
    !preview && reconstructionPlan?.status === "available"
      ? reconstructionPlan.spec
      : null;
  const currentPreviewKey = preview
    ? `${preview.id}:${preview.sourceSnapshotId}`
    : reconstruction
      ? `${reconstruction.id}:${reconstruction.sourceSnapshotId}`
      : null;
  const view = useMemo(
    () =>
      graph
        ? neighborhood(
            graph,
            focus.length ? focus : matches.slice(0, 1).map((node) => node.id),
            depth,
            direction,
          )
        : null,
    [graph, focus, matches, depth, direction],
  );
  const positions = useMemo(() => layout(view?.nodes ?? []), [view]);
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setCanvasSize({
        width: element.clientWidth,
        height: element.clientHeight,
      }),
    );
    observer.observe(element);
    setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [graph, section, architectureView]);
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!graph || !element || fittedGraph.current === graph) return;
    fittedGraph.current = graph;
    setViewport(
      fitNodes(positions.values(), {
        width: element.clientWidth,
        height: element.clientHeight,
      }),
    );
  }, [graph, section, architectureView, positions]);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      setViewport((current) =>
        zoomAt(
          current,
          point,
          current.scale *
            Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)),
        ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [graph, section, architectureView]);
  const activeNode =
    selected?.type === "node" ? index?.nodes.get(selected.id) : undefined;
  const activeEdge =
    selected?.type === "edge"
      ? graph?.edges.find((edge) => edge.id === selected.id)
      : undefined;
  const incoming = activeNode ? (index?.incoming.get(activeNode.id) ?? []) : [],
    outgoing = activeNode ? (index?.outgoing.get(activeNode.id) ?? []) : [];
  function loadGraph(
    parsed: Graph,
    origin: EvidenceOrigin,
    jobId: string | null = null,
  ) {
    fittedGraph.current = null;
    dispatchDrawer({ type: "feature-change", previewKey: null });
    setArtifactVersion((value) => value + 1);
    setGraph(parsed);
    setScanOrigin(origin);
    setSourceJobId(jobId);
    setFocus([]);
    setSelected(null);
    setFeatured(false);
    setSelectedFeatureId("feature:promotion");
    setFeatureQuery("");
    setQuery("");
    setDomain("");
    setKind("");
    setCertainty("");
    setViewport({ ...RESET_VIEW });
    setShowNewInvestigation(false);
    setSection("overview");
  }
  async function importFile(file?: File) {
    if (!file) return;
    scanAbort.current?.abort();
    scanPending.current = false;
    setScanResult(null);
    setScanPhase("idle");
    setError("");
    try {
      if (file.size > MAX_ARTIFACT_BYTES)
        throw new Error("Artifact exceeds the 5 MB limit.");
      loadGraph(parseGraph(await file.text(), file.size), "imported-graph");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not import artifact.",
      );
    }
    if (fileRef.current) fileRef.current.value = "";
  }
  function openDirectoryPicker() {
    if (scanPending.current) return;
    setSection("repository");
    scanPending.current = true;
    setScanSelection(null);
    setScanProgress(null);
    setError("");
    setScanPhase("awaiting-picker");
    directoryRef.current?.click();
  }
  async function scanDirectory(files: FileList | null) {
    if (!files?.length) {
      scanPending.current = false;
      setScanPhase("failed");
      setError("Folder selection cancelled or no files were returned.");
      return;
    }
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    const filesReceived = files.length;
    const repositoryName =
      files[0].webkitRelativePath.split("/")[0] || "Selected directory";
    setScanSelection({ repositoryName, filesReceived });
    setScanProgress({
      filesReceived,
      eligibleFiles: 0,
      filesRead: 0,
      bytesRead: 0,
      processedFiles: 0,
      processedBytes: 0,
    });
    setError("");
    setScanResult(null);
    setScanPhase("selected");
    try {
      // Allow a paint between frames before enumerating the returned FileList.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (controller.signal.aborted) return;
      setScanPhase("validating-selection");
      const prepared = prepareDirectorySelection(Array.from(files));
      if (controller.signal.aborted) return;
      setScanSelection({
        repositoryName: prepared.repositoryName,
        filesReceived,
      });
      setScanProgress(prepared.progress);
      const result = await scanInWorker(
        prepared.eligible as File[],
        filesReceived,
        controller.signal,
        setScanPhase,
        setScanProgress,
      );
      if (controller.signal.aborted) return;
      setScanResult(result);
      loadGraph(result.graph, "browser-local");
      setScanPhase("ready");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSection("repository");
        setScanPhase("failed");
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not scan selected directory.",
        );
      }
    } finally {
      if (scanAbort.current === controller) {
        scanPending.current = false;
        scanAbort.current = null;
        if (directoryRef.current) directoryRef.current.value = "";
      }
    }
  }
  function cancelLocalScan() {
    scanAbort.current?.abort();
    scanPending.current = false;
    setScanPhase("failed");
    setError("Repository scan cancelled.");
  }
  const scanBusy = localScanBusy(scanPhase);
  const githubBusy =
    githubSubmitting ||
    (!!githubJob &&
      !["ready", "failed", "cancelled"].includes(githubJob.phase));
  function applyGitHubStatus(status: GitHubJobStatus) {
    setGithubJob((current) =>
      current?.id === status.id &&
      current.phase === status.phase &&
      current.error === status.error
        ? current
        : status,
    );
    setGithubObservedPhases((current) =>
      appendObservedPhase(current, status.phase),
    );
  }
  async function githubRequest(
    url: string,
    options: RequestInit = {},
    privateJob = false,
  ) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(privateJob
          ? { "x-codearchaeologist-ingestion": "github-app" }
          : {}),
        ...(options.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `GitHub analysis request failed (${response.status}).`,
      );
    }
    return response;
  }
  async function startGitHubAnalysis(privateRepository = false) {
    if (githubAbort.current) return;
    if (!privateRepository && !githubUrl.trim()) {
      setGithubError("Enter a public GitHub repository URL.");
      return;
    }
    const selectedRepository = githubConnection?.repositories.find(
      (repo) =>
        `${repo.installationId}:${repo.id}` === selectedGithubRepository,
    );
    if (privateRepository && !selectedRepository) {
      setGithubError("Select an authorized GitHub repository.");
      return;
    }
    const controller = new AbortController();
    githubAbort.current = controller;
    setGithubPrivateJob(privateRepository);
    if (githubCompletionTimer.current)
      clearTimeout(githubCompletionTimer.current);
    setGithubCompletionVisible(false);
    setSection("repository");
    setGithubAttempt({
      repository: privateRepository
        ? `${selectedRepository!.owner}/${selectedRepository!.name}`
        : (githubUrl
            .trim()
            .match(
              /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/,
            )?.[1] ?? "GitHub repository"),
      startedAt: Date.now(),
    });
    setGithubObservedPhases([]);
    setGithubSubmitting(true);
    setGithubError("");
    setGithubJob(null);
    setScanResult(null);
    setScanPhase("idle");
    try {
      const created = await githubRequest(
        "/api/github-jobs",
        {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            privateRepository
              ? {
                  installationId: selectedRepository!.installationId,
                  repositoryId: selectedRepository!.id,
                }
              : { url: githubUrl.trim() },
          ),
        },
        privateRepository,
      );
      let status = (await created.json()) as GitHubJobStatus;
      applyGitHubStatus(status);
      while (!["ready", "failed", "cancelled"].includes(status.phase)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        if (controller.signal.aborted) return;
        const polled = await githubRequest(
          `/api/github-jobs/${encodeURIComponent(status.id)}`,
          { signal: controller.signal },
          privateRepository,
        );
        status = (await polled.json()) as GitHubJobStatus;
        applyGitHubStatus(status);
      }
      if (status.phase === "failed")
        throw new Error(status.error ?? "GitHub analysis failed.");
      if (status.phase === "cancelled")
        throw new Error("GitHub analysis was cancelled.");
      const [graphResponse, manifestResponse] = await Promise.all([
        githubRequest(
          `/api/github-jobs/${encodeURIComponent(status.id)}/artifacts/graph.json`,
          { signal: controller.signal },
          privateRepository,
        ),
        githubRequest(
          `/api/github-jobs/${encodeURIComponent(status.id)}/artifacts/manifest.json`,
          { signal: controller.signal },
          privateRepository,
        ),
      ]);
      const [graphJson, manifestJson] = await Promise.all([
        graphResponse.text(),
        manifestResponse.text(),
      ]);
      const parsed = parseGraph(graphJson);
      const manifest = JSON.parse(manifestJson) as BrowserIngestion["manifest"];
      if (manifest.snapshotId !== parsed.snapshotId)
        throw new Error("GitHub graph and manifest snapshot IDs differ.");
      if (controller.signal.aborted) return;
      setScanResult({ graph: parsed, manifest, graphJson, manifestJson });
      loadGraph(
        parsed,
        privateRepository && selectedRepository?.private
          ? "private-github"
          : "public-github",
        status.id,
      );
      applyGitHubStatus(status);
      setGithubCompletionVisible(true);
      githubCompletionTimer.current = setTimeout(
        () => setGithubCompletionVisible(false),
        2_200,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSection("repository");
        setGithubError(
          cause instanceof Error ? cause.message : "GitHub analysis failed.",
        );
      }
    } finally {
      if (githubAbort.current === controller) githubAbort.current = null;
      setGithubSubmitting(false);
    }
  }
  async function cancelGitHubAnalysis() {
    const status = githubJob;
    if (!status) return;
    githubAbort.current?.abort();
    setGithubError("");
    try {
      const response = await githubRequest(
        `/api/github-jobs/${encodeURIComponent(status.id)}`,
        { method: "DELETE" },
        githubPrivateJob,
      );
      applyGitHubStatus((await response.json()) as GitHubJobStatus);
    } catch (cause) {
      setGithubError(
        cause instanceof Error
          ? cause.message
          : "Could not cancel GitHub analysis.",
      );
    }
  }
  function downloadArtifact(name: "graph.json" | "manifest.json") {
    if (!scanResult) return;
    const blob = new Blob(
      [name === "graph.json" ? scanResult.graphJson : scanResult.manifestJson],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function selectNode(node: Node) {
    setSelected({ type: "node", id: node.id });
    setFocus([node.id]);
    setFeatured(false);
  }
  function focusFeatureNode(node: Node) {
    selectNode(node);
    setSection("evidence");
  }
  function focusFeatureEdge(edge: Edge) {
    setSelected({ type: "edge", id: edge.id });
    setFocus([edge.from, edge.to]);
    setSection("evidence");
  }
  function focusEvidenceRef(ref: {
    path: string;
    startLine: number;
    endLine: number;
  }) {
    const same = (item: { path: string; startLine: number; endLine: number }) =>
      item.path === ref.path &&
      item.startLine === ref.startLine &&
      item.endLine === ref.endLine;
    const owner = graph?.rules?.find((rule) => same(rule.source));
    const node = owner
      ? graph?.nodes.find((item) => item.id === owner.ownerNodeId)
      : graph?.nodes.find((item) => same(item.source));
    const edge = graph?.edges.find((item) => same(item.source));
    if (node) selectNode(node);
    else if (edge) setSelected({ type: "edge", id: edge.id });
    setSection("evidence");
  }
  function selectFeature(feature: FeatureInvestigation) {
    dispatchDrawer({
      type: "feature-change",
      previewKey: feature.id === selectedFeature?.id ? currentPreviewKey : null,
    });
    setSelectedFeatureId(feature.id);
    setFeatured(feature.id === "feature:promotion");
    setFocus(
      feature.components
        .filter((component) => component.association === "anchor")
        .slice(0, 12)
        .map((component) => component.node.id),
    );
    setSelected(null);
    setDepth(1);
    setDirection("both");
  }
  function investigate() {
    if (promotionFeature) {
      selectFeature(promotionFeature);
      setWorkflowView("features");
      setSection("workflows");
    }
  }
  function focusModule(ids: string[]) {
    setFocus(ids.slice(0, 36));
    setDepth(0);
    setSelected(null);
    setFeatured(false);
    setArchitectureView("map");
    setSection("architecture");
  }
  function openPreview() {
    if (currentPreviewKey)
      dispatchDrawer({ type: "open", previewKey: currentPreviewKey });
  }
  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      !canStartCanvasDrag(event.target instanceof Element ? event.target : null)
    )
      return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      start: viewport,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    setViewport(
      panFromDrag(drag.current.start, drag.current.origin, {
        x: event.clientX,
        y: event.clientY,
      }),
    );
  }
  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function zoomButton(factor: number) {
    setViewport((current) =>
      zoomAt(
        current,
        { x: canvasSize.width / 2, y: canvasSize.height / 2 },
        current.scale * factor,
      ),
    );
  }
  const selectedConnected = new Set(
    activeNode ? [...incoming, ...outgoing].map((edge) => edge.id) : [],
  );
  return (
    <main className="architecture">
      <header className="arch-top">
        <div>
          <Link href="/examples/legacy-pricing" className="arch-back">
            LEGACY PRICING EXAMPLE ↗
          </Link>
          <span className="arch-divider" />
          <strong>
            <span className="arch-logo">⌘</span> CODEARCHAEOLOGIST{" "}
            <em>/ REPOSITORY INTELLIGENCE</em>
          </strong>
        </div>
        <div className="arch-top-right">
          <span className="arch-live">LOCAL ARTIFACT</span>
          <button
            onClick={() => {
              setSection("repository");
              setShowNewInvestigation(true);
            }}
            className="arch-import"
          >
            ＋ &nbsp; New Investigation
          </button>
          <input
            ref={directoryRef}
            type="file"
            multiple
            hidden
            disabled={scanBusy}
            aria-label="Select local repository directory"
            onChange={(event) => scanDirectory(event.target.files)}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => importFile(event.target.files?.[0])}
          />
        </div>
      </header>
      <div
        className={`workspace-shell${assistantOpen ? " assistant-open" : ""}`}
      >
        <WorkspaceNavigation
          active={section}
          onSelect={setSection}
          busy={scanBusy || githubBusy}
          assistantOpen={assistantOpen}
          onToggleAssistant={() => setAssistantOpen((value) => !value)}
        />
        <div className="workspace-main" id="workspace-main">
          <div className="workspace-title" aria-live="polite">
            <div>
              <small>REPOSITORY INTELLIGENCE / {section.toUpperCase()}</small>
              <h1>
                {workspaceSections.find((item) => item.id === section)!.label}
              </h1>
            </div>
            <span>
              {scanBusy
                ? `Scanning ${scanSelection?.repositoryName ?? "repository"}: ${scanPhase.replaceAll("-", " ")}`
                : githubBusy
                  ? `GitHub analysis: ${githubJob?.phase.replaceAll("-", " ") ?? "starting"}`
                  : graph
                    ? `Snapshot ${graph.snapshotId.slice(0, 12)}…`
                    : "No graph loaded"}
            </span>
          </div>
          {graph?.sourceCoverage && (
            <SourceCoverageBanner coverage={graph.sourceCoverage} />
          )}
          {section === "repository" && (
            <>
              {!graph ? (
                <div className="arch-heading">
                  <div>
                    <div className="arch-overline">
                      REPOSITORY INTELLIGENCE <span>/</span> LOCAL WORKSPACE
                    </div>
                    <h1>Start an investigation</h1>
                    <p>
                      Scan supported source files or import an existing graph
                      artifact.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="workspace-repository-loaded">
                  <div>
                    <strong>
                      {scanResult?.manifest.repositoryDisplayName ??
                        "Imported graph artifact"}
                    </strong>
                    <span>
                      {graph.scan.fileCount} analyzed files ·{" "}
                      {graph.nodes.length} components · {graph.edges.length}{" "}
                      relationships
                    </span>
                  </div>
                  <button
                    onClick={() => setShowNewInvestigation((value) => !value)}
                  >
                    {showNewInvestigation
                      ? "Hide loading options"
                      : "Change repository or import graph"}
                  </button>
                </div>
              )}
              {(showNewInvestigation || !graph) && (
                <section
                  className="arch-new-investigation"
                  aria-label="New investigation"
                >
                  <div>
                    <small>NEW INVESTIGATION</small>
                    <h2>Choose a repository or graph artifact</h2>
                    <p>
                      Local directory selection reads supported files in a
                      browser worker. Chrome may take time to enumerate large
                      WSL folders before this page receives the file list;
                      picker progress is unavailable. Public GitHub analysis
                      requires an enabled isolated server scanner.
                    </p>
                  </div>
                  <div className="arch-new-actions">
                    <button onClick={openDirectoryPicker} disabled={scanBusy}>
                      Scan local repository directory ↗
                    </button>
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={scanBusy}
                    >
                      Import existing graph JSON ↗
                    </button>
                    <button onClick={() => setShowGitHub((value) => !value)}>
                      Analyze GitHub Repository ↗
                    </button>
                  </div>
                </section>
              )}
              {(showNewInvestigation || !graph || githubConnection) && (
                <section
                  className="arch-github"
                  aria-label="GitHub App connection"
                >
                  <div>
                    <small>GITHUB APP CONNECTION</small>
                    <h2>Connected repositories</h2>
                    <p>
                      {githubConnection
                        ? `Signed in as ${githubConnection.login}. Choose an already-authorized repository below to analyze. Manage GitHub App access separately.`
                        : "Connect GitHub to see repositories this app can access. Repository contents are read only during an isolated scan."}
                    </p>
                  </div>
                  {!githubConnection ? (
                    <div className="arch-new-actions">
                      <a
                        className="arch-github-link"
                        href="/api/github-app/login"
                      >
                        Connect GitHub ↗
                      </a>
                      {connectionError && <p role="alert">{connectionError}</p>}
                    </div>
                  ) : (
                    <div className="arch-github-connection">
                      <div className="arch-new-actions">
                        <a
                          className="arch-github-link"
                          href="/api/github-app/install"
                        >
                          ＋ Add GitHub Repository ↗
                        </a>

                        {githubConnection.installations.map((installation) => (
                          <a
                            key={installation.id}
                            className="arch-github-link"
                            href={`/api/github-app/install?installationId=${installation.id}`}
                          >
                            Manage {installation.account} repositories ↗
                          </a>
                        ))}
                        <button onClick={() => void refreshGitHubConnection()}>
                          Refresh authorized list
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              const response = await fetch(
                                "/api/github-app/logout",
                                {
                                  method: "POST",
                                  headers: { Origin: location.origin },
                                },
                              );

                              if (!response.ok) {
                                throw new Error(
                                  `Disconnect failed (${response.status}).`,
                                );
                              }

                              setGithubConnection(null);
                              setSelectedGithubRepository("");
                              setScanResult(null);
                              setGraph(null);
                              setScanOrigin(null);
                              setSourceJobId(null);
                              setConnectionError("");
                            } catch (error) {
                              setConnectionError(
                                error instanceof Error
                                  ? error.message
                                  : "Unable to disconnect GitHub.",
                              );
                            }
                          }}
                        >
                          Disconnect
                        </button>
                      </div>
                      <label>
                        Repository to analyze
                        <select
                          value={selectedGithubRepository}
                          onChange={(event) =>
                            setSelectedGithubRepository(event.target.value)
                          }
                          disabled={githubBusy}
                        >
                          <option value="">Select a repository</option>
                          {githubConnection.repositories.map((repo) => (
                            <option
                              key={`${repo.installationId}:${repo.id}`}
                              value={`${repo.installationId}:${repo.id}`}
                            >
                              {repo.owner}/{repo.name} ·{" "}
                              {repo.private ? "Private" : "Public"} ·
                              Installation {repo.installationId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        disabled={!selectedGithubRepository || githubBusy}
                        onClick={() => void startGitHubAnalysis(true)}
                      >
                        Analyze selected repository ↗
                      </button>
                      {githubConnection.repositories.length === 0 && (
                        <p>
                          No authorized repositories are available. Install the
                          app for selected repositories, then refresh.
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}
              {showGitHub && (
                <section
                  className="arch-github"
                  aria-label="Analyze public GitHub repository"
                >
                  <div>
                    <small>CONTROLLED PUBLIC REPOSITORY SCAN</small>
                    <h2>Analyze GitHub Repository</h2>
                    <p>
                      Sign in with GitHub to analyze a public repository. This
                      does not grant the app access to private repositories; use
                      the authorized repository list above for those. Supported
                      source files are downloaded for an isolated scan, then
                      deleted.
                    </p>
                  </div>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void startGitHubAnalysis();
                    }}
                  >
                    <label>
                      Repository URL
                      <input
                        type="url"
                        value={githubUrl}
                        onChange={(event) => setGithubUrl(event.target.value)}
                        placeholder="https://github.com/owner/repository"
                        autoComplete="url"
                        required
                        disabled={githubBusy}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={githubBusy || !githubConnection}
                    >
                      Analyze repository ↗
                    </button>
                    {!githubConnection && (
                      <p>Connect GitHub before starting a public scan.</p>
                    )}
                  </form>
                </section>
              )}
              {githubAttempt &&
                (githubSubmitting ||
                  githubJob?.phase !== "ready" ||
                  !!githubError) && (
                  <GitHubScanProgress
                    repository={githubAttempt.repository}
                    startedAt={githubAttempt.startedAt}
                    submitting={githubSubmitting}
                    job={githubJob}
                    error={githubError}
                    observed={githubObservedPhases}
                    workspaceReady={false}
                    onCancel={() => void cancelGitHubAnalysis()}
                    onRetry={() => void startGitHubAnalysis(githubPrivateJob)}
                  />
                )}
              <LocalScanPanel
                phase={scanPhase}
                repositoryName={scanSelection?.repositoryName}
                progress={scanProgress}
                error={error}
                onCancel={cancelLocalScan}
              />
              {scanResult && (
                <div className="arch-scan-summary">
                  <strong>{scanResult.manifest.repositoryDisplayName}</strong>
                  <span>
                    {scanResult.manifest.sourceCounts.scannedFiles} analyzed
                    files · {scanResult.graph.nodes.length} components ·{" "}
                    {scanResult.graph.edges.length} relationships ·{" "}
                    {scanResult.graph.warnings.length} warnings
                  </span>
                  <button onClick={() => downloadArtifact("graph.json")}>
                    Download graph.json
                  </button>
                  <button onClick={() => downloadArtifact("manifest.json")}>
                    Download manifest.json
                  </button>
                </div>
              )}
              {error && scanPhase !== "failed" && (
                <div className="arch-error" role="alert">
                  {error}
                </div>
              )}
            </>
          )}
          {section === "overview" &&
            githubCompletionVisible &&
            githubAttempt && (
              <GitHubScanProgress
                repository={githubAttempt.repository}
                startedAt={githubAttempt.startedAt}
                submitting={false}
                job={githubJob}
                error=""
                observed={githubObservedPhases}
                workspaceReady
                featureCount={features.length}
                onCancel={() => undefined}
                onRetry={() => undefined}
                compact
              />
            )}
          {section === "overview" && graph && (
            <div className="workspace-overview workspace-overview-duo">
              <RepositoryAiPanel
                key={`${graph.snapshotId}:${artifactVersion}`}
                packet={repositoryAiPacket}
                artifactId={sourceJobId}
                onFocusEvidence={focusEvidenceRef}
                onSelectedFeature={() => {
                  setSection("workflows");
                  setWorkflowView("features");
                  setFeatureAiActivation((value) => value + 1);
                }}
              />
              <RepositoryPreviewCard
                key={artifactVersion}
                preview={repositoryPreview(
                  graph,
                  scanOrigin,
                  scanResult?.manifest.repositoryDisplayName,
                )}
              />
            </div>
          )}
          {section === "overview" && (
            <section
              className="workspace-overview"
              aria-label="Snapshot overview"
            >
              {graph ? (
                <>
                  <div className="workspace-overview-head">
                    <small>LOADED SNAPSHOT</small>
                    <h2>
                      {scanResult?.manifest.repositoryDisplayName ??
                        "Imported architecture graph"}
                    </h2>
                    <p>{graph.snapshotId}</p>
                  </div>
                  <div className="workspace-metrics">
                    <div>
                      <strong>{graph.scan.fileCount}</strong>
                      <span>Analyzed files</span>
                    </div>
                    <div>
                      <strong>{graph.nodes.length}</strong>
                      <span>Components</span>
                    </div>
                    <div>
                      <strong>{graph.edges.length}</strong>
                      <span>Relationships</span>
                    </div>
                    <div>
                      <strong>{graph.rules?.length ?? 0}</strong>
                      <span>Rule patterns</span>
                    </div>
                    <div>
                      <strong>{graph.warnings.length}</strong>
                      <span>Warnings</span>
                    </div>
                  </div>
                  <div className="workspace-shortcuts">
                    <button onClick={() => setSection("architecture")}>
                      Explore architecture{" "}
                      <span>Modules, graph, and inventory →</span>
                    </button>
                    <button onClick={() => setSection("workflows")}>
                      Investigate workflows{" "}
                      <span>Rules and feature candidates →</span>
                    </button>
                    <button onClick={() => setSection("evidence")}>
                      Inspect evidence{" "}
                      <span>Source references and relationships →</span>
                    </button>
                  </div>
                  {promotionFeature && (
                    <button
                      className="workspace-promotion"
                      onClick={investigate}
                    >
                      Investigate Student Promotion →
                    </button>
                  )}
                  {graph.warnings.length > 0 && (
                    <details className="workspace-disclosure">
                      <summary>
                        Scanner warnings ({graph.warnings.length})
                      </summary>
                      {graph.warnings.map((warning, index) => (
                        <p key={`${warning}:${index}`}>{warning}</p>
                      ))}
                    </details>
                  )}
                  <details className="workspace-disclosure">
                    <summary>Coverage and interpretation</summary>
                    <p>
                      Counts describe supported files in this snapshot. Observed
                      patterns are source-derived, not runtime verified.
                      Inferred relationships and candidate groupings need
                      review.
                    </p>
                    {graph.limitations.map((limit, index) => (
                      <p key={`${limit}:${index}`}>{limit}</p>
                    ))}
                  </details>
                </>
              ) : (
                <div className="workspace-empty">
                  <h2>No investigation loaded</h2>
                  <p>
                    Scan a local directory, analyze an authorized GitHub
                    repository, or import a graph artifact.
                  </p>
                  <button onClick={() => setSection("repository")}>
                    Open Repository →
                  </button>
                </div>
              )}
            </section>
          )}
          {section === "workflows" && (
            <>
              <div className="workspace-subnav" aria-label="Workflow views">
                <button
                  aria-current={
                    workflowView === "features" ? "page" : undefined
                  }
                  onClick={() => setWorkflowView("features")}
                >
                  Feature candidates
                </button>
                <button
                  aria-current={workflowView === "rules" ? "page" : undefined}
                  onClick={() => setWorkflowView("rules")}
                >
                  Business rules
                </button>
              </div>
              {graph && features.length === 0 && (
                <div className="arch-no-features" role="status">
                  No feature candidates were found in this snapshot. You can
                  still search components and inspect source references in the
                  architecture graph.
                </div>
              )}
              {graph && workflowView === "rules" && (
                <BusinessRulesExplorer
                  key={workspacePanelKey("business-rules", artifactVersion)}
                  graph={graph}
                  onSelectNode={focusFeatureNode}
                />
              )}
              {graph &&
                workflowView === "features" &&
                selectedFeature &&
                blueprint && (
                  <section
                    className="feature-intelligence"
                    aria-label="Feature intelligence"
                  >
                    <div className="feature-head">
                      <div>
                        <small>FEATURE INTELLIGENCE</small>
                        <h2>Feature workspace</h2>
                        <p>
                          Browse architecture candidates, trace evidence, and
                          review a clearly labeled modernization proposal.
                        </p>
                      </div>
                      <span>{features.length} CANDIDATES</span>
                    </div>
                    <div className="feature-layout">
                      <nav
                        className="feature-catalog"
                        aria-label="Discovered feature candidates"
                      >
                        <label className="feature-catalog-search">
                          Search candidates
                          <input
                            type="search"
                            value={featureQuery}
                            onChange={(event) =>
                              setFeatureQuery(event.target.value)
                            }
                            placeholder="Name or component…"
                          />
                        </label>
                        {features
                          .filter((feature) =>
                            `${feature.title} ${feature.components.map((item) => item.node.name).join(" ")}`
                              .toLowerCase()
                              .includes(featureQuery.toLowerCase()),
                          )
                          .map((feature) => (
                            <button
                              key={feature.id}
                              className={
                                selectedFeature.id === feature.id
                                  ? "active"
                                  : ""
                              }
                              onClick={() => selectFeature(feature)}
                            >
                              <strong>{feature.title}</strong>
                              <small>
                                {feature.components.length} candidates ·{" "}
                                {feature.relationships.length} edges
                              </small>
                            </button>
                          ))}
                      </nav>
                      <FeatureWorkspace
                        feature={selectedFeature}
                        blueprint={blueprint}
                        preview={preview}
                        reconstruction={reconstructionPlan!}
                        aiPacket={aiPacket}
                        artifactId={sourceJobId}
                        aiActivation={featureAiActivation}
                        onOpenPreview={openPreview}
                        onFocusNode={focusFeatureNode}
                        onFocusEdge={focusFeatureEdge}
                        onFocusEvidence={focusEvidenceRef}
                        onOpenGraph={() => setSection("architecture")}
                        onOpenRepositoryAi={() => setSection("overview")}
                      />
                    </div>
                  </section>
                )}
              {!graph && (
                <div className="workspace-empty">
                  <h2>No workflows available yet</h2>
                  <p>
                    Load a repository or graph artifact to discover rule
                    patterns and feature candidates.
                  </p>
                  <button onClick={() => setSection("repository")}>
                    Open Repository →
                  </button>
                </div>
              )}
            </>
          )}
          {section === "architecture" && (
            <>
              <div className="workspace-subnav" aria-label="Architecture views">
                <button
                  aria-current={architectureView === "map" ? "page" : undefined}
                  onClick={() => setArchitectureView("map")}
                >
                  Relationship map
                </button>
                <button
                  aria-current={
                    architectureView === "modules" ? "page" : undefined
                  }
                  onClick={() => setArchitectureView("modules")}
                >
                  Module explorer
                </button>
              </div>
              {graph && moduleDiscovery && architectureView === "modules" && (
                <ModuleExplorer
                  key={workspacePanelKey("modules", artifactVersion)}
                  graph={graph}
                  discovery={moduleDiscovery}
                  features={features}
                  onFocusModule={focusModule}
                  onSelectNode={focusFeatureNode}
                  onSelectFeature={(feature) => {
                    selectFeature(feature);
                    setWorkflowView("features");
                    setSection("workflows");
                  }}
                />
              )}
              {architectureView === "map" && (
                <>
                  <div className="arch-grid">
                    <aside className="arch-panel explorer">
                      <div className="arch-panel-head">
                        <small>01 / COMPONENT INVENTORY</small>
                        <h2>
                          Inventory <span>{graph?.nodes.length ?? 0}</span>
                        </h2>
                      </div>
                      {!graph ? (
                        <div className="arch-side-empty">
                          Import a local graph artifact to search its
                          architecture inventory.
                        </div>
                      ) : (
                        <>
                          <label className="arch-search">
                            ⌕{" "}
                            <input
                              value={query}
                              onChange={(event) => {
                                setQuery(event.target.value);
                                setFocus([]);
                                setFeatured(false);
                              }}
                              placeholder="Search symbols, paths, endpoints…"
                              aria-label="Search architecture"
                            />
                          </label>
                          <div className="arch-filters">
                            <select
                              aria-label="Domain filter"
                              value={domain}
                              onChange={(event) => {
                                setDomain(event.target.value);
                                setFocus([]);
                              }}
                            >
                              <option value="">All domains</option>
                              {domains.map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                            <select
                              aria-label="Node type filter"
                              value={kind}
                              onChange={(event) => {
                                setKind(event.target.value);
                                setFocus([]);
                              }}
                            >
                              <option value="">All node types</option>
                              {kinds.map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                            <select
                              aria-label="Certainty filter"
                              value={certainty}
                              onChange={(event) => {
                                setCertainty(event.target.value);
                                setFocus([]);
                              }}
                            >
                              <option value="">All evidence</option>
                              <option>observed</option>
                              <option>inferred</option>
                            </select>
                          </div>
                          {promotionFeature && (
                            <button
                              className="arch-feature"
                              onClick={investigate}
                            >
                              <span>FEATURED INVESTIGATION</span>
                              <strong>Investigate Student Promotion ↗</strong>
                              <small>
                                Trace discovered components and their source
                                references
                              </small>
                            </button>
                          )}
                          <div className="arch-list-title">
                            MATCHING COMPONENTS <span>{matches.length}</span>
                          </div>
                          <div className="arch-inventory">
                            {kinds.map((group) => {
                              const items = matches.filter(
                                (node) => node.kind === group,
                              );
                              return items.length ? (
                                <details
                                  key={group}
                                  open={
                                    !!query ||
                                    group === "controller" ||
                                    group === "method"
                                  }
                                >
                                  <summary>
                                    {group.toUpperCase()}{" "}
                                    <span>{items.length}</span>
                                  </summary>
                                  {items.slice(0, 80).map((node) => (
                                    <button
                                      key={node.id}
                                      className={
                                        selected?.id === node.id ? "active" : ""
                                      }
                                      onClick={() => selectNode(node)}
                                      title={node.name}
                                    >
                                      <span
                                        className="arch-node-dot"
                                        style={{
                                          background: colors[node.domain],
                                        }}
                                      />
                                      <span>{node.name.split("/").pop()}</span>
                                      <small>
                                        {node.certainty === "inferred"
                                          ? "◌"
                                          : "●"}
                                      </small>
                                    </button>
                                  ))}
                                  {items.length > 80 && (
                                    <p>Showing first 80. Narrow your search.</p>
                                  )}
                                </details>
                              ) : null;
                            })}
                          </div>
                        </>
                      )}
                    </aside>
                    <section className="arch-panel canvas-panel">
                      <div className="arch-canvas-head">
                        <div>
                          <small>02 / RELATIONSHIP MAP</small>
                          <h2>
                            {featured
                              ? "Student promotion investigation"
                              : graph
                                ? "Architecture viewport"
                                : "Awaiting artifact"}
                          </h2>
                        </div>
                        {graph && (
                          <span className="arch-subset">
                            {view?.nodes.length ?? 0} / {graph.nodes.length}{" "}
                            nodes in view
                          </span>
                        )}
                      </div>
                      {!graph ? (
                        <div className="arch-blank">
                          <div className="arch-blank-icon">⌁</div>
                          <span>LOCAL-FIRST WORKSPACE</span>
                          <h3>Your architecture starts here.</h3>
                          <p>
                            Select a local repository directory to scan, or
                            import an existing graph JSON. Analysis stays in
                            this browser tab.
                          </p>
                          <button
                            onClick={openDirectoryPicker}
                            disabled={scanBusy}
                          >
                            Scan local repository ↗
                          </button>
                          <button
                            onClick={() => fileRef.current?.click()}
                            disabled={scanBusy}
                          >
                            Import graph JSON ↗
                          </button>
                          <small>
                            No upload · No browser storage · No model calls
                          </small>
                        </div>
                      ) : (
                        <>
                          <div className="arch-toolbar">
                            <div>
                              <button
                                onClick={() => zoomButton(1.25)}
                                aria-label="Zoom in"
                              >
                                ＋
                              </button>
                              <button
                                onClick={() => zoomButton(0.8)}
                                aria-label="Zoom out"
                              >
                                −
                              </button>
                              <button
                                onClick={() =>
                                  setViewport(
                                    fitNodes(positions.values(), canvasSize),
                                  )
                                }
                                aria-label="Fit view"
                                title="Fit view"
                              >
                                ⌗
                              </button>
                              <button
                                onClick={() => setViewport({ ...RESET_VIEW })}
                              >
                                Reset view
                              </button>
                            </div>
                            <div>
                              <button
                                onClick={() =>
                                  setDepth((value) => Math.min(2, value + 1))
                                }
                              >
                                Expand neighbors
                              </button>
                              <select
                                aria-label="Dependency direction"
                                value={direction}
                                onChange={(event) =>
                                  setDirection(
                                    event.target.value as typeof direction,
                                  )
                                }
                              >
                                <option value="both">Both directions</option>
                                <option value="incoming">Incoming</option>
                                <option value="outgoing">Outgoing</option>
                              </select>
                            </div>
                          </div>
                          <div
                            ref={canvasRef}
                            className={`arch-graph ${dragging ? "dragging" : ""}`}
                            onPointerDown={beginDrag}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            onLostPointerCapture={endDrag}
                          >
                            <svg
                              role="img"
                              aria-label="Focused architecture graph"
                              viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
                              preserveAspectRatio="none"
                            >
                              <defs>
                                <marker
                                  id="arrow"
                                  markerWidth="8"
                                  markerHeight="8"
                                  refX="7"
                                  refY="4"
                                  orient="auto"
                                >
                                  <path d="M0,0 L8,4 L0,8" fill="#718394" />
                                </marker>
                              </defs>
                              <g
                                transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
                              >
                                {view?.edges.map((edge: Edge) => {
                                  const from = positions.get(edge.from)!,
                                    to = positions.get(edge.to)!;
                                  return (
                                    <g
                                      key={edge.id}
                                      data-graph-interactive
                                      onClick={() =>
                                        setSelected({
                                          type: "edge",
                                          id: edge.id,
                                        })
                                      }
                                      tabIndex={0}
                                      role="button"
                                      aria-label={`${edge.kind}: ${index?.nodes.get(edge.from)?.name} to ${index?.nodes.get(edge.to)?.name}`}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                          setSelected({
                                            type: "edge",
                                            id: edge.id,
                                          });
                                      }}
                                    >
                                      <line
                                        className="edge-hit"
                                        x1={from.x}
                                        y1={from.y}
                                        x2={to.x}
                                        y2={to.y}
                                      />
                                      <line
                                        className={`graph-edge ${edge.certainty} ${selectedConnected.has(edge.id) || selected?.id === edge.id ? "highlight" : ""}`}
                                        x1={from.x}
                                        y1={from.y}
                                        x2={to.x}
                                        y2={to.y}
                                        markerEnd="url(#arrow)"
                                      />
                                    </g>
                                  );
                                })}
                                {view?.nodes.map((node) => {
                                  const point = positions.get(node.id)!,
                                    label = graphNodeLabel(node);
                                  return (
                                    <g
                                      key={node.id}
                                      className={`graph-node ${selected?.id === node.id ? "selected" : ""}`}
                                      data-graph-interactive
                                      transform={`translate(${point.x - 83} ${point.y - 31})`}
                                      role="button"
                                      tabIndex={0}
                                      aria-label={`Inspect ${node.name}`}
                                      onClick={() => selectNode(node)}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                          selectNode(node);
                                      }}
                                    >
                                      <rect
                                        width="166"
                                        height="62"
                                        rx="10"
                                        fill="#162630"
                                        stroke={colors[node.domain]}
                                      />
                                      <rect
                                        width="4"
                                        height="42"
                                        x="0"
                                        y="10"
                                        rx="2"
                                        fill={colors[node.domain]}
                                      />
                                      <text
                                        x="14"
                                        y="24"
                                        className="graph-kind"
                                      >
                                        {node.kind.toUpperCase()} ·{" "}
                                        {node.certainty.toUpperCase()}
                                      </text>
                                      <title>{label.fullName}</title>
                                      <svg
                                        x="13"
                                        y="30"
                                        width="140"
                                        height="27"
                                        overflow="hidden"
                                        aria-hidden="true"
                                      >
                                        {label.lines.map((line, lineIndex) => (
                                          <text
                                            key={lineIndex}
                                            x="0"
                                            y={lineIndex === 0 ? 11 : 24}
                                            className="graph-label"
                                          >
                                            {line}
                                          </text>
                                        ))}
                                      </svg>
                                    </g>
                                  );
                                })}
                              </g>
                            </svg>
                          </div>
                          <div className="arch-canvas-foot">
                            <span>
                              ● observed extraction &nbsp; ◌ inferred
                              relationship
                            </span>
                            <span>
                              Showing a focused subset. Select a component to
                              explore.
                            </span>
                          </div>
                          {featured && (
                            <div className="arch-feature-note">
                              <strong>Investigation coverage</strong>
                              <p>
                                {promotion?.matches.length} matching components
                                found.{" "}
                                {promotion?.missing.length
                                  ? `Missing: ${promotion.missing.join(", ")}.`
                                  : "All named components found."}{" "}
                                Only edges present in the artifact are drawn.
                                Score entry is a separate component unless an
                                edge connects it.
                              </p>
                            </div>
                          )}
                        </>
                      )}
                    </section>
                    <aside className="arch-panel inspector">
                      <div className="arch-panel-head">
                        <small>03 / EVIDENCE INSPECTOR</small>
                        <h2>Source evidence</h2>
                      </div>
                      {!graph ? (
                        <div className="arch-side-empty">
                          Select an imported node or relationship to inspect its
                          source reference.
                        </div>
                      ) : activeNode || activeEdge ? (
                        <div className="arch-evidence">
                          <span className="arch-tag">
                            {activeNode ? "COMPONENT" : "RELATIONSHIP"}
                          </span>
                          <h3>{activeNode?.name ?? activeEdge?.kind}</h3>
                          <dl>
                            <dt>TYPE</dt>
                            <dd>{activeNode?.kind ?? activeEdge?.kind}</dd>
                            <dt>DOMAIN</dt>
                            <dd>
                              {activeNode?.domain ??
                                "From connected components"}
                            </dd>
                            <dt>CERTAINTY</dt>
                            <dd>
                              {activeNode?.certainty ?? activeEdge?.certainty}
                            </dd>
                            <dt>EXTRACTION METHOD</dt>
                            <dd>{activeNode?.method ?? activeEdge?.method}</dd>
                          </dl>
                          <div className="arch-source">
                            <small>SOURCE REFERENCE</small>
                            <code>
                              {sourceReference(
                                (activeNode ?? activeEdge)!.source,
                              )}
                            </code>
                            <button
                              onClick={() =>
                                navigator.clipboard.writeText(
                                  sourceReference(
                                    (activeNode ?? activeEdge)!.source,
                                  ),
                                )
                              }
                            >
                              Copy reference
                            </button>
                          </div>
                          {activeEdge && (
                            <div className="arch-relations">
                              <h4>Directed relationship</h4>
                              <button
                                onClick={() =>
                                  selectNode(index!.nodes.get(activeEdge.from)!)
                                }
                              >
                                {index?.nodes.get(activeEdge.from)?.name}
                              </button>
                              <span>↓ {activeEdge.kind}</span>
                              <button
                                onClick={() =>
                                  selectNode(index!.nodes.get(activeEdge.to)!)
                                }
                              >
                                {index?.nodes.get(activeEdge.to)?.name}
                              </button>
                            </div>
                          )}
                          {activeNode && (
                            <div className="arch-relations">
                              <h4>Incoming dependencies · {incoming.length}</h4>
                              {incoming.slice(0, 20).map((edge) => (
                                <button
                                  key={edge.id}
                                  onClick={() =>
                                    setSelected({ type: "edge", id: edge.id })
                                  }
                                >
                                  {index?.nodes.get(edge.from)?.name}{" "}
                                  <small>→ {edge.kind}</small>
                                </button>
                              ))}
                              <h4>Outgoing dependencies · {outgoing.length}</h4>
                              {outgoing.slice(0, 20).map((edge) => (
                                <button
                                  key={edge.id}
                                  onClick={() =>
                                    setSelected({ type: "edge", id: edge.id })
                                  }
                                >
                                  {index?.nodes.get(edge.to)?.name}{" "}
                                  <small>← {edge.kind}</small>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="arch-side-empty">
                          Select a graph component or edge. Source references
                          appear here; the artifact contains no source snippets.
                        </div>
                      )}
                      <div className="arch-trust">
                        <strong>How to read this graph</strong>
                        <p>
                          Observed means extracted from source patterns, not
                          runtime verified. Inferred needs review. Domains are
                          heuristic. Missing edges do not establish missing
                          dependencies or dead code.
                        </p>
                      </div>
                    </aside>
                  </div>
                </>
              )}
            </>
          )}
          {section === "evidence" && (
            <section
              className="workspace-evidence"
              aria-label="Evidence workspace"
            >
              {graph ? (
                <>
                  <div className="workspace-evidence-head">
                    <h2>Source evidence</h2>
                    <p>
                      Select a component or relationship in Architecture or
                      Workflows to inspect its recorded source reference.
                    </p>
                    <button onClick={() => setSection("architecture")}>
                      Browse component inventory →
                    </button>
                  </div>
                  {activeNode || activeEdge ? (
                    <div className="workspace-evidence-card">
                      <span className="arch-tag">
                        {activeNode ? "COMPONENT" : "RELATIONSHIP"} ·{" "}
                        {activeNode?.certainty ?? activeEdge?.certainty}
                      </span>
                      <h3>{activeNode?.name ?? activeEdge?.kind}</h3>
                      <p>
                        Extraction method:{" "}
                        {activeNode?.method ?? activeEdge?.method}
                      </p>
                      <div className="arch-source">
                        <small>SOURCE REFERENCE</small>
                        <code>
                          {sourceReference((activeNode ?? activeEdge)!.source)}
                        </code>
                        <button
                          onClick={() =>
                            void navigator.clipboard.writeText(
                              sourceReference(
                                (activeNode ?? activeEdge)!.source,
                              ),
                            )
                          }
                        >
                          Copy reference
                        </button>
                      </div>
                      {activeEdge && (
                        <div className="arch-relations">
                          <h4>Supporting relationship</h4>
                          <button
                            onClick={() =>
                              selectNode(index!.nodes.get(activeEdge.from)!)
                            }
                          >
                            {index?.nodes.get(activeEdge.from)?.name}
                          </button>
                          <span>↓ {activeEdge.kind}</span>
                          <button
                            onClick={() =>
                              selectNode(index!.nodes.get(activeEdge.to)!)
                            }
                          >
                            {index?.nodes.get(activeEdge.to)?.name}
                          </button>
                        </div>
                      )}
                      {activeNode && (
                        <>
                          <details className="workspace-disclosure">
                            <summary>
                              Incoming relationships ({incoming.length})
                            </summary>
                            {incoming.map((edge) => (
                              <button
                                key={edge.id}
                                onClick={() =>
                                  setSelected({ type: "edge", id: edge.id })
                                }
                              >
                                {index?.nodes.get(edge.from)?.name} →{" "}
                                {edge.kind} · {edge.certainty} ·{" "}
                                {sourceReference(edge.source)}
                              </button>
                            ))}
                          </details>
                          <details className="workspace-disclosure">
                            <summary>
                              Outgoing relationships ({outgoing.length})
                            </summary>
                            {outgoing.map((edge) => (
                              <button
                                key={edge.id}
                                onClick={() =>
                                  setSelected({ type: "edge", id: edge.id })
                                }
                              >
                                {index?.nodes.get(edge.to)?.name} ← {edge.kind}{" "}
                                · {edge.certainty} ·{" "}
                                {sourceReference(edge.source)}
                              </button>
                            ))}
                          </details>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="workspace-empty">
                      <h3>No component selected</h3>
                      <p>
                        Source references appear here after you select a graph
                        component, rule owner, or relationship.
                      </p>
                    </div>
                  )}
                  <details className="workspace-disclosure">
                    <summary>How to interpret this evidence</summary>
                    <p>
                      Observed means a source pattern was extracted; it does not
                      verify runtime behavior. Inferred relationships require
                      source review. Missing edges do not prove missing
                      dependencies.
                    </p>
                  </details>
                </>
              ) : (
                <div className="workspace-empty">
                  <h2>No evidence available yet</h2>
                  <button onClick={() => setSection("repository")}>
                    Open Repository →
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
        <WorkspaceAssistant
          key={artifactVersion}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          repositoryName={
            scanResult?.manifest.repositoryDisplayName ??
            (graph ? "Imported architecture graph" : "")
          }
          graph={graph}
          origin={scanOrigin}
          artifactId={sourceJobId}
          repositoryPacket={repositoryAiPacket}
          featurePacket={
            selectedFeatureId === selectedFeature?.id ? aiPacket : null
          }
          featureName={
            selectedFeatureId === selectedFeature?.id
              ? (selectedFeature?.title ?? null)
              : null
          }
          onFocusEvidence={focusEvidenceRef}
        />
      </div>
      <PreviewDrawer
        key={`${artifactVersion}:${preview?.id ?? reconstruction?.id ?? "none"}`}
        preview={preview}
        reconstruction={reconstruction}
        feature={selectedFeature}
        blueprint={blueprint}
        open={previewDrawerOpen(drawer, currentPreviewKey)}
        expanded={drawer.expanded}
        assistantOpen={assistantOpen}
        onOpen={openPreview}
        onClose={() => dispatchDrawer({ type: "close" })}
        onToggleExpanded={() => dispatchDrawer({ type: "toggle-expand" })}
      />
    </main>
  );
}
