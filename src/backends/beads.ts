import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AxiError, unsupported } from "../errors.js";
import type {
  Dep,
  DepType,
  Hold,
  HoldKind,
  LinkKind,
  State,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import type { PublicFollowupMutation } from "../public-followup.js";
import type { Capabilities, Store } from "../store.js";
import { readFileSafe } from "./lock.js";

/**
 * Sources tasks from a beads federation store (report follow-up: "source
 * from the task store too"). `list`/`get` shell out to the `bd` CLI and map
 * its JSON onto the tasks-axi `Task` model. `transition`/`update` write
 * through to the same store via `bd update`, respecting the state/hold
 * mapping the read side establishes (see STATE_BY_STATUS / HOLD_KIND_BY_STATUS
 * below and their inverses). `create`/`remove`/`addDep`/`removeDep`/
 * `updatePublicFollowup` are out of scope — beads issue lifecycle and
 * dependency editing stay on the `bd` CLI/agents — and throw `unsupported`.
 */

export interface BeadsRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable so tests can stub the CLI instead of spawning a real process. */
export type BeadsRunner = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => BeadsRunResult;

export interface BeadsStoreOptions {
  /** Path to the beads store directory, e.g. `~/data/tasks/.beads`. */
  storePath: string;
  run?: BeadsRunner;
}

interface BeadsDependencyEdge {
  /** `list` embeds the raw edge: the blocker id and the edge type. */
  depends_on_id?: string;
  type?: string;
  /** `show` embeds the full blocker issue instead, keyed by its own id. */
  id?: string;
  dependency_type?: string;
}

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: number;
  issue_type?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  dependencies?: BeadsDependencyEdge[];
  metadata?: Record<string, unknown>;
}

const STATE_BY_STATUS: Record<string, State> = {
  closed: "done",
  in_progress: "in_flight",
  hooked: "in_flight",
};

/**
 * `deferred`/`pinned` are beads' "frozen" category (`bd statuses`): the issue
 * is deliberately parked with no dependency edge to back it, so it must not
 * fall through to plain "queued" or it would show up in `ready` right next to
 * genuinely available work. Modeled as an active hold (task.hold) rather than
 * a state, matching how derive.ts already keeps held queued work out of
 * ready/blocked.
 */
const HOLD_KIND_BY_STATUS: Partial<Record<string, HoldKind>> = {
  deferred: "future",
  pinned: "parked",
};

/** Inverse of STATE_BY_STATUS, used by `transition` to write a Task State back. */
const STATUS_BY_STATE: Record<State, string> = {
  queued: "open",
  in_flight: "in_progress",
  done: "closed",
};

/** Inverse of HOLD_KIND_BY_STATUS, used by `update` to write a Hold back. */
const STATUS_BY_HOLD_KIND: Partial<Record<HoldKind, string>> = {
  future: "deferred",
  parked: "pinned",
};

const DEP_TYPE_BY_EDGE: Record<string, DepType> = {
  blocks: "blocked-by",
  "parent-child": "parent",
  "discovered-from": "discovered-from",
};

/** Beads has no native typed-link field; links round-trip through metadata. */
function metadataLinkKey(kind: LinkKind): string {
  return `tasks_axi_${kind}`;
}

/**
 * Beads has no native hold-reason field either; the real `--reason` text is
 * stashed here so it round-trips back into Hold.reason instead of the
 * synthetic "beads status: X" placeholder, which would otherwise never equal
 * what the caller passed to `hold --reason` and break holdCommand's
 * sameHold() idempotency check.
 */
const HOLD_REASON_METADATA_KEY = "tasks_axi_hold_reason";

function mapState(status: string): State {
  return STATE_BY_STATUS[status] ?? "queued";
}

function mapHold(
  status: string,
  metadata: Record<string, unknown> | undefined,
): Hold | undefined {
  const kind = HOLD_KIND_BY_STATUS[status];
  if (!kind) return undefined;
  const storedReason = metadata?.[HOLD_REASON_METADATA_KEY];
  const reason =
    typeof storedReason === "string" && storedReason
      ? storedReason
      : `beads status: ${status}`;
  return { reason, kind };
}

function mapLinks(metadata: Record<string, unknown> | undefined): TaskLink[] {
  if (!metadata) return [];
  const links: TaskLink[] = [];
  for (const kind of ["pr", "report", "doc"] as const) {
    const value = metadata[metadataLinkKey(kind)];
    if (typeof value === "string" && value) links.push({ kind, url: value });
  }
  return links;
}

function mapDeps(edges: BeadsDependencyEdge[] | undefined): Dep[] {
  if (!edges) return [];
  const deps: Dep[] = [];
  for (const edge of edges) {
    const blockerId = edge.depends_on_id ?? edge.id;
    const edgeType = edge.type ?? edge.dependency_type;
    if (!blockerId || !edgeType) continue;
    const type = DEP_TYPE_BY_EDGE[edgeType];
    if (!type) continue;
    deps.push({ type, id: blockerId });
  }
  return deps;
}

function toDateStamp(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const stamp = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : undefined;
}

