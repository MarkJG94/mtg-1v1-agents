# ADR 0016 — Simulation workers ask the scripting worker synchronously

- Status: accepted
- Date: 2026-09-26

## Context

docs/01 puts card scripting in a worker of its own — "so that card parsing never stalls a
simulation worker" — with its results cached in `card_scripts`, and makes the API process
the only writer to SQLite. Roadmap 5.4 left `ScryfallPool.script` asynchronous so this
worker could sit behind it.

But scripting is not only reached through that one method. The seed-deck generator draws
a card and asks the resolver about it before drawing the next; the run asks for the
definition of every card in both decks before a cycle; legalisation after a ban goes
through the pool. All of them call `ScriptResolver.resolve`, which is synchronous, and all
of them are loops whose next step depends on the answer. Making the resolver asynchronous
would turn the seed deck, the pool's `definitionOf`, the run's definition lookup and
everything above them into promises — a wide change for no gain, since none of those loops
has anything else to do while it waits.

The other half of "never stalls" is about the simulation worker's *thread*, and a worker
has nothing else to run: it plays one run, and a game cannot start until its cards are
scripted. What docs/01 wants to avoid is scripting happening on a thread that serves
someone else — the API's event loop, or another run's games.

## Decision

**A simulation worker asks the scripting worker synchronously.** Its resolver is a
`ScriptClient`: `resolve` posts the card, with a one-slot `SharedArrayBuffer`, to the
scripting worker over a `MessagePort` of its own, blocks on `Atomics.wait`, and takes the
answer off the port with `receiveMessageOnPort` once the scripting worker has posted it and
notified. The resolver interface stays synchronous, so nothing above it changed.

**The scripting worker** holds the one `ScriptResolver` — hand scripts, the auto-scripter,
validation — for every run and for the API. It reads the `card_scripts` cache through a
read-only connection (SQLite refuses its writes), keeps the verdicts it reaches in memory,
and posts every verdict and unsupported request to the API process, which writes them.
The API asks it asynchronously, on a port without the shared buffer.

## Consequences

- A simulation worker blocks while a card is scripted, as it did when the resolver ran
  in-process; another run's worker is not affected, and neither is the API.
- Every run scripts through one cache, so a card scripted for one run is a cache hit for
  the next, and `card_scripts` fills from every run's demand — the coverage page's input.
- The scripting worker is a single thread serving every simulation worker in turn. With
  `SIM_WORKERS` runs all asking for cards at once — a deck change's shortlist of fifty — the
  requests queue. That is the right trade while scripting is a small share of a run's time
  (a four-cycle run on real Scryfall data spends about two seconds in all), and the thing
  to measure if it stops being.
- A request waits at most two minutes; a scripting worker that has died fails the run
  rather than hanging it, and the supervisor pauses the run (it can be started again).
- `Atomics.wait` is not allowed on a browser's main thread. The engine and sim never call
  it; only the server's worker does.
