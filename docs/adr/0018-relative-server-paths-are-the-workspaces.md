# ADR 0018 — The server's relative paths are the workspace's

- Status: accepted
- Date: 2026-09-26

## Context

docs/01 "Deployment" gave `DATA_DIR` (default `data`) and `CARD_SCRIPTS_DIR` (default
`packages/cards/scripts`) relative to "where the server runs". In the Docker image that is
`/app`, where the image puts the scripts, and `DATA_DIR` is set absolutely. But
`pnpm dev` runs the server with `apps/server` as its working directory, so both defaults
pointed inside `apps/server`: the Scryfall data `pnpm fetch:scryfall` writes to the root's
`data/` was not found, and the scripting worker died loading scripts from a directory that
did not exist.

The second was worse than it sounds. Nothing noticed the scripting worker had died, so
every script request — rolling a seed deck, resolving a pasted card — waited out its
120-second timeout and failed with a message about a card, not about the worker. It was
found at roadmap 6.3, driving the new web app against the real server in a browser; every
test before then gave the supervisor an absolute scripts path.

## Decision

**A relative `DATA_DIR`, `CARD_SCRIPTS_DIR` or `WEB_DIST` is taken from the pnpm workspace
the server runs in** — the nearest directory above the working directory holding
`pnpm-workspace.yaml` — **and from the working directory when there is none**, which is
the image's case (`/app` holds no workspace file), so the image is unchanged. An absolute
path is used as given.

And the failure it hid is made loud: the supervisor refuses to start without the scripts
directory, and once the scripting worker stops — an error or an exit — everything waiting
on it and everything asking after fails at once with `ScriptingStoppedError`, which the API
answers `503 scripting_unavailable`.

## Consequences

- `pnpm dev`, and a server started anywhere in the repository, finds the repository's data
  and scripts with no environment set.
- A relative `WEB_DIST` names a directory under the repository root, e.g.
  `apps/web/dist`, wherever in the repository the server was started.
- A scripting worker that stops is not restarted; the server says why and has to be
  restarted. Restarting it would mean reconnecting every simulation worker's synchronous
  port to the new one, for a failure that so far has only ever meant misconfiguration.
