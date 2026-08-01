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

/**
 * Responses are keyed by the first CLI arg (`list`/`show`/`update`). A single
 * response is replayed for every call; an array is consumed in order, letting
 * a test model a `show` result changing across an update's before/after reads.
 */
function fakeRunner(
  responses: Record<string, BeadsRunResult | BeadsRunResult[]>,
): {
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
    if (!Array.isArray(response)) return response;
    const next = response.shift();
    if (!next) {
      throw new Error(`fake responses for \`bd ${key}\` exhausted`);
    }
    return next;
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

    it("maps deferred/pinned statuses to queued plus an active hold, not plain queued", async () => {
      const { run } = fakeRunner({
        list: {
          status: 0,
          stdout: JSON.stringify([
            { id: "task-deferred", title: "Deferred", status: "deferred" },
            { id: "task-pinned", title: "Pinned", status: "pinned" },
            { id: "task-open", title: "Open", status: "open" },
          ]),
          stderr: "",
        },
      });
      const store = new BeadsStore({ storePath, run });
      const { items } = await store.list({});

      const deferred = items.find((t) => t.id === "task-deferred");
      expect(deferred?.state).toBe("queued");
      expect(deferred?.hold).toEqual({
        reason: "beads status: deferred",
        kind: "future",
      });

      const pinned = items.find((t) => t.id === "task-pinned");
      expect(pinned?.state).toBe("queued");
      expect(pinned?.hold).toEqual({
        reason: "beads status: pinned",
        kind: "parked",
      });

      const open = items.find((t) => t.id === "task-open");
      expect(open?.hold).toBeUndefined();
    });

    it("throws UNSUPPORTED when filtering by --repo (beads has no repo concept)", async () => {
      const { run } = fakeRunner({
        list: { status: 0, stdout: JSON.stringify(LIST_FIXTURE), stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      await expect(store.list({ repo: "acme" })).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
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

  describe("still-unsupported write methods", () => {
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
    write("remove", (s) => s.remove("x"));
    write("addDep", (s) => s.addDep("x", { type: "blocked-by", id: "y" }));
    write("removeDep", (s) => s.removeDep("x", { type: "blocked-by", id: "y" }));
  });

  describe("transition", () => {
    function issue(overrides: Partial<(typeof LIST_FIXTURE)[0]>) {
      return { ...LIST_FIXTURE[0], ...overrides };
    }

    it("start: writes --status in_progress and returns the re-read task", async () => {
      const { run, calls } = fakeRunner({
        update: { status: 0, stdout: "", stderr: "" },
        show: {
          status: 0,
          stdout: JSON.stringify([issue({ status: "in_progress" })]),
          stderr: "",
        },
      });
      const store = new BeadsStore({ storePath, run });
      const task = await store.transition("task-vgd7", "in_flight");

      expect(task.state).toBe("in_flight");
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual([
        "update",
        "task-vgd7",
        "--status",
        "in_progress",
      ]);
    });

    it("done: writes --status closed plus note/pr/report and round-trips links via metadata", async () => {
      const { run, calls } = fakeRunner({
        update: { status: 0, stdout: "", stderr: "" },
        show: {
          status: 0,
          stdout: JSON.stringify([
            issue({
              status: "closed",
              closed_at: "2026-08-01T00:00:00Z",
              metadata: {
                tasks_axi_pr: "https://github.com/o/r/pull/1",
                tasks_axi_report: "data/x/report.md",
              },
            }),
          ]),
          stderr: "",
        },
      });
      const store = new BeadsStore({ storePath, run });
      const task = await store.transition("task-vgd7", "done", {
        pr: "https://github.com/o/r/pull/1",
        report: "data/x/report.md",
        note: "shipped",
      });

      expect(task.state).toBe("done");
      expect(task.closed).toBe("2026-08-01");
      expect(task.links).toEqual(
        expect.arrayContaining([
          { kind: "pr", url: "https://github.com/o/r/pull/1" },
          { kind: "report", url: "data/x/report.md" },
        ]),
      );
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual([
        "update",
        "task-vgd7",
        "--status",
        "closed",
        "--append-notes",
        "shipped",
        "--set-metadata",
        "tasks_axi_pr=https://github.com/o/r/pull/1",
        "--set-metadata",
        "tasks_axi_report=data/x/report.md",
      ]);
    });

    it("reopen: writes --status open", async () => {
      const { run, calls } = fakeRunner({
        update: { status: 0, stdout: "", stderr: "" },
        show: {
          status: 0,
          stdout: JSON.stringify([issue({ status: "open" })]),
          stderr: "",
        },
      });
      const store = new BeadsStore({ storePath, run });
      await store.transition("task-vgd7", "queued");
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual(["update", "task-vgd7", "--status", "open"]);
    });

    it("throws a structured error when the update CLI call fails", async () => {
      const { run } = fakeRunner({
        update: { status: 1, stdout: "", stderr: "dolt write conflict" },
      });
      const store = new BeadsStore({ storePath, run });
      await expect(store.transition("task-vgd7", "done")).rejects.toMatchObject({
        message: expect.stringContaining("dolt write conflict"),
      });
    });
  });

  describe("update", () => {
    function issue(overrides: Partial<(typeof LIST_FIXTURE)[0]>) {
      return { ...LIST_FIXTURE[0], ...overrides };
    }

    it("title: writes --title and reports the changed field", async () => {
      const { run, calls } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          {
            status: 0,
            stdout: JSON.stringify([issue({ title: "New title" })]),
            stderr: "",
          },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", { title: "New title" });

      expect(result.changed).toEqual(["title"]);
      expect(result.task.title).toBe("New title");
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual([
        "update",
        "task-vgd7",
        "--title",
        "New title",
      ]);
    });

    it("body: writes --description; archiveBody also appends the old body to notes", async () => {
      const { run, calls } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          {
            status: 0,
            stdout: JSON.stringify([issue({ description: "New body" })]),
            stderr: "",
          },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", {
        body: "New body",
        archiveBody: true,
      });

      expect(result.changed).toEqual(expect.arrayContaining(["archive", "body"]));
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual([
        "update",
        "task-vgd7",
        "--description",
        "New body",
        "--append-notes",
        "archived body: Full description of the thing.",
      ]);
    });

    it("addBodyLines: appends only lines not already present", async () => {
      const { run, calls } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      await store.update("task-vgd7", {
        addBodyLines: ["Full description of the thing.", "A new line"],
      });
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual([
        "update",
        "task-vgd7",
        "--description",
        "Full description of the thing.\nA new line",
      ]);
    });

    it("kind and priority: writes --type and --priority", async () => {
      const { run, calls } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          {
            status: 0,
            stdout: JSON.stringify([
              issue({ issue_type: "bug", priority: 3 }),
            ]),
            stderr: "",
          },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", { kind: "bug", priority: 3 });

      expect(result.changed).toEqual(expect.arrayContaining(["kind", "priority"]));
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual(
        expect.arrayContaining(["--type", "bug", "--priority", "3"]),
      );
    });

    it("addLinks: writes pr/report links as metadata and round-trips them on read", async () => {
      const { run } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          {
            status: 0,
            stdout: JSON.stringify([
              issue({
                metadata: { tasks_axi_pr: "https://github.com/o/r/pull/9" },
              }),
            ]),
            stderr: "",
          },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", {
        addLinks: [{ kind: "pr", url: "https://github.com/o/r/pull/9" }],
      });

      expect(result.changed).toEqual(["links"]);
      expect(result.task.links).toEqual([
        { kind: "pr", url: "https://github.com/o/r/pull/9" },
      ]);
    });

    it("hold kind=future: writes deferred status, --defer, and the reason as notes", async () => {
      const { run, calls } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          {
            status: 0,
            stdout: JSON.stringify([issue({ status: "deferred" })]),
            stderr: "",
          },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", {
        hold: { reason: "waiting on API access", kind: "future", until: "2026-09-01" },
      });

      expect(result.changed).toEqual(["hold"]);
      expect(result.task.hold?.kind).toBe("future");
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual([
        "update",
        "task-vgd7",
        "--status",
        "deferred",
        "--append-notes",
        "waiting on API access",
        "--defer",
        "2026-09-01",
      ]);
    });

    it("hold kind=parked: writes pinned status", async () => {
      const { run, calls } = fakeRunner({
        show: [
          { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
          {
            status: 0,
            stdout: JSON.stringify([issue({ status: "pinned" })]),
            stderr: "",
          },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", {
        hold: { reason: "persistent", kind: "parked" },
      });

      expect(result.task.hold?.kind).toBe("parked");
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toContain("pinned");
    });

    it("hold kind=captain: throws UNSUPPORTED (beads has no captain-hold status)", async () => {
      const { run } = fakeRunner({
        show: { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      await expect(
        store.update("task-vgd7", {
          hold: { reason: "captain review", kind: "captain" },
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    });

    it("clearing a hold (hold: null) writes --status open", async () => {
      const { run, calls } = fakeRunner({
        show: [
          {
            status: 0,
            stdout: JSON.stringify([issue({ status: "deferred" })]),
            stderr: "",
          },
          { status: 0, stdout: JSON.stringify([issue({ status: "open" })]), stderr: "" },
        ],
        update: { status: 0, stdout: "", stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", { hold: null });

      expect(result.changed).toEqual(["hold"]);
      expect(result.task.hold).toBeUndefined();
      const updateCall = calls.find((c) => c.args[0] === "update");
      expect(updateCall?.args).toEqual(["update", "task-vgd7", "--status", "open"]);
    });

    it("no-op patch (nothing changed) skips the CLI update call", async () => {
      const { run, calls } = fakeRunner({
        show: { status: 0, stdout: JSON.stringify([issue({})]), stderr: "" },
      });
      const store = new BeadsStore({ storePath, run });
      const result = await store.update("task-vgd7", { title: issue({}).title });

      expect(result.changed).toEqual([]);
      expect(calls.some((c) => c.args[0] === "update")).toBe(false);
    });

    it("throws UNSUPPORTED for --repo (beads has no repo concept)", async () => {
      const { run } = fakeRunner({});
      const store = new BeadsStore({ storePath, run });
      await expect(
        store.update("task-vgd7", { repo: "acme" }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    });
  });
});
