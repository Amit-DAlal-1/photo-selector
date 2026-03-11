# Production Improvement Plan (Functionality + Performance)

## 1) Goal

Make the app fluid and bug-free for large datasets (5k+ images) without performance compromises.

Success criteria:

- navigation latency: median <= 16ms, p95 <= 50ms on 5k images
- filter switch (all/selected/unselected): <= 120ms on 5k images
- first usable image after folder select: <= 2s on SSD for 5k files
- memory should plateau (no unbounded growth in long sessions)
- copy operation should be deterministic and complete without UI stalls

---

## 2) Prioritized Issues and Fixes

### P0 - Must Fix First

| ID | Issue / Improvement Required | Cause | Where | How to Fix |
|---|---|---|---|---|
| P0-1 | Virtual thumbnail strip can break after rerender (wrong order / scroll behavior) | Spacer nodes are treated as special but never marked; rerender path can append thumbs after bottom spacer | `app/src/main.js:220`, `app/src/main.js:225`, `app/src/main.js:307`, `app/src/main.js:309`, `app/src/main.js:268` | Mark top and bottom spacers using dataset flags. Enforce invariant structure `[topSpacer, thumbs..., bottomSpacer]` on each rerender. |
| P0-2 | Keyboard navigation is not fluid under key repeat | Debounce at trailing edge (80ms) coalesces key presses and drops responsiveness | `app/src/main.js:620` | Replace debounce with frame-throttle (`requestAnimationFrame`) or leading throttle (~16ms). Queue one pending navigation action per frame. |
| P0-3 | Scroll animation causes navigation jank | Smooth scrolling is triggered for every navigation step, creating animation backlog | `app/src/main.js:334`, `app/src/main.js:420` | Use instant scroll for keyboard navigation; keep smooth scroll only for click or larger jumps. Add source mode (`keyboard` vs `pointer`). |
| P0-4 | Repeated O(n) work for large lists | `getFilteredImages()` and selected count are recomputed repeatedly across render/update paths | `app/src/main.js:29`, `app/src/main.js:347`, `app/src/main.js:413`, `app/src/main.js:555` | Cache derived state (`filteredIndices`, `selectedCount`) and recompute only on selection/filter mutation. |
| P0-5 | Memory can grow during long sessions | Preload cache has no bound and no eviction strategy | `app/src/main.js:81`, `app/src/main.js:84`, `app/src/main.js:151` | Implement bounded LRU cache (target 150-300 images), evict oldest on insert over limit. |
| P0-6 | Selection toggle path can race under filtered mode | Delayed rerender via timer (`setTimeout(300)`) causes stale index conditions | `app/src/main.js:467` | Remove timer-based rerender. Apply immediate deterministic update flow: toggle -> recompute filtered view -> clamp index -> rerender once. |

### P1 - Strongly Recommended Before Release

| ID | Issue / Improvement Required | Cause | Where | How to Fix |
|---|---|---|---|---|
| P1-1 | Initial load can be slower on very large folders | `convertFileSrc` is computed eagerly for all images | `app/src/main.js:145`, `app/src/main.js:148` | Lazy-compute `src` on first use and cache it. Precompute only for visible window + near neighbors. |
| P1-2 | Excessive disk writes on rapid selection | Every toggle writes full `selection.json` | `app/src/main.js:460`, `app/src/main.js:463`, `app/src-tauri/src/commands.rs:175` | Debounce autosave (300-500ms), coalesce writes, flush on complete/close. |
| P1-3 | Destination conflict handling can degrade with many files | Repeated destination existence checks in rename loop | `app/src-tauri/src/commands.rs:139`, `app/src-tauri/src/commands.rs:153` | Build in-memory set of used destination names and update as copies are assigned. |

### P2 - Stability and Regression Prevention

| ID | Issue / Improvement Required | Cause | Where | How to Fix |
|---|---|---|---|---|
| P2-1 | No objective regression guardrails | No perf and scale test harness in pipeline | `app/package.json:6` | Add scripted benchmark/test suite for 1k/5k/10k datasets, with threshold checks and fail-fast output. |
| P2-2 | Virtualization metric can drift from CSS | Fixed JS row height may diverge from actual item height | `app/src/main.js:25`, `app/src/main.js:213` | Measure item height at runtime after render and update on resize/theme/layout changes. |

---

## 3) Task Breakdown

### Phase A: Correctness and Fluidity (P0)

| Task | Scope | Priority | Estimate | Output |
|---|---|---|---|---|
| A1 | Fix spacer tagging and virtual list invariant | P0 | 0.5 day | Stable virtual strip rerender |
| A2 | Replace keyboard debounce with frame throttle | P0 | 0.5 day | Smooth key-repeat navigation |
| A3 | Split scroll behavior by source (`keyboard`/`pointer`) | P0 | 0.5 day | No queued scroll jank |
| A4 | Introduce derived-state cache for filtered set and selected count | P0 | 1 day | Lower CPU cost in render path |
| A5 | Add bounded LRU preload cache | P0 | 0.5 day | Stable memory over long sessions |
| A6 | Remove timer-based filtered rerender race | P0 | 0.5 day | Deterministic selection behavior |

Acceptance for Phase A:

- no virtual strip ordering break during rapid scroll + toggle
- no delayed/jerky navigation during sustained arrow key press
- no stale index bug after repeated toggle in selected/unselected filters

### Phase B: Large Dataset Throughput (P1)

| Task | Scope | Priority | Estimate | Output |
|---|---|---|---|---|
| B1 | Lazy `src` generation and focused precompute | P1 | 0.5 day | Faster large-folder initial render |
| B2 | Debounced/coalesced `selection.json` writes | P1 | 0.5 day | Lower I/O under rapid toggles |
| B3 | Optimize copy conflict strategy with in-memory name set | P1 | 0.5 day | Faster copy under collision-heavy folders |

Acceptance for Phase B:

- first usable image time improved on 5k dataset
- no UI hitch from rapid selection toggles
- copy throughput remains stable with many filename collisions

### Phase C: Regression Safety (P2)

| Task | Scope | Priority | Estimate | Output |
|---|---|---|---|---|
| C1 | Add repeatable scale benchmark script and thresholds | P2 | 1 day | measurable pass/fail perf checks |
| C2 | Dynamic row-height calibration for virtualization | P2 | 0.5 day | robust virtualization across layout changes |

Acceptance for Phase C:

- benchmark run produces metrics and fails when thresholds regress
- virtualization remains accurate after resize/theme changes

---

## 4) Execution Order

1. Phase A (all P0 tasks)
2. Validate P0 acceptance on 5k dataset
3. Phase B (all P1 tasks)
4. Validate throughput and memory targets
5. Phase C (guardrails and hardening)
6. final release validation (1k/5k/10k datasets)

---

## 5) Definition of Done

The app is production-ready for functionality/performance when all conditions below are true:

- all P0 tasks are complete and verified
- no known navigation, filter, or virtual strip correctness bugs remain
- large dataset targets are met consistently on repeated runs
- memory usage remains bounded during long sessions
- perf regression checks are available and runnable before release
