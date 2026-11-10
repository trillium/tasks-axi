# Personal main: before -> after

```mermaid
flowchart LR
  subgraph before["before"]
    G1["global tasks-axi 0.2.6 (npm registry)"] --> MD1[(data/backlog.md)]
  end
  subgraph after["after"]
    G2["global tasks-axi from this branch (packed tarball)"] -->|"macbook-ops .tasks.toml: markdown (unchanged)"| MD2[(data/backlog.md)]
    G2 -.->|"opt-in .tasks.toml: backend = beads, bin = wrapper, prefix"| W["~/.local/bin/task wrapper"]
    W --> S[(task bead store)]
  end
  before --> after
```

| Check | Result |
| --- | --- |
| `pnpm build`, `pnpm lint` | clean |
| `REQUIRE_BD=1 pnpm test` | 501 passed, 1 skipped (bd 1.1.0-rc.1) |
| `pnpm run build:skill -- --check` | up to date |
| `tasks-axi list` in macbook-ops, markdown backend | 39 items, output identical before and after the install |
| Wrapper-style beads config on a temp store | add, list, update, start, ready, done, show, mirror, prefix guard all pass |
| Live task/brain stores | not touched |
