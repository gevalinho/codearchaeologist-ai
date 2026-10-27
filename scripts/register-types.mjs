import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (!url.pathname.match(/\.[cm]?[jt]s$/) && existsSync(fileURLToPath(url) + ".ts")) return { url: `${url.href}.ts`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
