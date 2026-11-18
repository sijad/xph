# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

## Compilation

| Fixture          |     xph | Blade |   Twig | Fastest | Less time than others         |
| ---------------- | ------: | ----: | -----: | ------- | ----------------------------- |
| static           |  613.75 |  1.82 |  35.64 | Blade   | 99.70% vs xph; 94.90% vs Twig |
| escaped          |  790.44 |  2.69 |  80.99 | Blade   | 99.66% vs xph; 96.68% vs Twig |
| list-100         | 1214.67 |  7.96 | 181.74 | Blade   | 99.34% vs xph; 95.62% vs Twig |
| control-flow-100 | 1336.22 | 10.29 | 243.81 | Blade   | 99.23% vs xph; 95.78% vs Twig |
| dashboard-nested | 1760.07 | 26.17 | 556.45 | Blade   | 98.51% vs xph; 95.30% vs Twig |

## Rendering

| Fixture          |    xph |  Blade |   Twig | Fastest | Less time than others           |
| ---------------- | -----: | -----: | -----: | ------- | ------------------------------- |
| static           |   0.16 |   1.56 |   0.87 | xph     | 89.67% vs Blade; 81.43% vs Twig |
| escaped          |   0.59 |   1.96 |   1.34 | xph     | 69.93% vs Blade; 55.97% vs Twig |
| list-100         |  23.66 |  46.39 |  47.21 | xph     | 49.01% vs Blade; 49.89% vs Twig |
| control-flow-100 |  32.38 |  46.84 |  53.59 | xph     | 30.86% vs Blade; 39.57% vs Twig |
| dashboard-nested | 246.94 | 368.54 | 360.48 | xph     | 32.99% vs Blade; 31.50% vs Twig |

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1 · Blade v13.38.0 · Twig v3.30.0.

[Raw results](results.json)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with `pnpm bench:project`).