function mapIssueToTask(raw: BeadsIssue): Task {
  const state = mapState(raw.status);
  const task: Task = {
    id: raw.id,
    title: raw.title,
    state,
    links: mapLinks(raw.metadata),
    deps: mapDeps(raw.dependencies),
    meta: { beads_status: raw.status },
  };
  if (raw.issue_type) task.kind = raw.issue_type;
  if (raw.description) task.body = raw.description;
  if (raw.priority !== undefined) task.priority = raw.priority;
  const hold = mapHold(raw.status, raw.metadata);
  if (hold) task.hold = hold;
  const created = toDateStamp(raw.created_at);
  if (created) task.created = created;
  const updated = toDateStamp(raw.updated_at);
  if (updated) task.updated = updated;
  if (state === "done") {
    const closed = toDateStamp(raw.closed_at ?? raw.updated_at);
    if (closed) task.closed = closed;
  }
  return task;
}

function defaultRunner(args: string[], env: NodeJS.ProcessEnv): BeadsRunResult {
  const result = spawnSync("bd", args, {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new AxiError(
      `Failed to run \`bd ${args.join(" ")}\`: ${result.error.message}`,
      "UNKNOWN",
      [
        "Install beads (`bd`) and ensure it is on PATH, or use --backend markdown",
      ],
    );
  }
  if (result.status === null) {
    throw new AxiError(
      `\`bd ${args.join(" ")}\` was terminated by signal ${result.signal ?? "unknown"}`,
      "UNKNOWN",
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function looksLikeNotFound(stdout: string, stderr: string): boolean {
  if (/no issue(s)? found/i.test(stderr)) return true;
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown };
    return typeof parsed.error === "string" && /no issue/i.test(parsed.error);
  } catch {
    return false;
  }
}

function beadsCliError(command: string, detail: string): AxiError {
  return new AxiError(
    `beads \`${command}\` failed: ${detail.trim() || "unknown error"}`,
    "UNKNOWN",
  );
}

function parseJsonArray(stdout: string, command: string): BeadsIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw beadsCliError(command, `could not parse JSON output: ${stdout}`);
  }
  if (!Array.isArray(parsed)) {
    throw beadsCliError(command, `expected a JSON array, got ${typeof parsed}`);
  }
  return parsed as BeadsIssue[];
}

export class BeadsStore implements Store {
  private readonly storePath: string;
  private readonly run: BeadsRunner;
  private readonly bdName: string | undefined;

  constructor(options: BeadsStoreOptions) {
    this.storePath = options.storePath;
    this.run = options.run ?? defaultRunner;
    this.bdName = this.readBdName();
  }

