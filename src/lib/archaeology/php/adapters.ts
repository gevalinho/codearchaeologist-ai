import type { PhpParsedFile, PhpSymbol } from "./parser";

export type PhpFrameworkId =
  | "codeigniter-3"
  | "codeigniter-4"
  | "laravel"
  | "symfony"
  | "cakephp"
  | "yii-1"
  | "yii-2"
  | "wordpress"
  | "plain-php";

export type PhpAdapterStatus = "analyzed" | "partial" | "unsupported" | "not-detected";
export type PhpDetectionConfidence = "confirmed" | "probable" | "unknown";
export type PhpRouteResolution = "resolved" | "unresolved" | "ambiguous" | "dynamic";
export type PhpRouteEvidence = {
  adapter: Extract<PhpFrameworkId, "codeigniter-3" | "codeigniter-4" | "laravel">;
  path?: string;
  methods: string[];
  target?: string;
  middleware: string[];
  source: PhpParsedFile["symbols"][number]["source"];
  certainty: "observed" | "inferred";
  resolution: PhpRouteResolution;
  resolvedMethod?: string;
  parameterBindings?: { routeParameter: number; argument: number }[];
};
export type PhpAdapterSummary = {
  adapter: Extract<PhpFrameworkId, "codeigniter-3" | "codeigniter-4" | "laravel">;
  detection: PhpDetectionConfidence;
  status: PhpAdapterStatus;
  staticRoutes: number;
  dynamicRoutes: number;
  ambiguousRoutes: number;
  unresolvedRoutes: number;
};
export type PhpAdapterContext = {
  files: readonly PhpParsedFile[];
  symbols: readonly PhpSymbol[];
};
export type PhpAdapterResult = PhpAdapterSummary & {
  detectedVersion?: string;
  routes: PhpRouteEvidence[];
  issues: { code: string; source?: PhpParsedFile["symbols"][number]["source"] }[];
};

export interface PhpFrameworkAdapter {
  readonly id: PhpFrameworkId;
  detect(context: PhpAdapterContext): { detection: PhpDetectionConfidence; version?: string };
  analyze(context: PhpAdapterContext): PhpAdapterResult;
}
