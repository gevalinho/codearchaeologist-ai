import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanRepository } from "../src/lib/archaeology/scanner";

const created: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "archaeology-")); created.push(root); await mkdir(path.join(root, "application/controllers"), { recursive: true }); await mkdir(path.join(root, "application/models"), { recursive: true }); await mkdir(path.join(root, "assets/js"), { recursive: true }); return root; }
afterEach(async () => { await Promise.all(created.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("offline repository scan", () => {
  it("extracts architecture and stable source references", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "application/controllers/School.php"), "<?php\nclass School {\n public function putScore() {\n if ($score > 60) { return; }\n $this->put_model->insertSingleData($data, 'result');\n }\n}\n");
    await writeFile(path.join(root, "application/models/Put_model.php"), "<?php\nclass Put_model {\n public function insertSingleData($data, $table) {\n return $this->db->insert($table, $data);\n }\n}\n");
    await writeFile(path.join(root, "assets/js/angular.main.js"), "angular.module('app', []);\napp.controller('patientCtr', ['api', function(api) {\n $http.get('/api/patient');\n}]);\n");
    const graph = await scanRepository(root);
    expect(graph).toEqual(await scanRepository(root));
    expect(graph.nodes.find(n => n.id === "method:application/controllers/School.php#putScore")?.source).toEqual({ path: "application/controllers/School.php", startLine: 3, endLine: 6 });
    expect(graph.edges.some(e => e.kind === "calls-model-method" && e.source.startLine === 5)).toBe(true);
    expect(graph.nodes.some(n => n.id === "table:result")).toBe(true);
    expect(graph.nodes.find(n => n.name.endsWith("patientCtr"))?.domain).toBe("healthcare-legacy");
    expect(graph.nodes.find(n => n.name.endsWith("putScore"))?.domain).toBe("school-management");
    expect(graph.nodes.some(n => n.id === "endpoint:/api/patient")).toBe(true);
    expect(JSON.stringify(graph)).not.toContain(root);
  });
  it("rejects traversal and symlink roots, excludes sensitive files and links", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "application/controllers/.env"), "secret");
    await writeFile(path.join(root, "application/controllers/database.php"), "secret");
    await writeFile(path.join(root, "application/controllers/Good.php"), "<?php class Good {}");
    await symlink(path.join(root, "application/controllers/Good.php"), path.join(root, "application/controllers/Link.php"));
    const link = `${root}-link`; created.push(link); await symlink(root, link);
    expect((await scanRepository(root)).scan.fileCount).toBe(1);
    await expect(scanRepository(`${root}/../other`)).rejects.toThrow("traversal");
    await expect(scanRepository(link)).rejects.toThrow("symlink");
  });
  it("enforces limits and skips malformed source", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "application/controllers/A.php"), "12345");
    await writeFile(path.join(root, "application/controllers/B.php"), Buffer.from([0xff]));
    expect((await scanRepository(root)).warnings).toContain("Skipped invalid UTF-8 source: application/controllers/B.php");
    await expect(scanRepository(root, { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 20 })).rejects.toThrow("File count");
    await expect(scanRepository(root, { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 20 })).rejects.toThrow("File size");
    await expect(scanRepository(root, { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 5 })).rejects.toThrow("Total byte");
  });
});
