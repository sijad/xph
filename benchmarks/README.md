# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

## Compilation

| Fixture          |     xph | Blade |   Twig | Fastest | Less time than others         |
| ---------------- | ------: | ----: | -----: | ------- | ----------------------------- |
| static           |   81.11 |  1.78 |  35.58 | Blade   | 97.80% vs xph; 94.99% vs Twig |
| escaped          |  805.11 |  2.81 |  84.06 | Blade   | 99.65% vs xph; 96.66% vs Twig |
| list-100         | 1174.35 |  8.62 | 190.31 | Blade   | 99.27% vs xph; 95.47% vs Twig |
| control-flow-100 | 1221.75 | 11.07 | 251.00 | Blade   | 99.09% vs xph; 95.59% vs Twig |
| dashboard-nested | 1980.98 | 26.99 | 557.16 | Blade   | 98.64% vs xph; 95.16% vs Twig |

## Rendering

| Fixture          |    xph |  Blade |   Twig | Fastest | Less time than others           |
| ---------------- | -----: | -----: | -----: | ------- | ------------------------------- |
| static           |   0.17 |   1.50 |   0.89 | xph     | 88.98% vs Blade; 81.46% vs Twig |
| escaped          |   0.60 |   1.93 |   1.37 | xph     | 68.92% vs Blade; 56.23% vs Twig |
| list-100         |  24.68 |  44.49 |  48.26 | xph     | 44.53% vs Blade; 48.86% vs Twig |
| control-flow-100 |  32.02 |  44.97 |  53.23 | xph     | 28.80% vs Blade; 39.84% vs Twig |
| dashboard-nested | 241.93 | 338.06 | 355.71 | xph     | 28.44% vs Blade; 31.99% vs Twig |

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1 · Blade v12.70.1 · Twig v3.30.0.

[Raw results](results.json)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with `pnpm bench:project`).
