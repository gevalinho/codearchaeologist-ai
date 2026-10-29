import { describe, expect, it } from "vitest";
import { prepareDirectorySelection, scanSelectedDirectory, type DirectoryFile } from "../src/lib/archaeology/browser-ingestion";
import { allowedSource } from "../src/lib/archaeology/selection";
import { classifyFeature } from "../src/lib/architecture/feature-classification";
import { investigateFeature } from "../src/lib/architecture/features";

const file = (relative: string, content: string): DirectoryFile => {
  const bytes = new TextEncoder().encode(content);
  return { webkitRelativePath: `example/${relative}`, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) };
};

// Minimal representative syntax adapted from official PHP/framework documentation, not dependency downloads.
const examples = {
  plain: [file("index.php", `<?php
class Invoice {
  public function total(int $price, int $tax): int {
    if ($price < 0) { return 0; }
    $total = $price + $tax;
    return $total;
  }
}
`), file("vendor/Library.php", "<?php class Library {}")],
  codeigniter: [file("application/controllers/Orders.php", `<?php
class Orders extends CI_Controller {
  public function save() {
    if (empty($id)) { return; }
    $this->get_model->find($id);
  }
}
`), file("application/models/Get_model.php", `<?php class Get_model { public function find($id) {} }`), file("system/Core.php", "<?php class Core {}")],
  laravel: [file("app/Http/Controllers/OrderController.php", `<?php
namespace App\\Http\\Controllers;
class OrderController extends Controller {
  public function update(Request $request, string $id): RedirectResponse {
    if (empty($id)) { return redirect('/orders'); }
    return redirect('/orders');
  }
}
`), file("routes/web.php", "<?php Route::put('/orders/{id}', [OrderController::class, 'update']);"), file("vendor/Framework.php", "<?php class Framework {}")],
  wordpress: [file("wp-content/plugins/sample-plugin/sample.php", `<?php
function sample_init() {
  if (!is_admin()) { return; }
}
add_action('init', 'sample_init');
`), file("wp-includes/core.php", "<?php function core() {}")],
  php7: [file("src/LegacyOrder.php", `<?php
namespace App\\Domain;
class LegacyOrder {
  private int $id;
  public function setId(int $id): void {
    if ($id <= 0) { return; }
    $this->id = $id;
  }
}
`)],
  php8: [file("src/Order.php", `<?php
namespace App\\Domain;
#[Attribute]
class Order {
  public function __construct(private readonly int $id) {}
  public function transition(?string $state): void {
    if ($state === null) { return; }
    $this->status = $state;
  }
}
enum OrderState: string { case Open = 'open'; }
`)],
};

describe("PHP compatibility smoke fixtures", () => {
  it.each(Object.entries(examples))("selects and scans %s without executing PHP", async (_name, files) => {
    const selected = prepareDirectorySelection(files);
    const result = await scanSelectedDirectory(files);
    expect(result.graph.scan.fileCount).toBe(selected.progress.eligibleFiles);
    expect(result.graph.warnings).toEqual([]);
    expect(result.graph.nodes.every(node => !node.name.includes("vendor/") && !node.name.includes("system/"))).toBe(true);
  });
  it("selects application PHP across common layouts while excluding sensitive and dependency paths", () => {
    for (const path of ["index.php", "application/controllers/Orders.php", "app/Http/Controllers/Orders.php", "src/Order.php", "wp-content/plugins/example/example.php"]) expect(allowedSource(path)).toBe(true);
    for (const path of ["vendor/Foo.php", "system/Core.php", "app/config/database.php", "wp-content/plugins/example/.env.php", "routes/web.php", "wp-includes/core.php"]) expect(allowedSource(path)).toBe(false);
  });
  it("records conservative PHP 7/8 declarations and rule patterns without claiming route or hook edges", async () => {
    const plain = (await scanSelectedDirectory(examples.plain)).graph;
    expect(plain.nodes.some(node => node.name.endsWith("#Invoice"))).toBe(true);
    expect(plain.nodes.some(node => node.name.endsWith("#total"))).toBe(true);
    expect(plain.rules?.map(rule => rule.kind)).toContain("calculation");
    const laravel = (await scanSelectedDirectory(examples.laravel)).graph;
    expect(laravel.nodes.some(node => node.name.endsWith("#update"))).toBe(true);
    expect(laravel.edges.some(edge => edge.kind === "calls-endpoint")).toBe(false);
    const wordpress = (await scanSelectedDirectory(examples.wordpress)).graph;
    expect(wordpress.edges.some(edge => edge.kind.includes("hook"))).toBe(false);
  });
  it("does not turn commented declarations or lexical SQL names into verified workflow evidence", async () => {
    const graph = (await scanSelectedDirectory([file("app/Http/Controllers/Orders.php", `<?php
/* class Invented { public function fake() {} } */
class Orders {
  public function update($id) {
    if (empty($id)) { return; }
    $sql = "UPDATE orders SET name = 'x'";
  }
}
`)])).graph;
    expect(graph.nodes.some(node => node.name.includes("Invented") || node.name.endsWith("#fake"))).toBe(false);
    expect(graph.edges.filter(edge => edge.kind === "references-table").every(edge => edge.certainty === "inferred")).toBe(true);
    expect(classifyFeature(graph, investigateFeature(graph, { term: "orders" })).category).not.toBe("business-workflow");
  });
});
