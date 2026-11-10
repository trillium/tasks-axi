# Personal setup: beads backend on the brain stores

This is the personal adaptation for a home whose beads stores are exposed as wrapper commands (`task`, `brain`, ...) in `~/.local/bin/`. It is configuration only; the backend code is unchanged.
The live backlog stays on the markdown backend until you decide to switch it (see the end).

## How the stores are shaped

Each store wrapper (for example `/Users/trilliumsmith/.local/bin/task`) is a `sh` script that exports `BEADS_DIR=$HOME/data/tasks/.beads` (plus the shared Dolt server variables) and then runs `exec bd "$@"`.
The store data lives on the shared Dolt server; `~/data/tasks/.beads` holds only config. Issue ids carry the store prefix, for example `task-2nwlw`.

The beads backend accepts any executable that speaks bd's CLI as `bin`. With a wrapper and no `dir`, tasks-axi sets no `cwd` or `BEADS_DIR` and the wrapper picks the store.

## `.tasks.toml` snippets

Point tasks-axi at the task store through its wrapper:

```toml
backend = "beads"

[beads]
bin = "/Users/trilliumsmith/.local/bin/task"
prefix = "task"
```

Add a read-only markdown mirror so tools that read a `backlog.md` keep working. The mirror is rewritten after every mutation and hand-edits are overwritten:

```toml
backend = "beads"

[beads]
bin = "/Users/trilliumsmith/.local/bin/task"
prefix = "task"
lock_timeout_ms = 30000

[markdown]
path = "data/backlog.md"
archive = "data/done-archive.md"
```

Notes:

- `prefix` makes tasks-axi reject an id that does not start with `task-` up front, instead of forcing it past bd.
- Leave `dir` unset when using a wrapper. Setting `dir = "/Users/trilliumsmith/data/tasks"` with `bin = "bd"` bypasses the wrapper's server variables and is not the brain-style route.
- Another store works the same way by swapping the wrapper and prefix (for example `bin = "/Users/trilliumsmith/.local/bin/brain"`, `prefix = "brain"`).
- `.tasks.toml` is read from the working directory, so the config above only affects commands run there. `--backend` and `--file` override it per invocation.

## Verified

Run against a throwaway store in a temp directory outside any git repo, through a wrapper with the same shape as `task` but pinned to the temp store (the real wrapper pins the live store, so it was not used):

- `add` (with `--kind`, `--repo`, `--blocked-by`), `list`, `update --title`, `start`, `ready`, `done --pr`, `show` all succeed. `blocked` and `ready` follow the dependency graph, and finishing the blocker unblocks the dependent.
- The mirror is written with the canonical markdown layout, and `bd list` shows the same issues.
- An issue created directly with `bd create -p 1 -t bug` appears in `tasks-axi list` as a queued `bug`.
- An id outside the configured prefix fails with `VALIDATION_ERROR` naming the prefix.
- The markdown backend is unaffected: `tasks-axi list` in the macbook-ops home returned identical output before and after the install.

Not verified: any run against the live `task` or `brain` stores, and latency against the shared Dolt server. Each tasks-axi mutation spawns several `bd` processes, and the embedded-store tests take roughly 2 to 4 seconds per mutation.

## Switching a live backlog (not done)

Switching `data/backlog.md` to beads is a deliberate migration, not a config flip. It needs:

1. **A decision on which store.** Pointing at the `task` store makes every existing `task-*` issue show up in `tasks-axi list` and the dashboard (native beads read as queued tasks, with bd's priority and type). A dedicated backlog store avoids mixing the two.
2. **An id mapping.** Backlog ids are free-form slugs such as `tasks-axi-beads-build-20261110`. With `prefix = "task"` they are rejected. Without a prefix, ids are forced into a store whose prefix differs, and bd's own `ready` then mis-reads blockers (tasks-axi derives `ready` itself, so it stays correct). Either re-id the items or use a store whose prefix fits. Status files, briefs and branches that refer to backlog ids would need the same mapping.
3. **A one-off importer.** There is none. The 39 current items (state, kind, repo, holds, dependencies with reasons, bodies, dates) would be replayed through `tasks-axi add` / `block` / `hold` / `done` against the beads store. Not written.
4. **No public-followup or multi-id `mv`.** The beads backend does not support either. Anything that calls `tasks-axi public-followup` or `mv <id>... --to` on the backlog stops working after the switch.
5. **The mirror as the only `backlog.md` writer.** Set `[markdown] path` so readers keep a file, and route every writer through tasks-axi. Direct edits to the mirror are lost on the next mutation.
6. **Lock discipline.** tasks-axi mutations queue on a lock, but raw `bd` writers bypass it, and `bd create --id <id> --force` overwrites an existing issue silently.
