# Project benchmarks

## Cold processes

| Operation           | Median µs/op |
| ------------------- | -----------: |
| compiler-process    |    279349.62 |
| build-process       |    537252.83 |
| php-request-process |     45835.04 |

## Builds

| Operation         | Median µs/op |
| ----------------- | -----------: |
| full-build        |    230301.19 |
| noop-rebuild      |    223615.06 |
| leaf-edit-rebuild |    223110.83 |

## Rendering

| Operation            | Median µs/op |
| -------------------- | -----------: |
| components-and-slots |       157.67 |
| configure-and-render |       174.71 |
| renderer-and-assets  |       158.17 |

## Runtime membership lookups

| Literal list       | in_array µs/op | isset µs/op |
| ------------------ | -------------: | ----------: |
| boolean-attributes |         0.0223 |      0.0275 |
| url-attributes     |         0.0227 |      0.0268 |
| url-lists          |         0.0220 |      0.0257 |
| unsafe-tags        |         0.0213 |      0.0282 |
| unsafe-schemes     |         0.0235 |      0.0278 |
| asset-types        |         0.0201 |      0.0235 |

Five components render 100 cards with nested component calls, default slots, numeric attributes, and escaped text. Renderer measurements include dependency asset collection and stylesheet emission. Builds include output writes and PHP syntax checks for every component. Leaf edits include the source write; unchanged importers are reused. Cold timings include process startup and module loading; filesystem caches may be warm. PHP CLI OPcache is enabled but its cache is not shared between processes. These are CLI request proxies, not HTTP/FPM latency measurements.

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1.

Run with `pnpm bench:project`. Control counts with `BENCH_SAMPLES`, `BENCH_PROJECT_ITERATIONS`, and `BENCH_RENDERS`.

[Raw results](project-results.json)
