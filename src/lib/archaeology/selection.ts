import type { ScanLimits } from "./scanner";

export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxFiles: 300, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 };
export const excludedDirectories = new Set([".git", "node_modules", "vendor", "bower_components", "system", "user_guide", "third_party", "config", "cache", "caches", "logs", "uploads", "dist", "build", "coverage", "generated", "fonts", "img", "images", "css"]);
export const sensitive = /(^\.|(?:^|[._-])(?:config|database|credentials?|secrets?|passwords?|keys?|token|backup|dump)(?:[._-]|$)|\.(?:sql|pem|key|p12|pfx|bak|log)$)/i;
export const applicationScripts = new Set(["angular.main.js", "main.js", "module.js", "factories.js", "services.js", "routes.js", "directives.js", "runnables.js", "navrouter.js", "adminDir.js", "genexa.js"]);
const knownPhpRouteFiles = new Set(["application/config/routes.php", "app/Config/Routes.php", "routes/web.php", "routes/api.php"]);
const recognizedThirdPartyBundles = new Set(["assets/js/echarts.js"]);

export function sourceExclusionReason(relative: string): "recognized-third-party-bundle" | undefined {
  return recognizedThirdPartyBundles.has(relative) ? "recognized-third-party-bundle" : undefined;
}

export function allowedSource(relative: string): boolean {
  if (sourceExclusionReason(relative)) return false;
  const parts = relative.split("/");
  if (!parts.every(part => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"))) return false;
  const knownPhpRouteFile = knownPhpRouteFiles.has(relative);
  if (parts.some(part => part.startsWith(".") || excludedDirectories.has(part.toLowerCase())) && !knownPhpRouteFile) return false;
  const name = parts.at(-1)!;
  const safePasswordController = name === "Password.php" && /^(?:application\/controllers?|app\/Http\/Controllers)\/Password\.php$/.test(relative);
  if ((sensitive.test(name) && !safePasswordController) || /(?:\.min|\.bundle)\.(?:js|jsx|ts|tsx|php)$/i.test(name) || !/\.(?:php|js|jsx|ts|tsx)$/i.test(name)) return false;
  if (knownPhpRouteFile) return true;
  if (name.toLowerCase().endsWith(".php")) return parts.length === 1 || relative.startsWith("application/") || relative.startsWith("app/") || relative.startsWith("src/") || relative.startsWith("wp-content/plugins/");
  if (/\.(?:js|jsx|tsx?)$/i.test(name)) {
    return ["src/", "app/", "pages/", "components/", "routes/", "client/", "frontend/", "web/", "assets/js/"].some(prefix => relative.startsWith(prefix))
      || parts.length === 1 && ["app.js", "index.js", "main.js"].includes(name.toLowerCase());
  }
  return false;
}
