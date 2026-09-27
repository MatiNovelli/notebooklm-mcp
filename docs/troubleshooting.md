# Troubleshooting

> Commands below assume the global `notebooklm-mcp` command from `npm link` (see the [README](../README.md#install)). Without it, use `node /absolute/path/to/dist/index.js`. Do not use `npx notebooklm-mcp@latest`: that is the archived upstream release, which fails on `notebook.google.com`.

A symptom → fix matrix for v2.0.0. For the full env-var inventory, see [`configuration.md`](./configuration.md).

## Chrome fails to launch (macOS Tahoe / Windows exit 21)

Symptom: `Failed to launch chrome`, `chrome exited immediately`, `code 21`, `executable doesn't exist`.

Cause: System Chrome on macOS 26 (Tahoe) and certain Windows 11 setups crashes on the persistent profile launch.

Fix: Force the bundled Patchright Chromium.

```bash
BROWSER_CHANNEL=chromium notebooklm-mcp
# or
NOTEBOOKLM_BROWSER_CHANNEL=chromium notebooklm-mcp
```

The fallback is also auto-applied when launch errors match the known patterns, but setting the env var explicitly makes the choice deterministic.

## `ask_question` times out

Symptom: The tool fails after roughly 10 min with a timeout error.

Checks:

1. Confirm the answer wait is sufficient — long-form prompts on notebooks with many sources legitimately exceed 2 min.
   ```bash
   ANSWER_TIMEOUT_MS=900000 notebooklm-mcp   # 15 minutes
   ```
   Or per-call: `browser_options.timeout_ms`.
2. Run with a visible browser to see what NotebookLM is doing:
   ```json
   { "name": "ask_question", "arguments": { "question": "...", "show_browser": true } }
   ```
   Or start the server with `HEADLESS=false`.
3. Check `get_health` — if `authenticated=false`, the page is on the login screen, not the notebook.

## Session expired / repeated login prompts

Symptom: NotebookLM keeps redirecting to the login screen, or `get_health` reports `authenticated=false` after a previously successful login.

Workflow:

1. Close every Chrome / Chromium instance the user has open. An open Chrome can hold the persistent profile lock.
2. `re_auth` to wipe stored auth and prompt for a fresh login.
3. If `re_auth` fails repeatedly, run `cleanup_data` with the library preserved:
   ```json
   { "name": "cleanup_data", "arguments": { "confirm": false, "preserve_library": true } }
   ```
   Review the preview, then run again with `confirm: true`. Then `setup_auth`.

## WSL1

Symptom: Chrome refuses to launch under WSL1.

Fix: Upgrade to WSL2.

```powershell
wsl --set-default-version 2
wsl --set-version <distro> 2
```

WSL2 with WSLg (Windows 11 / Windows 10 22H2+) supports a real Chromium and works out of the box.

## Headless Linux server

Symptom: `setup_auth` fails on a server with no display because the login window cannot open.

Fix: Run the one-time setup under `xvfb-run`. After login the persistent Chrome profile lets every subsequent run go fully headless.

```bash
xvfb-run -a notebooklm-mcp
# call setup_auth from your client, complete login, then exit
# from then on, run normally:
notebooklm-mcp
```

## "Unknown resource: mcp://notebooklm"

Cause: A client used the wrong URI scheme.

Fix: The scheme is `notebooklm://`, not `mcp://`. Supported URIs:

- `notebooklm://library`
- `notebooklm://library/{id}`
- `notebooklm://metadata` (deprecated)

The error message in v2 lists the correct set.

## Orphan Chrome processes

Symptom: Chrome processes survive after the MCP server exits.

v2 ships a 5-second shutdown watchdog and an aggressive teardown path, so this is rare. If it does happen:

1. Kill the lingering Chromes manually.
2. Run `cleanup_data` with `preserve_library: true` to remove stale profile locks.
3. Restart the server.

## Profile lock / `ProcessSingleton` errors

Cause: Another Chrome owns the base profile.

Fix: The default `NOTEBOOK_PROFILE_STRATEGY=auto` falls back to an isolated per-instance profile. To force isolation always:

```bash
NOTEBOOK_PROFILE_STRATEGY=isolated notebooklm-mcp
```

## Rate limit reached

Symptom: `NotebookLM rate limit reached (50 queries/day for free accounts)`.

The message is outdated: Gemini Notebook now resets usage limits every 5 hours, not daily.

Options:

- Use `re_auth` to switch to a different Google account.
- Use multi-account mode for a clean separation:
  ```bash
  NOTEBOOKLM_ACCOUNT=backup notebooklm-mcp
  ```
- Wait for the limit to reset (every 5 hours).
- Upgrade to Google AI Pro/Ultra for higher limits.

## Stealth typing too slow

The default `160–240 WPM` range is realistic but slow for batch use. Either disable stealth typing or tighten the range:

```bash
STEALTH_HUMAN_TYPING=false notebooklm-mcp
# or
TYPING_WPM_MIN=400 TYPING_WPM_MAX=600 notebooklm-mcp
```

## Citations are empty for `source_format=footnotes`

The DOM citation panel is read after the answer settles. If it is empty:

- The notebook may not have grounded sources for that question.
- The UI may have shifted — check the active selectors in `src/notebooklm/selectors.ts`.
- Run with `show_browser=true` and inspect the live page after the answer renders.

## Follow-up reminder is missing

In v2 the follow-up reminder appended to `ask_question` answers is off by default. Re-enable with:

```bash
NOTEBOOKLM_FOLLOW_UP_REMINDER=true notebooklm-mcp
```

## AI marker breaks downstream parsing

The default answer text starts with `[AI-GENERATED via Gemini 2.5 (NotebookLM) — …]`. To return to the unprefixed answer, set:

```bash
NOTEBOOKLM_AI_MARKER=false notebooklm-mcp
```

Or replace the prefix with your own:

```bash
NOTEBOOKLM_AI_MARKER_PREFIX="[notebooklm]" notebooklm-mcp
```

The `_provenance` envelope on the result remains regardless.

## HTTP transport: `unknown session`

Cause: The client made a `GET /mcp` or `POST /mcp` (non-initialize) without echoing the `Mcp-Session-Id` returned by the initial `initialize` response.

Fix: Capture the `Mcp-Session-Id` response header from the initialize call and pass it on every subsequent request. The lifecycle is owned by the MCP SDK's `StreamableHTTPServerTransport`.

## Wrong server version (`npx notebooklm-mcp@latest`)

Symptom: login never completes, or every tool fails, on `notebook.google.com`.

Cause: `npx notebooklm-mcp@latest` downloads the archived upstream package, which predates the Gemini Notebook rebrand.

Fix: Install this fork from source with `npm link` (see the [README](../README.md#install)) and point your MCP client at `notebooklm-mcp` or `node /absolute/path/to/dist/index.js`.

## `setup_auth` hangs

`setup_auth` blocks until the login completes, up to 10 minutes, even though its tool description says it returns immediately. Finish the login in the window it opened. Don't call it again in the meantime: each call wipes the stored auth before opening a new window.

## `get_health` reports `authenticated: false` after a day

`get_health` treats `browser_state/state.json` as expired once the file is older than 24 h, whether or not the cookies are still valid. Call `ask_question`: if it works, the session is still valid and you can ignore the flag. Otherwise run `re_auth`.

## Two server processes on one profile

Only one process can use a Chrome profile at a time, and the error when two collide is not explicit. This happens, for example, when two MCP clients each start their own server. Give each process its own `--account`, or run a single HTTP server that all clients share.
