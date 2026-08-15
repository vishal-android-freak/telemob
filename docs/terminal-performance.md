# Terminal performance

> Telemob is an unofficial, independent client and has no affiliation with
> Gravitational Inc. or the Teleport project.

Telemob keeps VT parsing and render preparation off the React Native UI thread.
The native terminal owns a persistent cell and byte snapshot, refreshes only
rows marked dirty by `libghostty-vt`, and coalesces output into at most one
prepared frame every 8 ms. Android and iOS then paint style runs with their
native 2D text APIs.

## Profiling markers

Native builds expose the same points of interest on both platforms:

- `Telemob.vtWrite` measures feeding an ordered PTY chunk into Ghostty.
- `Telemob.prepareSnapshot` measures dirty-state processing and creation of the
  immutable frame consumed by the platform view.

On Android, record a Perfetto/System Trace and inspect the Telemob process's
trace sections. On iOS, use Instruments with the Points of Interest and Time
Profiler instruments. Measure release or profile builds on physical hardware;
development-client JavaScript overhead is not representative.

## Representative workloads

Use the same terminal dimensions and repeat each workload at least three times:

1. Shell burst: print 10,000 numbered ANSI-colored lines.
2. Full-screen repaint: run a TUI that refreshes most rows while accepting
   keyboard and mouse input.
3. Partial repaint: update a clock or progress indicator on one row for 30
   seconds.
4. Scrollback: generate 10,000 lines, fling through history, search for an early
   and a late value, select text, and copy it.
5. Unicode: print combining marks, emoji, double-width CJK text, underline
   styles, inverse text, blink text, and OSC 8 hyperlinks.
6. Resize: rotate with the software keyboard open and closed while a TUI is
   active.

Record p50 and p95 duration for both markers, dropped or delayed frames, peak
memory, and visual/input defects. Keep the trace with the tested commit and
device/OS details so changes can be compared rather than judged by feel.

## Renderer decisions

The current native Canvas/Core Graphics path is deliberately retained until a
profile shows that painting, rather than parsing, transport, or snapshot
preparation, is the limiting stage. A GPU renderer adds glyph atlas, shaping,
fallback, synchronization, and lifecycle complexity; adopt one only with a
recorded workload that demonstrates a material improvement and no regression in
text correctness or power use.
