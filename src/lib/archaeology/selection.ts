import type { ScanLimits } from "./scanner";

export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxFiles: 300, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 };
export const excludedDirectories = new Set([".git", "node_modules", "vendor", "bower_components", "system", "user_guide", "third_party", "config", "cache", "caches", "logs", "uploads", "dist", "build", "coverage", "generated", "fonts", "img", "images", "css"]);
export const sensitive = /(^\.|(?:^|[._-])(?:config|database|credentials?|secrets?|passwords?|keys?|token|backup|dump)(?:[._-]|$)|\.(?:sql|pem|key|p12|pfx|bak|log)$)/i;
export const applicationScripts = new Set(["angular.main.js", "main.js", "module.js", "factories.js", "services.js", "routes.js", "directives.js", "runnables.js", "navrouter.js", "adminDir.js", "genexa.js"]);
export function allowedSource(relative: string): boolean {
  const parts = relative.split("/");
  if (!parts.every(part => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"))) return false;
  if (parts.some(part => part.startsWith(".") || excludedDirectories.has(part.toLowerCase()))) return false;
  const name = parts.at(-1)!;
  const safePasswordController = name === "Password.php" && /^(?:application\/controllers?|app\/Http\/Controllers)\/Password\.php$/.test(relative);
  if ((sensitive.test(name) && !safePasswordController) || /(?:\.min|\.bundle)\.(?:js|php)$/i.test(name) || !/\.(?:php|js)$/i.test(name)) return false;
  if (name.toLowerCase().endsWith(".php")) return parts.length === 1 || relative.startsWith("application/") || relative.startsWith("app/") || relative.startsWith("src/") || relative.startsWith("wp-content/plugins/");
  return relative.startsWith("assets/js/") && applicationScripts.has(name);
}
