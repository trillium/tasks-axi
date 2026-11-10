import { describe, expect, it } from "vitest";
import {
  decodePublicFollowup,
  isPublicFollowupReady,
  type AcceptedWorkEvent,
  type ExpectedFinal,
  type PublicFollowup,
  type WorkRelation,
} from "../src/public-followup.js";

function acceptedEvent(
  overrides: Partial<AcceptedWorkEvent> = {},
): AcceptedWorkEvent {
  return {
    schema_version: 1,
    event_id: "evt-1",
    obligation_id: "public-final-ab",
    relation_id: "rel-code",
    generation: 1,
    source_home_id: "secondmate:demo",
    work_id: "work-code-q1",
    outcome_type: "pr-merged",
    deliverables: { pr_url: "https://github.com/o/r/pull/519" },
    public_safe_outcome: "The fix merged in PR 519.",
    occurred_at: "2026-07-14T12:00:00Z",
    ...overrides,
  };
}

function relation(overrides: Partial<WorkRelation> = {}): WorkRelation {
  const event = overrides.accepted_events?.at(-1) ?? acceptedEvent();
  return {
    relation_id: "rel-code",
    work_ref: { home_id: "secondmate:demo", task_id: "work-code-q1" },
    role: "fulfills",
    required: true,
    generation: 1,
    state: "landed",
    successor_relation_id: null,
    accepted_event_ids: [event.event_id],
    accepted_events: [event],
    ...overrides,
  };
}

function expectedFinal(overrides: Partial<ExpectedFinal> = {}): ExpectedFinal {
  return {
    type: "pr-merged",
    project: "demo",
    required_deliverables: ["pr_url"],
    completion_policy: "all-required",
    ...overrides,
  };
}

function followup(
  expected: ExpectedFinal,
  relations: WorkRelation[],
): PublicFollowup {
  return {
    schema_version: 1,
    revision: 1,
    request: {
      request_id: "req-public-demo",
      platform: "discord",
      context_binding: { version: "ctx1", value: "ctx1_opaque_demo" },
      public_safe_summary: "Follow up when the fix ships",
      received_at: "2026-07-13T12:00:00Z",
      followup_expires_at: "2026-08-13T12:00:00Z",
      reservation_expires_at: "2026-09-13T12:00:00Z",
    },
    purpose: "promised-final",
    expected_final: expected,
    obligation_expires_at: "2026-10-01T00:00:00Z",
    delivery: {
      state: "pending-work",
      delivery_key: "fd1_demo",
      payload_digest: null,
      attempt_count: 0,
      last_error_code: null,
      next_attempt_at: null,
      receipt: null,
      last_error: null,
      waiver: null,
    },
    work_relations: relations,
    lineage: {
      predecessor_obligation_id: null,
      successor_obligation_id: null,
    },
  };
}

