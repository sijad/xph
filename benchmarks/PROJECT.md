# Project benchmarks

## Cold processes

| Operation           | Median µs/op |
| ------------------- | -----------: |
| compiler-process    |    284653.96 |
| build-process       |    365711.00 |
| php-request-process |     44601.13 |

## Builds

| Operation         | Median µs/op |
| ----------------- | -----------: |
| full-build        |     58517.68 |
| noop-rebuild      |      6839.40 |
| leaf-edit-rebuild |     52474.38 |

## Rendering

| Operation            | Median µs/op |
| -------------------- | -----------: |
| components-and-slots |       141.68 |
| configure-and-render |       145.36 |
| renderer-and-assets  |       144.96 |

## Runtime membership lookups

| Literal list       | in_array µs/op | isset µs/op |
| ------------------ | -------------: | ----------: |
| boolean-attributes |         0.0211 |      0.0249 |
| url-attributes     |         0.0217 |      0.0255 |
| url-lists          |         0.0217 |      0.0252 |
| unsafe-tags        |         0.0207 |      0.0242 |
| unsafe-schemes     |         0.0233 |      0.0262 |
| asset-types        |         0.0195 |      0.0242 |

Five components render 100 cards with nested component calls, default slots, numeric attributes, and escaped text. Renderer measurements include dependency asset collection and stylesheet emission. Builds include output writes and PHP syntax checks for every component. Leaf edits include the source write; unchanged importers are reused. Cold timings include process startup and module loading; filesystem caches may be warm. PHP CLI OPcache is enabled but its cache is not shared between processes. These are CLI request proxies, not HTTP/FPM latency measurements.

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1.

Run with `pnpm bench:project`. Control counts with `BENCH_SAMPLES`, `BENCH_PROJECT_ITERATIONS`, and `BENCH_RENDERS`.

[Raw results](project-results.json)
