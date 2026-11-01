# Project benchmarks

## Cold processes

| Operation           | Median µs/op |
| ------------------- | -----------: |
| compiler-process    |    279810.21 |
| build-process       |    533989.58 |
| php-request-process |     46168.37 |

## Builds

| Operation         | Median µs/op |
| ----------------- | -----------: |
| full-build        |    234435.90 |
| noop-rebuild      |     50983.44 |
| leaf-edit-rebuild |     96442.85 |

## Rendering

| Operation            | Median µs/op |
| -------------------- | -----------: |
| components-and-slots |       155.58 |
| configure-and-render |       158.17 |
| renderer-and-assets  |       157.96 |

## Runtime membership lookups

| Literal list       | in_array µs/op | isset µs/op |
| ------------------ | -------------: | ----------: |
| boolean-attributes |         0.0223 |      0.0259 |
| url-attributes     |         0.0228 |      0.0262 |
| url-lists          |         0.0226 |      0.0264 |
| unsafe-tags        |         0.0211 |      0.0243 |
| unsafe-schemes     |         0.0231 |      0.0273 |
| asset-types        |         0.0204 |      0.0239 |

Five components render 100 cards with nested component calls, default slots, numeric attributes, and escaped text. Renderer measurements include dependency asset collection and stylesheet emission. Builds include output writes and PHP syntax checks for every component. Leaf edits include the source write; unchanged importers are reused. Cold timings include process startup and module loading; filesystem caches may be warm. PHP CLI OPcache is enabled but its cache is not shared between processes. These are CLI request proxies, not HTTP/FPM latency measurements.

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1.

Run with `pnpm bench:project`. Control counts with `BENCH_SAMPLES`, `BENCH_PROJECT_ITERATIONS`, and `BENCH_RENDERS`.

[Raw results](project-results.json)
