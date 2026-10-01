# OfficeAI — Gen Z office and mobile control

This delivery extends REMOTE_AGENT_CONTROL_PLAN.md. The existing renderer, activity
pipeline and message endpoints are the starting point. Completion is measured by
real visuals, terminal delivery and device checks, not by buttons being present.

## Product experience

1. Open the office: a modern, legible diorama with distinct young adult characters.
2. Rotate or pinch without accidentally selecting a character. Tap a person or the
   agent tray to select the same agent on either device. Reset and focus controls
   make it easy to recover the camera.
3. The detail sheet keeps the current workspace, live status, real activity and
   prompt composer in reach. Keyboard opening must not cover the Send button.
4. Sending gives a transport receipt. Activity from the agent's own log confirms
   execution. Drafts survive failed requests; POSTs are never automatically retried.
5. Existing CLI agents attach to a verified Kitty window or tmux pane. An unavailable
   transport shows a concrete recovery instruction. PID alone is not a writable
   terminal, and a successful subprocess exit is not proof the agent received text.

## Character direction

- One original low-poly GLB with a skeleton and shared animation clips.
- Human face, hair, oversized hoodie, layered shirt, joggers and sneakers.
- Stable appearance keyed by agent ID: hoodies, caps, beanies, headphones,
  streetwear and the glasses-wearing tech-freak variant. Reconnecting or changing
  list order must not change the outfit.
- Real shoulder, elbow, hip and knee pivots. Walk, idle, sit, type, smoke and repair
  blend between poses; working agents remain at their assigned desk.
- Smoking props follow the hand; mouth smoke fades during exhalation. Repair props
  follow the hand. Decorative activity must not override an actual working status.
- Same renderer and asset in desktop and Flutter. A failed GLB load keeps the
  procedural fallback available and exposes the failure to diagnostics.

## Performance budgets and baseline

Budgets are targets, to be checked on available hardware:

- Avatar GLB under 500 KiB, under 8,000 triangles, no external texture/network fetch.
- Share model geometry and clips; clone skeletons and recolor only instance materials.
- Foreground target 30 FPS, mobile capped pixel ratio, pause hidden scene and report
  FPS/draw calls/triangle count for repeatable comparisons.
- Record release APK and scene bundle sizes before/after. Debug APK size is not a
  release-size comparison. Use the same viewport, agent count and power profile for
  CPU/RAM/FPS comparisons. RSS sums double-count shared memory; prefer PSS.
- Baseline on 2026-10-01: debug APK 191,128,651 bytes; release APK 50,945,658 bytes;
  Svelte check clean; 397 Rust tests pass. Live Android/desktop metrics require a
  running device/app and are not inferred from an old screenshot.

## Terminal control and shared contract

- Recover Kitty's Unix socket/window ID or tmux's socket/pane ID from the agent's
  process environment. Verify process start time, provider, canonical cwd, foreground
  process group and terminal ancestry before every write.
- Match an exact window/pane. Two agents in one workspace must remain distinct.
- Reuse one backend message service for desktop IPC and the remote API.
- GET /api/v1/agents/:id/control returns canSend, reason, transport, controlMode,
  queued and supported sendModes. Control discovery only inspects terminal state.
- now only when ready; queue has one slot; interrupt requires mobile confirmation.
  Failed queued delivery must retain the prompt for recovery.
- Use stdin and bracketed paste; never interpolate prompts into shell commands.
  Keep bearer auth, body limits, control toggle and workspace validation.
- Existing terminal recovery after an OfficeAI restart must verify identity anew.

## Implementation order

1. Record baseline; add original GLB generation, loader and skeleton cloning.
2. Integrate blended poses, reliable selection/camera and bounded rendering.
3. Implement verified Kitty/tmux attach and shared delivery/capability service.
4. Make Flutter sheet live, capability-driven, keyboard-safe and reconnect-aware.
5. Build shared mobile scene, desktop and Android; verify genuine terminal delivery
   in an isolated session and visual behavior at desktop/phone viewports.

## Acceptance gates

- All six fashion variants render correctly; stable ID produces the same variant.
- Avatar limbs articulate; working/sitting orientation matches the desk. Rotating
  the camera does not open sheets; selection survives state refresh.
- GLB and bundled mobile HTML load offline. Model error leaves a usable fallback.
- Manual agent in a supported terminal accepts a prompt without replacing its
  conversation. The wrong foreground process, stale PID or changed cwd refuses input.
- Busy/send/queue/interrupt errors are actionable; drafts survive failure and the
  live sheet detects agent exit. Queue is not silently lost.
- Existing relevant checks pass; release artifacts are built. Device-dependent
  gates are explicitly reported as measured or unavailable, never marked passed
  from compilation alone.

## Delivery record — 2026-10-01

Implemented: original rigged GLB with stable six-style fashion, shared desktop/mobile
loader and clips, collision-aware routes, tap/orbit separation, camera reset/focus,
background pause, static batching, verified Kitty/tmux capability and shared prompt
service, keyboard-safe live Flutter composer, transport receipts and retained drafts.
Queue delivery reserves its slot atomically and restores failed delivery in memory.
Mobile JSON requests now use Content-Length accepted by the existing HTTP server.
No raw shell endpoint or automatic POST retry was added.

| Check | Result |
| --- | --- |
| Svelte / TypeScript | 0 errors, 0 warnings |
| JavaScript unit/integration tests | 450 passed |
| Rust library tests | 403 passed; graphical integration test ignored by default |
| Real Kitty integration, run explicitly | Passed: two isolated fake CLI windows, literal multiline prompt goes only to exact target, stale identity/wrong window rejected, Ctrl+C received |
| Flutter analyze / tests | Clean; 2 tests passed, including bearer/receipt/body-length contract |
| Local production mobile bundle smoke test | Passed offline, six rigged avatars, selection, no false selection on orbit, repeated teardown/recreate without geometry growth, no page errors |
| Avatar asset | 456,264 bytes, 15 joints, six clips; under 8,000 total triangles, no external textures |
| Render overhead in preview | Before batching: approximately 659 draw calls / 484 geometries; final smoke viewport: 281 calls / 114 geometries. Camera/status differences mean this is not a device FPS benchmark. |
| Release APK | 51,442,418 bytes vs baseline 50,945,658 (+496,760 bytes, approximately 0.98%) |
| APK scene integrity | Bundled index.html SHA-256 equals source production bundle; duplicate standalone scene.js is not packaged |
| Desktop | Optimized native build successful; Arch package officeai 0.1.0-2 installed and installed binary checksum verified |
| Branding / documentation | New original SVG mark and generated desktop/Android icons, updated README, © 2026 nox14 with upstream MIT notice retained |

Android installation is deliberately left to the user. Actual Samsung WebView/GPU
FPS, Android RAM and mobile-to-provider end-to-end execution still require an on-device
review; browser smoke tests and compilation are not substitutes. tmux targeting has
parser/unit coverage but was not exercised against a live tmux server on this machine.
Named Tunnel + Access, production rate limiting, persisted queues and arbitrary
non-Kitty/non-tmux terminal attach remain future work, not completed gates.
