# PHP compatibility audit — 29 October 2026

This is a bounded fixture audit, not a claim that arbitrary PHP projects are understood. Fixtures in `tests/php-compatibility.test.ts` are minimal representative snippets modeled on official documentation; no framework dependencies were downloaded or executed. Counts below are from the browser scanner. Every fixture produced zero scanner warnings and zero *reported* parser failures because the scanner is a line-pattern extractor and has no PHP parser or syntax-error reporting.

| Fixture | Discovered / eligible / processed | Excluded paths and reason | Nodes / edges / rules | Source-supported relationships | Missing or misleading relationships |
| --- | ---: | --- | ---: | --- | --- |
| Plain PHP | 2 / 1 / 1 | `vendor/Library.php`: dependency directory | 3 / 2 / 2 | File declares class; class declares method | No function-call, property, or data-flow graph. Comparison and arithmetic are lexical patterns, not verified business rules. |
| CodeIgniter 3 style | 3 / 2 / 2 | `system/Core.php`: framework directory | 6 / 5 / 1 | Four declarations; one **inferred** `get_model->find` call points to a matching model method declaration | No route resolution. Matching target name does not verify the runtime call. |
| Laravel style | 3 / 1 / 1 | `routes/web.php`: outside supported application source roots; `vendor/Framework.php`: dependency directory | 3 / 2 / 1 | Controller class and method declarations | `Route::put` is omitted, so route-to-method connection is missing. `empty($id)` is a lexical validation pattern only. |
| WordPress plugin style | 2 / 1 / 1 | `wp-includes/core.php`: framework code outside plugin root | 1 / 0 / 0 | File discovered | Global function and `add_action` registration are not extracted. The absence of graph edges must not imply the hook is absent. |
| PHP 7.4 style | 1 / 1 / 1 | None | 3 / 2 / 1 | Class and typed method declaration | Namespace and typed property are not modeled; comparison is lexical. |
| PHP 8.1 style | 1 / 1 / 1 | None | 4 / 3 / 2 | Class and two method declarations | Attribute, promoted property, enum, and namespace are not modeled. Comparison and status assignment are lexical. |

## Compatibility matrix

| Construct | Status | Boundary |
| --- | --- | --- |
| PHP files in root, `application/`, `app/`, `src/`, and `wp-content/plugins/` | Tested and working | Eligibility only; 300 files, 2 MiB per file, 12 MiB total still apply. Sensitive filenames and dependency directories remain excluded. |
| Simple class and method declarations, including typed parameters/returns | Partially supported | Name and source location are extracted; signature, visibility semantics, inheritance, and namespace identity are not modeled. |
| Single-line comparisons, `empty` checks, arithmetic, status assignment | Partially supported | Source-pattern evidence; no control-flow proof or semantic validation. |
| CodeIgniter 3 `get_model`/`put_model` calls | Partially supported | Inferred named targets only; no runtime call verification. Other CodeIgniter conventions are not resolved. |
| Laravel route/controller/model relationships | Unsupported | Route files are excluded; Laravel method bodies may still yield isolated patterns. |
| WordPress global functions and hooks | Unsupported | Plugin file can be read, but hook registration is not graphed. |
| Namespaces, attributes, typed properties, enums | Partially supported for containing file; unsupported as graph entities | They do not prevent simple adjacent class/method matches, but their meaning is not extracted. |
| PHP syntax errors, dynamic dispatch, framework dependency injection, runtime behavior | Not yet tested / unsupported | No PHP parser or runtime execution is present. |

## Audit findings

- Before this audit, file selection only admitted PHP under `application/`, so plain, Laravel, CodeIgniter 4, and WordPress plugin examples were silently absent. The selection correction admits narrowly named source roots while retaining path, sensitive-file, and resource controls.
- Class and method detection could match block-comment text. It now uses the existing lexical comment/string filter. Lexical SQL table mentions are now **inferred** edges because a string containing a table name does not verify a database relationship.
- The generic CRUD fixture with `update`, `empty($id)`, and an SQL string is **not** classified as a business workflow after the certainty correction. This does not establish classifier accuracy on large real projects.
- The local scan panel now shows excluded-by-path/type and unreadable/changed counts. The overview retains scanner warnings and coverage limitations. Excluded paths are not listed individually in the UI, and no PHP syntax validation exists; a zero-warning scan therefore does not mean complete or correct understanding.

Reference patterns: [CodeIgniter controllers](https://codeigniter.com/user_guide/extending/basecontroller.html), [Laravel controllers](https://laravel.com/framework/docs/12.x/controllers), [WordPress actions](https://developer.wordpress.org/plugins/hooks/actions/), [PHP typed properties](https://www.php.net/manual/en/language.oop5.properties.php), [attributes](https://www.php.net/manual/en/language.attributes.overview.php), and [enums](https://www.php.net/manual/en/language.enumerations.overview.php).
