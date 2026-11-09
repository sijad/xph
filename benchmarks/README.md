# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

## Compilation

| Fixture          |     xph | Blade |   Twig | Fastest | Less time than others         |
| ---------------- | ------: | ----: | -----: | ------- | ----------------------------- |
| static           |  100.36 |  1.75 |  35.56 | Blade   | 98.26% vs xph; 95.09% vs Twig |
| escaped          |  867.03 |  2.85 |  84.41 | Blade   | 99.67% vs xph; 96.63% vs Twig |
| list-100         | 1244.32 |  8.45 | 189.25 | Blade   | 99.32% vs xph; 95.54% vs Twig |
| control-flow-100 | 1408.63 | 10.68 | 253.36 | Blade   | 99.24% vs xph; 95.78% vs Twig |
| dashboard-nested | 2219.20 | 26.77 | 571.81 | Blade   | 98.79% vs xph; 95.32% vs Twig |

## Rendering

| Fixture          |    xph |  Blade |   Twig | Fastest | Less time than others           |
| ---------------- | -----: | -----: | -----: | ------- | ------------------------------- |
| static           |   0.18 |   1.55 |   0.87 | xph     | 88.33% vs Blade; 79.32% vs Twig |
| escaped          |   0.62 |   2.05 |   1.40 | xph     | 69.73% vs Blade; 55.52% vs Twig |
| list-100         |  24.15 |  47.12 |  48.12 | xph     | 48.76% vs Blade; 49.83% vs Twig |
| control-flow-100 |  33.21 |  47.92 |  53.65 | xph     | 30.68% vs Blade; 38.09% vs Twig |
| dashboard-nested | 244.19 | 374.99 | 365.31 | xph     | 34.88% vs Blade; 33.15% vs Twig |

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1 · Blade v13.38.0 · Twig v3.30.0.

[Raw results](results.json)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with `pnpm bench:project`).