  private readBdName(): string | undefined {
    const src = readFileSafe(join(this.storePath, "config.yaml"));
    if (!src) return undefined;
    const match = src.match(/^BD_NAME:\s*"?([^"\n]+?)"?\s*$/m);
    return match ? match[1].trim() : undefined;
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, BEADS_DIR: this.storePath };
    if (this.bdName) env.BD_NAME = this.bdName;
    return env;
  }

  private exec(args: string[]): BeadsRunResult {
    return this.run(args, this.env());
  }

  capabilities(): Capabilities {
    return {
      backend: "beads",
      deps: true,
      prune: false,
      comments: false,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: false,
      serverMintsIds: true,
      publicFollowups: false,
    };
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    if (query.repo) throw unsupported("filtering by --repo", "beads");
    const { status, stdout, stderr } = this.exec([
      "list",
      "--all",
      "--json",
      "--limit",
      "0",
    ]);
    if (status !== 0) throw beadsCliError("list", stderr || stdout);
    let items = parseJsonArray(stdout, "list").map(mapIssueToTask);
    if (query.state) items = items.filter((t) => t.state === query.state);
    if (query.kind) items = items.filter((t) => t.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0) {
      items = items.slice(0, query.limit);
    }
    return { items, total };
  }

  async get(id: string): Promise<Task | null> {
    const { status, stdout, stderr } = this.exec(["show", id, "--json"]);
    if (status !== 0) {
      if (looksLikeNotFound(stdout, stderr)) return null;
      throw beadsCliError("show", stderr || stdout);
    }
    const raw = parseJsonArray(stdout, "show");
    return raw.length > 0 ? mapIssueToTask(raw[0]) : null;
  }

  async create(input: TaskInput): Promise<Task> {
    void input;
    throw unsupported("create", "beads");
  }

  /** Builds one `bd update <id> ...` flag list from the fields that changed. */
  private buildUpdateArgs(fields: {
    status?: string;
    title?: string;
    description?: string;
    type?: string;
    priority?: number;
    appendNotes?: string;
    defer?: string;
    setMetadata?: Record<string, string>;
  }): string[] {
    const args: string[] = [];
    if (fields.status !== undefined) args.push("--status", fields.status);
    if (fields.title !== undefined) args.push("--title", fields.title);
    if (fields.description !== undefined) {
      args.push("--description", fields.description);
    }
    if (fields.type !== undefined) args.push("--type", fields.type);
    if (fields.priority !== undefined) {
      args.push("--priority", String(fields.priority));
    }
    if (fields.appendNotes !== undefined) {
      args.push("--append-notes", fields.appendNotes);
    }
    if (fields.defer !== undefined) args.push("--defer", fields.defer);
    for (const [key, value] of Object.entries(fields.setMetadata ?? {})) {
      args.push("--set-metadata", `${key}=${value}`);
    }
    return args;
  }

  private async runUpdate(id: string, fieldArgs: string[]): Promise<void> {
    if (fieldArgs.length === 0) return;
    const { status, stdout, stderr } = this.exec(["update", id, ...fieldArgs]);
    if (status !== 0) throw beadsCliError("update", stderr || stdout);
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    if (patch.repo !== undefined) {
      throw unsupported("updating --repo (beads has no repo concept)", "beads");
    }
    const current = await this.get(id);
    if (!current) {
      throw beadsCliError("update", `issue "${id}" not found`);
    }

    const changed: TaskUpdateChange[] = [];
    const fields: Parameters<BeadsStore["buildUpdateArgs"]>[0] = {};

    if (patch.title !== undefined && patch.title !== current.title) {
      fields.title = patch.title;
      changed.push("title");
    }

    if (patch.body !== undefined) {
      if (patch.archiveBody && current.body) {
        fields.appendNotes = `archived body: ${current.body}`;
        changed.push("archive");
      }
      if (patch.body !== current.body) {
        fields.description = patch.body;
        changed.push("body");
      }
    } else if (patch.addBodyLines && patch.addBodyLines.length > 0) {
      const existingLines = (current.body ?? "").split("\n");
      const newLines = patch.addBodyLines.filter(
        (line) => !existingLines.includes(line),
      );
      if (newLines.length > 0) {
        fields.description = [current.body, ...newLines]
          .filter((line) => line !== undefined && line !== "")
          .join("\n");
        changed.push("body");
      }
    }

    if (patch.kind !== undefined && patch.kind !== current.kind) {
      fields.type = patch.kind;
      changed.push("kind");
    }

    if (patch.priority !== undefined && patch.priority !== current.priority) {
      fields.priority = patch.priority;
      changed.push("priority");
    }

    const metadataUpdates: Record<string, string> = {};

    if (patch.addLinks && patch.addLinks.length > 0) {
      for (const link of patch.addLinks) {
        metadataUpdates[metadataLinkKey(link.kind)] = link.url;
      }
      changed.push("links");
    }

    if (patch.hold === null) {
      if (current.hold) {
        fields.status = "open";
        changed.push("hold");
      }
    } else if (patch.hold) {
      const holdStatus = STATUS_BY_HOLD_KIND[patch.hold.kind ?? "future"];
      if (!holdStatus) {
        throw unsupported(
          `hold kind "${patch.hold.kind}" (beads only models future -> deferred and parked -> pinned)`,
          "beads",
        );
      }
      if (patch.hold.until && holdStatus !== "deferred") {
        throw unsupported(
          "hold --until with a kind other than future (only beads' deferred status carries a date)",
          "beads",
        );
      }
      fields.status = holdStatus;
      if (patch.hold.until) fields.defer = patch.hold.until;
      fields.appendNotes = fields.appendNotes
        ? `${fields.appendNotes}\n${patch.hold.reason}`
        : patch.hold.reason;
      metadataUpdates[HOLD_REASON_METADATA_KEY] = patch.hold.reason;
      changed.push("hold");
    }

    if (Object.keys(metadataUpdates).length > 0) {
      fields.setMetadata = metadataUpdates;
    }

    await this.runUpdate(id, this.buildUpdateArgs(fields));

    if (changed.length === 0) {
      return { task: current, changed: [] };
    }
    const task = await this.get(id);
    if (!task) {
      throw beadsCliError("update", `issue "${id}" not found after update`);
    }
    return { task, changed };
  }

  async remove(id: string): Promise<Task> {
    void id;
    throw unsupported("remove", "beads");
  }

  async transition(id: string, to: State, opts?: TransitionOpts): Promise<Task> {
    const setMetadata: Record<string, string> = {};
    if (to === "done" && opts?.pr) setMetadata[metadataLinkKey("pr")] = opts.pr;
    if (to === "done" && opts?.report) {
      setMetadata[metadataLinkKey("report")] = opts.report;
    }
    const args = this.buildUpdateArgs({
      status: STATUS_BY_STATE[to],
      ...(to === "done" && opts?.note ? { appendNotes: opts.note } : {}),
      ...(Object.keys(setMetadata).length > 0 ? { setMetadata } : {}),
    });
    await this.runUpdate(id, args);
    const task = await this.get(id);
    if (!task) {
      throw beadsCliError("update", `issue "${id}" not found after transition`);
    }
    return task;
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    void id;
    void dep;
    throw unsupported("addDep", "beads");
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    void id;
    void dep;
    throw unsupported("removeDep", "beads");
  }

  async updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    void id;
    void mutation;
    throw unsupported("updatePublicFollowup", "beads");
  }
}
