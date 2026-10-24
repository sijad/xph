# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

## Compilation

| Fixture          |     xph | Blade |   Twig | Fastest | Less time than others         |
| ---------------- | ------: | ----: | -----: | ------- | ----------------------------- |
| static           |   79.27 |  1.82 |  35.49 | Blade   | 97.70% vs xph; 94.87% vs Twig |
| escaped          |  820.47 |  2.84 |  83.17 | Blade   | 99.65% vs xph; 96.58% vs Twig |
| list-100         | 1150.07 |  8.17 | 187.94 | Blade   | 99.29% vs xph; 95.65% vs Twig |
| control-flow-100 | 1279.28 | 10.53 | 252.46 | Blade   | 99.18% vs xph; 95.83% vs Twig |
| dashboard-nested | 1948.31 | 26.09 | 559.91 | Blade   | 98.66% vs xph; 95.34% vs Twig |

## Rendering

| Fixture          |    xph |  Blade |   Twig | Fastest | Less time than others           |
| ---------------- | -----: | -----: | -----: | ------- | ------------------------------- |
| static           |   0.16 |   1.57 |   0.86 | xph     | 89.50% vs Blade; 80.76% vs Twig |
| escaped          |   0.59 |   2.01 |   1.37 | xph     | 70.53% vs Blade; 56.73% vs Twig |
| list-100         |  23.66 |  46.71 |  47.47 | xph     | 49.35% vs Blade; 50.16% vs Twig |
| control-flow-100 |  31.84 |  47.47 |  52.97 | xph     | 32.93% vs Blade; 39.88% vs Twig |
| dashboard-nested | 235.83 | 364.21 | 350.42 | xph     | 35.25% vs Blade; 32.70% vs Twig |

Apple M4 Pro · PHP 8.5.11 · Node v22.23.1 · Blade v13.38.0 · Twig v3.30.0.

[Raw results](results.json)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with `pnpm bench:project`).