describe("isPublicFollowupReady", () => {
  it("is ready once a required relation lands its expected outcome (unchanged baseline)", () => {
    const value = followup(expectedFinal(), [relation()]);
    expect(isPublicFollowupReady(value)).toBe(true);
  });

  it("is not ready while a required relation is only bound", () => {
    const value = followup(expectedFinal(), [
      relation({ state: "bound", accepted_event_ids: [], accepted_events: [] }),
    ]);
    expect(isPublicFollowupReady(value)).toBe(false);
  });

  it("treats a failed required relation as terminal and deliverable on a pr-merged promise (option A)", () => {
    const value = followup(expectedFinal({ type: "pr-merged" }), [
      relation({
        state: "failed",
        accepted_events: [
          acceptedEvent({
            outcome_type: "failed",
            deliverables: { error_code: "quota-exhausted" },
            public_safe_outcome: "This one did not pan out.",
          }),
        ],
        accepted_event_ids: ["evt-1"],
      }),
    ]);
    expect(isPublicFollowupReady(value)).toBe(true);
  });

  it("treats a failed required relation as terminal and deliverable on a report-ready promise", () => {
    const value = followup(
      expectedFinal({ type: "report-ready", required_deliverables: [] }),
      [
        relation({
          state: "failed",
          accepted_events: [
            acceptedEvent({
              outcome_type: "failed",
              deliverables: { error_code: "quota-exhausted" },
              public_safe_outcome: "This one did not pan out.",
            }),
          ],
          accepted_event_ids: ["evt-1"],
        }),
      ],
    );
    expect(isPublicFollowupReady(value)).toBe(true);
  });

  it("still requires a matching failed event for a failure-outcome promise (unchanged)", () => {
    const value = followup(
      expectedFinal({
        type: "failure-outcome",
        required_deliverables: ["error_code"],
      }),
      [
        relation({
          state: "failed",
          accepted_events: [
            acceptedEvent({
              outcome_type: "failed",
              deliverables: { error_code: "build-failed" },
              public_safe_outcome: "The work failed before landing.",
            }),
          ],
          accepted_event_ids: ["evt-1"],
        }),
      ],
    );
    expect(isPublicFollowupReady(value)).toBe(true);
  });

  it("is not ready when a failed relation's deliverables are unsafe for a non-failure-outcome promise", () => {
    const value = followup(expectedFinal({ type: "pr-merged" }), [
      relation({
        state: "failed",
        accepted_events: [
          acceptedEvent({
            outcome_type: "failed",
            deliverables: {
              error_code: "quota-exhausted",
              extra: "not-allowed",
            },
            public_safe_outcome: "This one did not pan out.",
          }),
        ],
        accepted_event_ids: ["evt-1"],
      }),
    ]);
    expect(isPublicFollowupReady(value)).toBe(false);
  });

  it("ignores a superseded relation and evaluates only its live successor", () => {
    const value = followup(expectedFinal({ type: "pr-merged" }), [
      relation({
        relation_id: "rel-code",
        state: "superseded",
        successor_relation_id: "rel-code-v2",
        accepted_events: [],
        accepted_event_ids: [],
      }),
      relation({
        relation_id: "rel-code-v2",
        generation: 2,
        state: "bound",
        accepted_events: [],
        accepted_event_ids: [],
      }),
    ]);
    expect(isPublicFollowupReady(value)).toBe(false);
  });
});

function persisted(value: PublicFollowup): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("decoding a record persisted before the option-A readiness rule", () => {
  it("advances a stale pending-work failed relation to ready instead of failing", () => {
    const value = followup(expectedFinal({ type: "pr-merged" }), [
      relation({
        state: "failed",
        accepted_events: [
          acceptedEvent({
            outcome_type: "failed",
            deliverables: { error_code: "quota-exhausted" },
            public_safe_outcome: "This one did not pan out.",
          }),
        ],
        accepted_event_ids: ["evt-1"],
      }),
    ]);
    expect(value.delivery.state).toBe("pending-work");

    const decoded = decodePublicFollowup(persisted(value));
    expect(decoded.delivery.state).toBe("ready");
    expect(decoded.revision).toBe(value.revision);
  });

  it("still rejects a pending-work state whose landed relation was already ready", () => {
    const value = followup(expectedFinal(), [relation()]);
    expect(value.delivery.state).toBe("pending-work");
    expect(() => decodePublicFollowup(persisted(value))).toThrow(
      /stale: work is ready/,
    );
  });

  it("still rejects a pending-work state whose failed relation matched a failure-outcome promise", () => {
    const value = followup(
      expectedFinal({
        type: "failure-outcome",
        required_deliverables: ["error_code"],
      }),
      [
        relation({
          state: "failed",
          accepted_events: [
            acceptedEvent({
              outcome_type: "failed",
              deliverables: { error_code: "build-failed" },
              public_safe_outcome: "The work failed before landing.",
            }),
          ],
          accepted_event_ids: ["evt-1"],
        }),
      ],
    );
    expect(() => decodePublicFollowup(persisted(value))).toThrow(
      /stale: work is ready/,
    );
  });

  it("still rejects a ready delivery state whose work is not ready", () => {
    const value = followup(expectedFinal(), [
      relation({ state: "bound", accepted_event_ids: [], accepted_events: [] }),
    ]);
    value.delivery.state = "ready";
    expect(() => decodePublicFollowup(persisted(value))).toThrow(
      /stale: work is not ready/,
    );
  });
});
