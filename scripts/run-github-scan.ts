import { scanRepository } from "../src/lib/archaeology/scanner";

const graph = await scanRepository("/repo");
process.stdout.write(JSON.stringify(graph));
