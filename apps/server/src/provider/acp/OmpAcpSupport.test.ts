import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyOmpAcpModelSelection,
  buildOmpAcpSpawnInput,
  ompAutoApprovedPermissionOptionId,
  ompElicitationContentFromAnswers,
  ompElicitationQuestions,
  ompPermissionOptionIdForDecision,
} from "./OmpAcpSupport.ts";

describe("buildOmpAcpSpawnInput", () => {
  it("builds the safe default OMP ACP command", () => {
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode=always-ask"],
      cwd: "/tmp/project",
    });
  });

  it("applies instance isolation and keeps the approval policy authoritative", () => {
    expect(
      buildOmpAcpSpawnInput(
        {
          binaryPath: "/opt/bin/omp",
          profile: "work",
          agentDir: "~/.omp-work/agent",
          launchArgs: "--approval-mode=yolo --model openai/gpt-5",
        },
        "/tmp/project",
        { PATH: "/opt/bin" },
        { disableTools: true },
      ),
    ).toEqual({
      command: "/opt/bin/omp",
      args: [
        "acp",
        "--approval-mode=yolo",
        "--model",
        "openai/gpt-5",
        "--profile",
        "work",
        "--no-tools",
        "--approval-mode=always-ask",
      ],
      cwd: "/tmp/project",
      env: {
        PATH: "/opt/bin",
        PI_CODING_AGENT_DIR: "~/.omp-work/agent",
      },
    });
  });
});

describe("applyOmpAcpModelSelection", () => {
  it("leaves OMP's configured model alone and applies explicit selections", async () => {
    const calls: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
    const runtime = {
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
        }),
    };

    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "default",
        selections: [{ id: "thinking", value: "high" }],
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ configId: "thinking", value: "high" }]);
  });

  it("sets a provider-qualified model before its thinking level", async () => {
    const calls: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
    const runtime = {
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
        }),
    };

    await Effect.runPromise(
      applyOmpAcpModelSelection({
        runtime,
        model: "openai/gpt-5",
        selections: [{ id: "thinking", value: "xhigh" }],
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      { configId: "model", value: "openai/gpt-5" },
      { configId: "thinking", value: "xhigh" },
    ]);
  });
});

const permissionRequest: EffectAcpSchema.RequestPermissionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "tool-1",
    kind: "edit",
  },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
    { optionId: "reject_once", kind: "reject_once", name: "Reject once" },
  ],
};

describe("OMP permission mapping", () => {
  it("auto-approves only the runtime modes and tool kinds T3 promises", () => {
    expect(ompAutoApprovedPermissionOptionId(permissionRequest, "full-access")).toBe(
      "allow_always",
    );
    expect(ompAutoApprovedPermissionOptionId(permissionRequest, "auto-accept-edits")).toBe(
      "allow_once",
    );
    expect(
      ompAutoApprovedPermissionOptionId(
        {
          ...permissionRequest,
          toolCall: { ...permissionRequest.toolCall, kind: "execute" },
        },
        "auto-accept-edits",
      ),
    ).toBeUndefined();
    expect(
      ompAutoApprovedPermissionOptionId(permissionRequest, "approval-required"),
    ).toBeUndefined();
  });

  it("maps T3 decisions to the option ids offered by OMP", () => {
    expect(ompPermissionOptionIdForDecision(permissionRequest, "accept")).toBe("allow_once");
    expect(ompPermissionOptionIdForDecision(permissionRequest, "acceptForSession")).toBe(
      "allow_always",
    );
    expect(ompPermissionOptionIdForDecision(permissionRequest, "decline")).toBe("reject_once");
    expect(ompPermissionOptionIdForDecision(permissionRequest, "cancel")).toBeUndefined();
  });
});

const elicitationRequest: EffectAcpSchema.ElicitationRequest = {
  mode: "form",
  sessionId: "session-1",
  message: "Choose how OMP should proceed.",
  requestedSchema: {
    type: "object",
    title: "OMP question",
    properties: {
      strategy: {
        type: "string",
        title: "Strategy",
        oneOf: [
          { const: "fast", title: "Fast path" },
          { const: "safe", title: "Safe path" },
        ],
      },
      confirmed: {
        type: "boolean",
        title: "Confirm",
      },
      retries: {
        type: "integer",
        title: "Retries",
      },
      files: {
        type: "array",
        title: "Files",
        items: { type: "string", enum: ["README.md", "package.json"] },
      },
    },
  },
};

describe("OMP form elicitation mapping", () => {
  it("preserves protocol values while presenting every ACP field", () => {
    expect(ompElicitationQuestions(elicitationRequest)).toEqual([
      {
        id: "strategy",
        header: "Strategy",
        question: "Choose how OMP should proceed.",
        options: [
          { label: "fast", description: "Fast path" },
          { label: "safe", description: "Safe path" },
        ],
      },
      {
        id: "confirmed",
        header: "Confirm",
        question: "Choose how OMP should proceed.",
        options: [
          { label: "true", description: "Yes" },
          { label: "false", description: "No" },
        ],
      },
      {
        id: "retries",
        header: "Retries",
        question: "Choose how OMP should proceed.",
        options: [],
      },
      {
        id: "files",
        header: "Files",
        question: "Choose how OMP should proceed.",
        options: [
          { label: "README.md", description: "README.md" },
          { label: "package.json", description: "package.json" },
        ],
        multiSelect: true,
      },
    ]);
  });

  it("coerces T3 answers back into ACP form content", () => {
    expect(
      ompElicitationContentFromAnswers(elicitationRequest, {
        strategy: "safe",
        confirmed: "true",
        retries: "3",
        files: ["README.md", "package.json"],
      }),
    ).toEqual({
      strategy: "safe",
      confirmed: true,
      retries: 3,
      files: ["README.md", "package.json"],
    });
  });
});
