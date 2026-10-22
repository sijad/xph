# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

## Compilation

| Fixture          |     xph | Blade |   Twig | Fastest | Less time than others         |
| ---------------- | ------: | ----: | -----: | ------- | ----------------------------- |
| static           |   80.74 |  1.76 |  35.39 | Blade   | 97.82% vs xph; 95.03% vs Twig |
| escaped          |  834.61 |  2.87 |  84.42 | Blade   | 99.66% vs xph; 96.60% vs Twig |
| list-100         | 1176.91 |  8.37 | 189.13 | Blade   | 99.29% vs xph; 95.57% vs Twig |
| control-flow-100 | 1218.22 | 10.92 | 255.74 | Blade   | 99.10% vs xph; 95.73% vs Twig |
| dashboard-nested | 2023.66 | 26.46 | 562.01 | Blade   | 98.69% vs xph; 95.29% vs Twig |

## Rendering

| Fixture          |    xph |  Blade |   Twig | Fastest | Less time than others           |
| ---------------- | -----: | -----: | -----: | ------- | ------------------------------- |
| static           |   0.16 |   1.60 |   0.86 | xph     | 89.74% vs Blade; 80.88% vs Twig |
| escaped          |   0.61 |   2.11 |   1.39 | xph     | 71.02% vs Blade; 55.94% vs Twig |
| list-100         |  23.88 |  47.68 |  48.51 | xph     | 49.92% vs Blade; 50.77% vs Twig |
| control-flow-100 |  32.16 |  47.87 |  54.18 | xph     | 32.82% vs Blade; 40.64% vs Twig |
| dashboard-nested | 238.38 | 362.62 | 359.72 | xph     | 34.26% vs Blade; 33.73% vs Twig |

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1 · Blade v13.38.0 · Twig v3.30.0.

[Raw results](results.json)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with `pnpm bench:project`).
