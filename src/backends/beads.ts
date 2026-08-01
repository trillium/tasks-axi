import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AxiError, unsupported } from "../errors.js";
import type {
  Dep,
  DepType,
  Hold,
  HoldKind,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskQuery,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import type { PublicFollowupMutation } from "../public-followup.js";
import type { Capabilities, Store } from "../store.js";
import { readFileSafe } from "./lock.js";

/**
 * Sources tasks from a beads federation store (report follow-up: "source
 * from the task store too"). Read-only: `list`/`get` shell out to the `bd`
 * CLI and map its JSON onto the tasks-axi `Task` model. Every mutating verb
 * throws `unsupported` — beads is written through its own CLI/agents, not
 * through tasks-axi.
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

const DEP_TYPE_BY_EDGE: Record<string, DepType> = {
  blocks: "blocked-by",
  "parent-child": "parent",
  "discovered-from": "discovered-from",
};

function mapState(status: string): State {
  return STATE_BY_STATUS[status] ?? "queued";
}

function mapHold(status: string): Hold | undefined {
  const kind = HOLD_KIND_BY_STATUS[status];
  return kind ? { reason: `beads status: ${status}`, kind } : undefined;
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
    links: [],
    deps: mapDeps(raw.dependencies),
    meta: { beads_status: raw.status },
  };
  if (raw.issue_type) task.kind = raw.issue_type;
  if (raw.description) task.body = raw.description;
  if (raw.priority !== undefined) task.priority = raw.priority;
  const hold = mapHold(raw.status);
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
  return {
    status: result.status ?? 0,
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

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    void id;
    void patch;
    throw unsupported("update", "beads");
  }

  async remove(id: string): Promise<Task> {
    void id;
    throw unsupported("remove", "beads");
  }

  async transition(id: string, to: State, opts?: TransitionOpts): Promise<Task> {
    void id;
    void to;
    void opts;
    throw unsupported("transition", "beads");
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
