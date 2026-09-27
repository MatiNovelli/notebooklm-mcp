# Usage Guide

> Commands below assume the global `notebooklm-mcp` command from `npm link` (see the [README](../README.md#install)). Without it, use `node /absolute/path/to/dist/index.js`. Do not use `npx notebooklm-mcp@latest`: that is the archived upstream release, which fails on `notebook.google.com`.

Practical end-to-end walkthroughs against v2.0.0. Each section is a self-contained recipe with the exact tool calls / curl commands.

- [First-time setup](#first-time-setup)
- [Multi-turn session pattern](#multi-turn-session-pattern)
- [Citations workflow](#citations-workflow)
- [Audio Overview generation + download](#audio-overview-generation--download)
- [Multi-account switching](#multi-account-switching)
- [HTTP transport for n8n / Zapier](#http-transport-for-n8n--zapier)

---

## First-time setup

### 1. Install and start

```bash
git clone https://github.com/MatiNovelli/notebooklm-mcp
cd notebooklm-mcp
npm install && npm link
notebooklm-mcp
```

Wire it into your MCP client of choice (see the [README](../README.md#connect-to-claude-code)).

### 2. Authenticate

Call `setup_auth`. A Chrome window opens. Log in to the Google account that has access to the notebooks you want to query. The call returns once the login completes (up to 10 minutes). Don't call it again while you're logging in: each call wipes the stored auth.

```json
{ "name": "setup_auth", "arguments": {} }
```

Verify:

```json
{ "name": "get_health", "arguments": {} }
```

Expect `"authenticated": true`.

### 3. Add a notebook to the local library

Open the notebook at `notebook.google.com` and copy the URL from the address bar (`https://notebook.google.com/notebook/<id>`). The logged-in account only needs access to the notebook, so there's nothing to share for your own notebooks. Legacy `notebooklm.google.com` URLs are still accepted. Then:

```json
{
  "name": "add_notebook",
  "arguments": {
    "url": "https://notebook.google.com/notebook/abcd-efgh",
    "name": "n8n Documentation",
    "description": "n8n core docs + builtin nodes",
    "topics": ["workflow automation", "n8n", "node configuration"],
    "use_cases": ["building n8n workflows", "debugging n8n executions"],
    "tags": ["docs", "n8n"]
  }
}
```

### 4. Ask the first question

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "What is the recommended retry pattern for the HTTP Request node?"
  }
}
```

Capture `session_id` from the response — you will reuse it for follow-ups.

---

## Multi-turn session pattern

Reusing `session_id` keeps NotebookLM's conversational context. The browser session also stays open, so each follow-up is faster.

```json
// 1. Open broad — captures session_id
{ "name": "ask_question", "arguments": {
  "question": "Give me an overview of the n8n error handling architecture."
}}
// → response.session_id = "ses_abc123"

// 2. Drill in
{ "name": "ask_question", "arguments": {
  "question": "What's the recommended retry/backoff pattern for HTTP nodes?",
  "session_id": "ses_abc123"
}}

// 3. Edge cases
{ "name": "ask_question", "arguments": {
  "question": "Common pitfalls when retrying webhook-triggered workflows?",
  "session_id": "ses_abc123"
}}

// 4. Production sample
{ "name": "ask_question", "arguments": {
  "question": "Show me a production example combining retry + circuit-breaker.",
  "session_id": "ses_abc123"
}}
```

When the task changes, either:

- Reset the same session: `{ "name": "reset_session", "arguments": { "session_id": "ses_abc123" } }`
- Close it: `{ "name": "close_session", "arguments": { "session_id": "ses_abc123" } }` — and start a new one with no `session_id`.

Sessions auto-expire after `SESSION_TIMEOUT` seconds of inactivity (default `900` = 15 min).

---

## Citations workflow

Set `source_format` on `ask_question`. Four modes:

### `none` (default)

Raw answer. No `sources` field.

### `inline`

```json
{ "name": "ask_question", "arguments": {
  "question": "How does refresh-token rotation work?",
  "source_format": "inline"
}}
```

`[1]` markers in the answer text get replaced with `(source name — short excerpt)` inline.

### `footnotes`

```json
{ "name": "ask_question", "arguments": {
  "question": "How does refresh-token rotation work?",
  "source_format": "footnotes"
}}
```

Response (abridged):

```jsonc
{
  "answer": "[AI-GENERATED ...] Refresh tokens are rotated on every refresh request [1]. The previous token is revoked server-side [2].\n\nSources:\n[1] auth-spec.pdf — \"Refresh tokens MUST be rotated…\"\n[2] auth-spec.pdf — \"On rotation, the previous token MUST be invalidated…\"",
  "sources": [
    { "index": 1, "title": "auth-spec.pdf", "excerpt": "Refresh tokens MUST be rotated…" },
    { "index": 2, "title": "auth-spec.pdf", "excerpt": "On rotation, the previous token MUST be invalidated…" }
  ],
  "source_format": "footnotes"
}
```

### `json`

Answer text is left untouched. Citations are returned only as a structured array on `sources`. Use this when you want to render citations yourself.

---

## Audio Overview generation + download

Three-step workflow: start, poll, download.

### 1. Start generation

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration steps and breaking changes"
  }
}
```

The call returns right away with `status: "started"`. You get `"in_progress"` if a generation was already running, and `"ready"` with `alreadyExisted: true` if the notebook already has an Audio Overview. Generation typically takes 2–10 minutes.

For the old blocking behaviour, pass `"wait_for_completion": true`. The call then waits up to `timeout_ms` (default 600 000 ms).

### 2. Poll

```json
{ "name": "get_audio_status", "arguments": {} }
```

Repeat every ~30 s until `status` is `"ready"`. The other values are `"in_progress"` and `"not_started"`.

### 3. Download

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "/Users/me/Downloads/notebooklm"
  }
}
```

The result includes the absolute `filePath` of the saved `.m4a` file.

If you call `download_audio` before any Audio Overview has been generated, the call returns an error pointing at `generate_audio`. Run them in order, in the same notebook.

---

## Multi-account switching

Run two parallel installations against different Google accounts:

```bash
# Terminal A: work account
notebooklm-mcp --account work

# Terminal B: personal account
notebooklm-mcp --account personal
```

Each account gets its own Chrome profile under `<dataDir>/accounts/<name>/`. The first run for a new account requires its own `setup_auth`. Switching is just a matter of starting the server with a different `--account` flag (or `NOTEBOOKLM_ACCOUNT` env).

Use cases:

- Working notebooks on a corporate Google account, side-projects on a personal one.
- Rotating between two free-tier accounts to extend the usage limit (it resets every 5 hours).

There is no shared library between accounts — each account has its own `library.json`. If you want the same library across accounts, copy `library.json` between the two `accounts/<name>/` directories manually.

---

## HTTP transport for n8n / Zapier

Start the server in HTTP mode:

```bash
notebooklm-mcp --transport http --port 3000 --host 0.0.0.0
```

The two operations:

| Method | Path |
|---|---|
| `POST` | `/mcp` |
| `GET` | `/healthz` |

### 1. Initialize a session

```bash
curl -i -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0.1" }
    }
  }'
```

Capture the `Mcp-Session-Id` response header. Pass it as a request header on every subsequent call.

### 2. Ask a question

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Mcp-Session-Id: <session-id-from-step-1>' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "ask_question",
      "arguments": {
        "question": "What is the n8n Code node best for?",
        "source_format": "footnotes"
      }
    }
  }'
```

The response is the standard MCP `tools/call` envelope. The actual tool output lives under `result.content[0].text` as a JSON string.

### Liveness probe

```bash
curl http://localhost:3000/healthz
# {"status":"ok","protocol":"mcp-streamable-http"}
```

### Notes

- The default bind address is `127.0.0.1`. Bind to `0.0.0.0` only on a trusted network.
- Sessions are kept in process memory; restarting the server invalidates all sessions.
- For n8n, Zapier, and similar HTTP-only callers, an "HTTP Request" node configured with a per-execution session-id store is enough — initialize once at workflow start, reuse the session for the rest of the run, and let the `DELETE /mcp` route close it cleanly at the end.
