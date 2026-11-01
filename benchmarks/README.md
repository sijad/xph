# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

## Compilation

| Fixture          |     xph | Blade |   Twig | Fastest | Less time than others         |
| ---------------- | ------: | ----: | -----: | ------- | ----------------------------- |
| static           |   90.97 |  1.56 |  32.78 | Blade   | 98.28% vs xph; 95.24% vs Twig |
| escaped          |  814.85 |  2.56 |  76.58 | Blade   | 99.69% vs xph; 96.65% vs Twig |
| list-100         | 1110.26 |  7.83 | 175.19 | Blade   | 99.29% vs xph; 95.53% vs Twig |
| control-flow-100 | 1168.21 |  9.87 | 235.27 | Blade   | 99.15% vs xph; 95.80% vs Twig |
| dashboard-nested | 2129.91 | 24.66 | 526.56 | Blade   | 98.84% vs xph; 95.32% vs Twig |

## Rendering

| Fixture          |    xph |  Blade |   Twig | Fastest | Less time than others           |
| ---------------- | -----: | -----: | -----: | ------- | ------------------------------- |
| static           |   0.15 |   1.47 |   0.82 | xph     | 89.64% vs Blade; 81.50% vs Twig |
| escaped          |   0.56 |   1.86 |   1.25 | xph     | 69.94% vs Blade; 55.15% vs Twig |
| list-100         |  22.36 |  44.14 |  44.96 | xph     | 49.34% vs Blade; 50.27% vs Twig |
| control-flow-100 |  30.28 |  45.27 |  50.43 | xph     | 33.11% vs Blade; 39.95% vs Twig |
| dashboard-nested | 226.42 | 345.01 | 333.32 | xph     | 34.37% vs Blade; 32.07% vs Twig |

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1 · Blade v13.38.0 · Twig v3.30.0.

[Raw results](results.json)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with `pnpm bench:project`).
