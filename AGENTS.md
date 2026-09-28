# AGENTS.md

Non-obvious facts only. Everything here was witnessed against the running system unless marked otherwise.

## Gemini Live

- Model is `gemini-3.8-live` (`GEMINI_LIVE_MODEL` overrides). Audio-only sessions last 15 minutes, audio plus video 2 minutes; `sessionResumption` plus `contextWindowCompression` extend them. Input audio is 16-bit PCM 16 kHz, output 24 kHz.
- Tool responses are never automatic: answer every `toolCall` with `sendToolResponse`, once per id.
- Ephemeral tokens: `client.authTokens.create({ config: { uses, expireTime, newSessionExpireTime, liveConnectConstraints } })`. Fields set in `liveConnectConstraints.config` are locked; the client may still send `sessionResumption`, compression and transcription config.
- Do not pass `lockAdditionalFields: []`. The SDK then builds a field mask with array indexes such as `tools.0` and upstream rejects it (`field_mask is invalid`). Leave it unset.
- The SDK prints a warning that ephemeral tokens need `apiVersion: 'v1alpha'`. The default version works and enforces the locks. `EPHEMERAL_API_VERSION` exists as an override.
- A real microphone or fake media device feeds the model noise; it transcribes it and edits files unprompted. The system instruction, the edit rate limit and the pause toggle exist because of that.
- The `state` of `LiveSession` becomes `open` only after `live.connect()` resolves; `onopen` fires before `this.session` exists, so sending from it throws.
- Key is `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) in `.env`, read on every mint, never returned or logged. A dev server without the key answers `api_key_missing` (503).

## Vision

- Frames only flow while the tab is shared (`getDisplayMedia`, started from the Start click). Every tool result carries `screen.sharing`; the live page tells the model when it is blind or sharing, and sends a fresh frame after every mutating tool before answering (`freshFrameBeforeAnswer`).
- Witnessed with a synthetic canvas screen: 24 frames sent, the model read back the exact words, then reported the new title after an edit.

## Vite behaviour that shaped the design

- A non-accepting edit broadcasts `full-reload` with `path: "*"`, reloading every page. `server/plugin.js` wraps `server.environments.client.hot.send` and rescopes to `/app/index.html` when the trigger is under `app/`.
- `/live/` must never hot-update: its HTML is stripped of every script mentioning `@vite/client` or `@react-refresh`. `window.__debug.hmrFree` checks it.
- Vite's overlay is disabled; `server/reporter.js` draws its own from the server status stream.
- Plain JS syntax errors are invisible to Vite (it only lexes); the server parses with `parseAst` from `vite`. Errors carry `pos` or a numbered source line in the message, not `loc`.
- `transformRequest` is cached; call `environments.client.moduleGraph.onFileChange(file)` first.
- `localhost` resolves to `::1` first and Vite bound only that, which refused `127.0.0.1` and blanked the cross-site app frame. The server pins `127.0.0.1`. Do not use `host: true`: the file tools would be reachable from the LAN.
- Vite's `server.close()` waits for open connections. Event streams are ended in a wrapped `close`, otherwise restarts fail with `Port already in use` and the old process keeps serving stale code. Editing a `server/*.js` file restarts the server inside the same node process through Vite's internal `_closeServer`, which skips the wrapped `close`, and re-imports the plugin as new module instances. Cleanup therefore also lives in the plugin's `closeBundle` hook, and parse workers are tracked in a process-global registry (`safeParse.js`) where a new instance retires the old instance's workers; workers also exit after 30 s without an owner ping.
- After `npm install` a running Vite keeps failing to resolve the new package (not the package cache; witnessed). `depsOptimizer.registerMissingImport(specifier, entryFile)` fixes it without a restart.
- `[vite] Failed to reload ...` (not `[hmr]`) is the message for a failed hot update.
- React Fast Refresh cannot match a renamed default component, so the old component keeps rendering. `app/main.tsx` re-imports the page after an update and remounts when the component name changed, and keeps its root in `import.meta.hot.data` (re-execution otherwise calls `createRoot` twice).

## Error pipeline invariants

- Status is `unresponsive` > `broken` > `no_page` > `healthy`, derived only from active errors and page liveness.
- Build errors are keyed by file and cleared only when that file next checks clean (watcher, tool write or startup scan). Every check also rechecks files that currently have errors.
- Runtime errors carry the page's client sequence number. An update clears errors older than its `update-start`. `hmr-failed` errors are hidden while a build error exists; messages are normalized (no origin, no `?t=`).
- A page that renders nothing visible is reported as `blank` (first check 1.5 s after load), healed by one reload, and cleared by a `content` event. Only `#root` is inspected (without `#root`: body children except script/style, `#page-loads` and `[data-hmr-chrome]`), so the load badge never masks a blank page.
- `server/reporter.js` never throws into app code: `console.error/warn` always reach the original console; repeats of the same message within 1 s are coalesced and log posts pass a token bucket (10, refill 2/s; counts in `__hmrLiveReporter.coalesced/dropped`). Its event stream reopens with jittered backoff when the server refuses it (503 at capacity closes an `EventSource` for good).
- After a write the tool waits for the page to acknowledge, then a grace window, and forces one scoped reload when the page never picked up a repair, hit `hmr-failed`, or is blank. Post-reload grace is longer than the blank check.
- Page liveness comes from the page's event stream (`/api/events?page=<id>`): a closed or crashed tab drops it and is removed immediately; a page in an infinite loop keeps it and turns `unresponsive`. A hung frame is rebuilt by `/live/`, which reacts only to its own named frame (`hmr-live-frame`).
- A server ID in every snapshot lets framed pages reload themselves and `/live/` rebuild its frame when the dev server restarts.
- Errors already returned in a tool result are marked reported and not announced again. `live/notices.js` announces the rest with a 3 s grace, 5 s cooldown and 6 notices a minute.
- `/api/debug` has a 300 entry trace of page events and of which code path cleared each build error.

## Sandbox and writes

- `server/paths.js` is the only constructor of a writable path. Reserved names, `:` (alternate data streams), trailing dot or space, `~` and NTFS junctions are rejected; the deepest existing ancestor is resolved with `realpath`. Arguments are never URL-decoded.
- Renaming a temp file over a file another process has open fails intermittently with `EPERM` on Windows; `writeAtomically` retries with backoff, falls back to a copy, and always removes the temp file.
- Editing tools are rate limited (20 a minute) and can be paused. `restore_last_good` uses one snapshot. It is taken only when status is healthy, the app has been quiet for 2 seconds, and every connected page, hidden ones included (a hidden tab heartbeats about once a minute), has heartbeated and acknowledged the latest change. Otherwise an infinite-loop edit can become the snapshot. Restore ignores the edit pause and the rate limit and is not size capped.

## Code execution and secret exposure

- Tailwind runs inside the dev-server process. A stylesheet with `@plugin` or `@config` executes app-supplied JavaScript there, and `@import "../../.env"` echoes `.env` lines into a build error. `server/cssPolicy.js` is a `pre` plugin that rejects both (also escaped at-rule names, non-`.css` or out-of-`app/` relative imports, `source()` outside `app/`) before Tailwind or PostCSS sees the file, following nested imports. Build errors also pass through `redactSecrets`.
- `app/main.tsx` and `app/index.html` are the harness the error pipeline depends on (shared `createRoot` in `import.meta.hot.data`, remount on renamed component, `data-hmr-chrome` on the load badge so the blank check is not masked). The editing tools can overwrite them; if blank pages stop being detected or renamed components keep the old render, check them first.
- Regexes over template or file content must be linear: three backtracking patterns took 28-62 s on 512 KB inputs and froze the event loop. Import specifiers come from the AST, the record scan has a character budget.
- `parseAst` (rolldown) can kill the whole process: 8000 nested `(`, 5000 `[`, 20000 `a=>`, 50000 `<div>` or `${` chains overflow the native stack (exit 0xC00000FD), 30000 repeated `export ` exhausts the heap, 20000 is quadratic. Never call it on untrusted source in the dev-server process. `server/safeParse.js` runs it in a forked worker (384 MB heap, respawn after a crash or timeout, exits after 20 s idle, never spawned after server close; a request must not be sent to a worker that was just killed). The gate is a linear pre-scan (`parseGuard.js`: bracket, template and JSX depth 1500, repeated-word cap), then parse, a tree-depth check, then the same oxc transform Vite runs, because the transform crashes at lower nesting (about 9700 JSX levels) than the parser (about 13800). Two lanes keep a hostile `v0_import` from stalling writes: interactive (writes, diagnostics, 4 s) and bulk (imports, shadcn, 2.5 s; an import stops after 3 unparseable files or 20 s). Every app write goes through `server/appWrite.js`, which refuses such files (`file_too_complex`) before they reach disk and enforces the protected files case-insensitively (NTFS ignores case). Files that arrive by hand pass the same gate in an `enforce: 'pre'` plugin in `v0-compat.js` and become a build error.
- CSS imports are resolved the way Tailwind resolves them: `@/` is `app/`, then relative paths, then bare packages through the `node_modules` chain. Package stylesheets are an allowlist (tailwindcss, tw-animate-css, shadcn, @tailwindcss/*, @fontsource*, normalize.css, modern-normalize) trusted only from the project-root `node_modules`; a same-named copy under `app/` is rejected. Anything else must be a `.css` file inside `app/`, scanned recursively, and an import that resolves to nothing is rejected, so the imported file must exist first (`@import "@/other.css"` once bypassed the policy this way). Inline `<style>` in html is processed by Tailwind as an `?html-proxy&index=N.css` module, so the policy matches the id, not the file extension. `node_modules` segments cannot be written.
- Package vetting also needs a stable release at least 7 days old, a non-deprecated latest release, and a name more than one edit away from popular packages and this project's own dependencies; the exact vetted version is installed. Transitive dependencies are not vetted.
- Origin isolation: the control page is always `http://localhost:PORT/live/` (`127.0.0.1/live` redirects there) and the app frame and the "open in its own tab" link are always `http://127.0.0.1:PORT`. `POST /token`, `/tool`, `/pause` and `GET /config`, `/debug` answer only to Origin hostname `localhost` (`control_origin_required` otherwise), so code running in the app page cannot drive the tools; reporter routes accept both. `server.cors` is off (Vite's default lets any localhost origin read responses). Requests without an Origin header (curl) pass.
- `upstream.js` follows redirects by hand and checks every hop against the allowlist before requesting it.

## v0

- Disclosed meaning: Vercel v0 (Next.js, Tailwind, shadcn/ui). `app/` is a v0 project root, `@` aliases `app/`, `next/*` imports are shimmed by `server/v0-compat.js`, never copied into `app/`.
- v0's template gallery pages `https://v0.app/templates/<category>` are server-rendered. Each holds about 46 records in the Next flight data (`{"blockId":"b_...","templateCanonId":...}` with title, tags, uses, likes, demo URL). A template page `https://v0.app/templates/<id>` embeds the whole project: a flight text row `<id>:T<hexlen>,` whose content starts with an inner `32:o<hexlen>,` header and then files separated by `[V0_FILE]<lang>:file="<path>" attrs` lines (binary assets have an empty path). `server/v0.js` extracts exactly that.
- `https://v0.app/chat/b/<blockId>/json` answers 401 (author token). It is not used and must not be worked around.
- shadcn components come from `https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`; `from "cn"` and `@/registry/...` imports are rewritten to `@/lib/utils` and `@/components/...` (`server/shadcn.js`).
- Outbound fetches go through `server/upstream.js` with an origin allowlist (v0.app, ui.shadcn.com, registry.npmjs.org, api.npmjs.org), a per-minute budget, a timeout and a size cap.

## npm packages

- A missing bare import (`Failed to resolve import "pkg"`) after an edit or import triggers `server/packages.js`: the package must exist on npm and have at least 2000 weekly downloads (`PACKAGE_MIN_WEEKLY_DOWNLOADS`), then it is installed with `--ignore-scripts`, serialized, at most 5 per call and 15 per hour, and registered with the optimizer. `AUTO_INSTALL_PACKAGES=0` disables it. Rejections are reported with a reason and the error stays.
- npm invoked against a `node_modules` junction replaces the junction with a real directory; never share `node_modules` between two projects with a junction when testing installs.

## Testing lessons

- Fault-injection runs must use their own server and browser session: the automation browser window is visible, and someone interacting with a test tab or a second Live session on the same server corrupts results.
- The verification harness is a page that never hot-reloads (`/live/`) driving a same-origin test frame; the server must be restarted on code changes and its event streams closed first.
