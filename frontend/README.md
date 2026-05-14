# OpenDDIL Demo — Frontend

The OpenDDIL Common Operating Picture (COP) UI. A Vite + React + TypeScript
SPA that renders three role-aware views over the live pipeline. It has **no
backend of its own and does no polling** — every piece of pipeline state
arrives over ElectricSQL Shapes from the Postgres read-model that
`openddil-projector` populates.

## Data flow

```
Kafka topics ─► openddil-projector ─► Postgres read-model ─► ElectricSQL ─► shape hooks ─► components
```

The frontend's only job is the last two hops: subscribe to Shapes, map rows
to typed objects, render. If a value is on screen, it came from a Shape (or
it is a clearly-marked DEMO_MOCK — see below).

## Shape hooks (`src/hooks/`)

All pipeline reads go through the hooks in `src/hooks/`. The foundation is
[`electric.ts`](src/hooks/electric.ts):

- **`useTableShape(table, map, opts?)`** — subscribes to one Postgres table
  as an ElectricSQL Shape and returns a uniform `ShapeResult<T>`:
  `{ data, isLoading, isError, lastSyncedAt }`. `opts.where` is a complete
  SQL `WHERE` clause for partial replication.
- **`ShapeResult<T>`** — the uniform return shape. `isLoading` is
  **true until the Shape's first sync completes** — components thread it
  through so a cold start shows a syncing state instead of flashing the
  genuinely-empty copy.
- **`num(v)`** — coerces Electric's string-numeric columns to `number`.
  Electric is precision-conservative and returns numeric columns as
  strings; jsonb columns come back already parsed.
- **`sqlLiteral(v)`** — single-quote-escapes a controlled value for
  inlining into a `where` clause (the per-asset hooks use this rather than
  Electric's positional-params path — see the comment in `electric.ts`).

The per-table hooks wrap `useTableShape` with a typed `map` function:

| Hook | Table | Notes |
|---|---|---|
| `useFleetAssets()` | `telemetry_latest_state` | every asset the pipeline has seen |
| `useTelemetryLatest(assetId)` | `telemetry_latest_state` | one asset (`where`-filtered) |
| `useCmState(assetId)` / `useAllCmState()` | `asset_cm_state` | per-asset / fleet-wide |
| `useLogisticsStatus(assetId)` / `useAllLogisticsStatus()` | `asset_logistics_status` | per-asset / fleet-wide |
| `useTelemetryWindows(assetId)` / `useAllTelemetryWindows()` | `asset_telemetry_windows` | per-asset / fleet-wide |
| `useTacticalEvents(limit, assetId?)` | `tactical_events` | append-only event feed |
| `useEdgeBuffer()` | `edge_buffer_status` | real edge→HQ buffer depth + link state |

`src/hooks/index.ts` re-exports them all. **To surface a new table in the
UI:** add a table to the Atlas schema, a handler + config entry to
`openddil-projector`, then a per-table hook here — no other plumbing.

## Routing model (`src/Root.tsx`)

There is **no router library**. `Root.tsx` holds a single `view` state —
one of `maintainer | regional | hq | controller` — and renders the matching
`*App` component:

- `MaintainerApp` — per-asset detail (fleet picker + CM / logistics /
  telemetry cards for one asset).
- `RegionalApp` — AOR fleet rollup (asset list, top constraining factors,
  CM compliance summary, fleet event feed).
- `HqApp` — enterprise analytics (fleet-wide readiness, configuration
  posture, wear trends).
- `ControllerApp` — the DDIL controller.

A **dev-only `?role=` URL param** overrides the active view (e.g.
`http://localhost:3017/?role=hq`) and is kept in sync on switch so a reload
or shared link lands on the same view. The dev nav bar at the top is *not*
part of the role UIs — it is a development affordance. Real auth/role
binding is deferred to a later phase.

> Aggregation note (ADR-0022): the three views are currently a
> **presentation layer over a single flat dataset** — "regional" filters
> the same asset pool, "HQ" regroups it. True edge→regional→HQ hierarchical
> aggregation is committed future work. Per-asset rows already carry
> `edge_id` / `region_id`; do not write view code that hardens the flat
> assumption.

## DEMO_MOCK pattern (ADR-0017)

Not every surface is wired to real data yet — the 3D battle views render
synthetic positions, pending a real geo-projection feed. **Every component
that renders synthetic / hardcoded data must self-identify**, with all
three of:

1. `const DEMO_MOCK = true;` near the top of the file (so
   `grep -rn DEMO_MOCK src/` is a complete, always-current inventory),
2. a visible `<DemoMockBanner note="..." />` — the small amber corner badge
   ([`src/components/DemoMockBanner.tsx`](src/components/DemoMockBanner.tsx)),
3. a top-of-file comment block explaining what is mocked and what real
   source it is waiting on.

A pure react-three-fiber primitive (no DOM wrapper) cannot host a DOM
banner — it carries (1) and (3) only, and the comment says why. There is
**no third state**: a component either reads real pipeline data or openly
declares itself a mock. See ADR-0017 for the full rule;
`tests/hero_scenario_v3/test_34_ui_demo_mock_banners.py` checks the
always-visible banners in CI.

## Development

```bash
npm install
npm run dev      # Vite dev server with HMR
npm run build    # production build (the demo image serves this via nginx)
npm run lint
```

In the compose stack the frontend is served by nginx on host port
**`3017`** (`docker compose up`, then `http://localhost:3017`). The dev
build is a static bundle — nginx also reverse-proxies `/proxies/` to
toxiproxy (the DDIL link control) and `/v1/shape` to ElectricSQL.

Tooling: Vite 7, React 19, TypeScript, Tailwind, Chart.js, react-three-fiber.
The ESLint config is in `eslint.config.js`.
