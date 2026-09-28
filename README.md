# Gemini Live over HMR

A browser tab that streams your screen and microphone to a Gemini Live model. Gemini can find v0 templates, import them, read and edit files in `app/`, and Vite hot-reloads the result. It sees every build and runtime error caused by its edits, installs missing packages after a safety check, and can undo its own changes.

## Run

1. Put your key in `.env`: `GOOGLE_API_KEY=...` (`GEMINI_API_KEY` also works). The key stays on the server; the browser only receives a short-lived, single-use token whose model, tools and system instruction are locked.
2. `npm install` then `npm run dev`.
3. Open `http://localhost:5173/live/`. Click **Start** and accept the share prompt so Gemini can see the app frame and the controls.
4. Talk, or type in the message box. **Open app in its own tab** gives a standalone copy.

The server listens on `127.0.0.1` only.

## What is where

| Path | Purpose |
| --- | --- |
| `app/` | A v0 project root: React 19, TypeScript, Tailwind, shadcn/ui. A v0 export unzipped into it runs unchanged. This is the only directory Gemini can write. |
| `live/` | The control page. It never hot-reloads, so a session survives server restarts. |
| `server/` | Vite plugin: token minting, file tools, template traversal, package installs, error pipeline, status stream. |

## Controls

- **Refresh page** forces a full reload of the app page only.
- **Pause edits** makes every editing tool return `edits_paused`.
- **Restore last good** puts `app/` back to the last state that ran without errors.
- **Rebuild frame** recreates the app frame. This also happens automatically when the app hangs or the dev server restarts.

## Tools Gemini has

- Files: `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`.
- Feedback: `read_app_log`, `refresh_page`, `restore_last_good`. Every editing tool returns the real outcome (`hmr`, `status`, `errors` with file, line and code frame) and a `screen` field saying whether Gemini can see the app.
- Templates: `v0_categories`, `v0_search`, `v0_template`, `v0_read_file`, `v0_import`, `add_ui_component`. Search reads v0.app's public gallery, inspect lists a template's files and packages, import copies it (with the shadcn components it needs).
- Packages: `install_packages`. Missing imports are also installed automatically after vetting (exists on npm, real adoption, no install scripts).

## Configuration

`.env.example` lists the optional variables: `GEMINI_LIVE_MODEL`, `EPHEMERAL_API_VERSION`, `AUTO_INSTALL_PACKAGES` (set to `0` to turn off automatic installs) and `PACKAGE_MIN_WEEKLY_DOWNLOADS`.
