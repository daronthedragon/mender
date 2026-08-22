# Repair benchmark

Measures repair against **real pages**, not hand-written fixtures.

For each page: infer a spec, archive the page as the fixture, mutate the page
the way a redeploy would, then ask mender to repair it.

The verdict that matters is not "did it repair" but **"is the repaired data the
same data"**. A repair that silently changes the values is the failure this
project exists to prevent, so that outcome is counted separately.

```bash
node bench/fetch-pages.mjs      # snapshot the pages (needs network)
node bench/repair-bench.mjs     # run the benchmark (offline)
```

Latest run, 15 pages x 4 mutations:

```
repaired: 29   refused: 4   WRONG: 0   not-applicable: 27
```

A "refused" is a correct outcome: mender could not prove a repair, so it changed
nothing and said so. A `WRONG` is a bug, and finding one is the point.

Mutations that turn out not to break the contract are counted `not-applicable`
rather than as successes.
