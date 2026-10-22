# Project benchmarks

## Cold processes

| Operation           | Median µs/op |
| ------------------- | -----------: |
| compiler-process    |    276443.71 |
| build-process       |    532283.96 |
| php-request-process |     45876.37 |

## Builds

| Operation         | Median µs/op |
| ----------------- | -----------: |
| full-build        |    229184.38 |
| noop-rebuild      |    218081.18 |
| leaf-edit-rebuild |    221154.47 |

## Rendering

| Operation            | Median µs/op |
| -------------------- | -----------: |
| components-and-slots |       163.72 |
| configure-and-render |       182.62 |
| renderer-and-assets  |       167.11 |

## Runtime membership lookups

| Literal list       | in_array µs/op | isset µs/op |
| ------------------ | -------------: | ----------: |
| boolean-attributes |         0.0222 |      0.0279 |
| url-attributes     |         0.0230 |      0.0266 |
| url-lists          |         0.0228 |      0.0261 |
| unsafe-tags        |         0.0214 |      0.0285 |
| unsafe-schemes     |         0.0239 |      0.0282 |
| asset-types        |         0.0207 |      0.0279 |

Five components render 100 cards with nested component calls, default slots, numeric attributes, and escaped text. Renderer measurements include dependency asset collection and stylesheet emission. Builds include output writes and PHP syntax checks for every component. Leaf edits include the source write; unchanged importers are reused. Cold timings include process startup and module loading; filesystem caches may be warm. PHP CLI OPcache is enabled but its cache is not shared between processes. These are CLI request proxies, not HTTP/FPM latency measurements.

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1.

Run with `pnpm bench:project`. Control counts with `BENCH_SAMPLES`, `BENCH_PROJECT_ITERATIONS`, and `BENCH_RENDERS`.

[Raw results](project-results.json)
