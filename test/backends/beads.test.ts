import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BeadsRunResult, BeadsRunner } from "../../src/backends/beads.js";
import { BeadsStore } from "../../src/backends/beads.js";

let storePath: string;
beforeEach(() => {
  storePath = mkdtempSync(join(tmpdir(), "tasks-axi-beads-"));
});
afterEach(() => {
  rmSync(storePath, { recursive: true, force: true });
});

function writeConfigYaml(bdName: string): void {
  writeFileSync(join(storePath, "config.yaml"), `issue-prefix: "task"\nBD_NAME: "${bdName}"\n`);
}

interface FakeCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function fakeRunner(responses: Record<string, BeadsRunResult>): {
  run: BeadsRunner;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const run: BeadsRunner = (args, env) => {
    calls.push({ args, env });
    const key = args[0];
    const response = responses[key];
    if (!response) {
      throw new Error(`no fake response registered for \`bd ${args.join(" ")}\``);
    }
    return response;
  };
  return { run, calls };
}

const LIST_FIXTURE = [
  {
    id: "task-vgd7",
    title: "Implement the thing",
    description: "Full description of the thing.",
    status: "open",
    priority: 1,
    issue_type: "task",
    created_at: "2026-07-31T08:53:49Z",
    updated_at: "2026-07-31T08:53:49Z",
    dependencies: [
      {
        issue_id: "task-vgd7",
        depends_on_id: "task-n4l9",
        type: "blocks",
        created_at: "2026-07-31T01:53:50Z",
      },
    ],
    dependency_count: 1,
    dependent_count: 0,
  },
  {
    id: "task-n4l9",
    title: "Evaluate readiness",
    status: "in_progress",
    priority: 1,
    issue_type: "task",
    created_at: "2026-07-31T08:53:48Z",
    updated_at: "2026-08-01T08:51:52Z",
  },
  {
    id: "task-done1",
    title: "Shipped work",
    status: "closed",
    priority: 2,
    issue_type: "bug",
    created_at: "2026-06-01T08:53:48Z",
    updated_at: "2026-06-05T08:51:52Z",
    closed_at: "2026-06-05T08:51:52Z",
  },
];

describe("BeadsStore", () => {
  describe("capabilities", () => {
    it("reports beads as read-only with dependency support", () => {
      writeConfigYaml("task");
      const { run } = fakeRunner({});
      const store = new BeadsStore({ storePath, run });
      expect(store.capabilities()).toEqual({
        backend: "beads",
        deps: true,
        prune: false,
        comments: false,
        fullTextSearch: false,
        realtimeSync: false,
        customStates: false,
        serverMintsIds: true,
        publicFollowups: false,
      });
    });
  });

  describe("list", () => {
    it("maps beads issues onto Task and derives blocked-by from list-shape edges", async () => {
      writeConfigYaml("task");
      const { run, calls } = fakeRunner({
        list: { status: 0, stdout: JSON.stringify(LIST_FIXTURE), stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });

      const { items, total } = await store.list({});
      expect(total).toBe(3);
      expect(calls[0].env.BEADS_DIR).toBe(storePath);
      expect(calls[0].env.BD_NAME).toBe("task");

      const open = items.find((t) => t.id === "task-vgd7");
      expect(open?.state).toBe("queued");
      expect(open?.title).toBe("Implement the thing");
      expect(open?.body).toBe("Full description of the thing.");
      expect(open?.kind).toBe("task");
      expect(open?.priority).toBe(1);
      expect(open?.created).toBe("2026-07-31");
      expect(open?.deps).toEqual([{ type: "blocked-by", id: "task-n4l9" }]);
      expect(open?.meta).toEqual({ beads_status: "open" });

      const inFlight = items.find((t) => t.id === "task-n4l9");
      expect(inFlight?.state).toBe("in_flight");

      const done = items.find((t) => t.id === "task-done1");
      expect(done?.state).toBe("done");
      expect(done?.closed).toBe("2026-06-05");
    });

    it("filters by state after mapping beads statuses", async () => {
      const { run } = fakeRunner({
        list: { status: 0, stdout: JSON.stringify(LIST_FIXTURE), stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });

      const { items, total } = await store.list({ state: "queued" });
      expect(total).toBe(1);
      expect(items.map((t) => t.id)).toEqual(["task-vgd7"]);
    });

    it("filters by kind and applies a limit", async () => {
      const { run } = fakeRunner({
        list: { status: 0, stdout: JSON.stringify(LIST_FIXTURE), stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });

      const byKind = await store.list({ kind: "bug" });
      expect(byKind.items.map((t) => t.id)).toEqual(["task-done1"]);

      const limited = await store.list({ limit: 1 });
      expect(limited.total).toBe(3);
      expect(limited.items).toHaveLength(1);
    });

    it("maps show-shape dependency edges (embedded blocker issue + dependency_type)", async () => {
      const { run } = fakeRunner({
        list: {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "task-a",
              title: "A",
              status: "open",
              dependencies: [
                { id: "task-b", dependency_type: "blocks" },
                { id: "task-c", dependency_type: "related" },
              ],
            },
          ]),
          stderr: "",
        },
      });
      const store = new BeadsStore({ storePath, run });
      const { items } = await store.list({});
      expect(items[0].deps).toEqual([{ type: "blocked-by", id: "task-b" }]);
    });

    it("throws a structured error when the CLI exits non-zero", async () => {
      const { run } = fakeRunner({
        list: { status: 1, stdout: "", stderr: "dolt server unreachable" },
      });
      const store = new BeadsStore({ storePath, run });
      await expect(store.list({})).rejects.toMatchObject({
        message: expect.stringContaining("dolt server unreachable"),
      });
    });
  });

  describe("get", () => {
    it("returns the mapped task when found", async () => {
      const { run } = fakeRunner({
        show: {
          status: 0,
          stdout: JSON.stringify([LIST_FIXTURE[0]]),
          stderr: "",
        },
      });
      const store = new BeadsStore({ storePath, run });
      const task = await store.get("task-vgd7");
      expect(task?.title).toBe("Implement the thing");
    });

    it("returns null when the CLI reports no matching issue", async () => {
      const { run } = fakeRunner({
        show: {
          status: 1,
          stdout: JSON.stringify({
            error: "no issues found matching the provided IDs",
            schema_version: 1,
          }),
          stderr: 'Error fetching task-bogus: no issue found matching "task-bogus"',
        },
      });
      const store = new BeadsStore({ storePath, run });
      expect(await store.get("task-bogus")).toBeNull();
    });

    it("throws for any other CLI failure", async () => {
      const { run } = fakeRunner({
        show: { status: 1, stdout: "", stderr: "permission denied" },
      });
      const store = new BeadsStore({ storePath, run });
      await expect(store.get("task-vgd7")).rejects.toMatchObject({
        message: expect.stringContaining("permission denied"),
      });
    });
  });

  describe("write methods", () => {
    const write = (
      method: string,
      call: (store: BeadsStore) => Promise<unknown>,
    ) =>
      it(`${method} throws UNSUPPORTED`, async () => {
        const { run } = fakeRunner({});
        const store = new BeadsStore({ storePath, run });
        await expect(call(store)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      });

    write("create", (s) => s.create({ id: "x", title: "x" }));
    write("update", (s) => s.update("x", {}));
    write("remove", (s) => s.remove("x"));
    write("transition", (s) => s.transition("x", "done"));
    write("addDep", (s) => s.addDep("x", { type: "blocked-by", id: "y" }));
    write("removeDep", (s) => s.removeDep("x", { type: "blocked-by", id: "y" }));
  });
});
