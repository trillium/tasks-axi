import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsStore } from "../src/backends/beads.js";
import { MarkdownStore } from "../src/backends/markdown.js";
import { resolveTasksContext } from "../src/context.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-"));
  home = mkdtempSync(join(tmpdir(), "tasks-axi-ctx-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("resolveTasksContext", () => {
  it("defaults to a MarkdownStore", () => {
    const ctx = resolveTasksContext({ cwd: dir, home, env: {} });
    expect(ctx.store).toBeInstanceOf(MarkdownStore);
    expect(ctx.config.backend).toBe("markdown");
  });

  it("resolves a BeadsStore for --backend beads", () => {
    const ctx = resolveTasksContext({ cwd: dir, home, env: {}, backend: "beads" });
    expect(ctx.store).toBeInstanceOf(BeadsStore);
    expect(ctx.config.backend).toBe("beads");
    expect(ctx.config.path).toBe(join(home, "data", "tasks", ".beads"));
  });

  it("rejects an unknown backend", () => {
    expect(() =>
      resolveTasksContext({ cwd: dir, home, env: {}, backend: "sqlite" }),
    ).toThrow(/Unsupported backend "sqlite"/);
  });
});
