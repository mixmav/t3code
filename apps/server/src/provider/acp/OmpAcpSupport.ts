import {
  type OmpSettings,
  type ProviderApprovalDecision,
  type ProviderOptionSelection,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type OmpAcpRuntimeSettings = Pick<
  OmpSettings,
  "agentDir" | "binaryPath" | "launchArgs" | "profile"
>;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly disableTools?: boolean;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId: "model" | "thinking";
}

export function buildOmpAcpEnvironment(
  ompSettings: Pick<OmpAcpRuntimeSettings, "agentDir"> | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!ompSettings?.agentDir) {
    return environment;
  }
  return { ...environment, PI_CODING_AGENT_DIR: ompSettings.agentDir };
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly disableTools?: boolean },
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: [
      "acp",
      ...tokenizeCliArgs(ompSettings?.launchArgs ?? ""),
      ...(ompSettings?.profile ? ["--profile", ompSettings.profile] : []),
      ...(options?.disableTools ? ["--no-tools"] : []),
      // Keep this last so custom launch arguments cannot silently bypass T3's
      // permission UI. Runtime modes decide which requests are auto-approved.
      "--approval-mode=always-ask",
    ],
    cwd,
    env: buildOmpAcpEnvironment(ompSettings, environment),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment, {
          ...(input.disableTools === undefined ? {} : { disableTools: input.disableTools }),
        }),
        authMethodId: "agent",
        clientCapabilities: { elicitation: { form: {} } },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

interface OmpAcpModelSelectionRuntime {
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function resolveOmpAcpModelId(model: string | null | undefined): string | undefined {
  const normalized = model?.trim();
  return normalized && normalized !== "default" ? normalized : undefined;
}

export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = resolveOmpAcpModelId(input.model);
    if (model) {
      yield* input.runtime
        .setConfigOption("model", model)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-config-option", configId: "model" }),
          ),
        );
    }

    const thinking = input.selections?.find((selection) => selection.id === "thinking")?.value;
    if (typeof thinking === "string" && thinking.trim().length > 0) {
      yield* input.runtime
        .setConfigOption("thinking", thinking)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-config-option", configId: "thinking" }),
          ),
        );
    }
  });
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionsForProperty(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return property.oneOf.map((option) => ({
        label: option.const,
        description: option.title,
      }));
    }
    if (property.enum && property.enum.length > 0) {
      return property.enum.map((value) => ({ label: value, description: value }));
    }
  }
  if (property.type === "boolean") {
    return [
      { label: "true", description: "Yes" },
      { label: "false", description: "No" },
    ];
  }
  if (property.type === "array") {
    const values =
      "enum" in property.items
        ? property.items.enum.map((value) => ({ value, title: value }))
        : property.items.anyOf.map((option) => ({ value: option.const, title: option.title }));
    return values.map(({ value, title }) => ({ label: value, description: title }));
  }
  return [];
}

export function ompElicitationQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode !== "form") {
    return [];
  }
  const properties = Object.entries(request.requestedSchema.properties ?? {});
  if (properties.length === 0) {
    return [
      {
        id: "value",
        header: nonEmpty(request.requestedSchema.title) ?? "Question",
        question: nonEmpty(request.message) ?? "Provide a response.",
        options: [],
      },
    ];
  }
  return properties.map(([id, property], index) => ({
    id,
    header:
      nonEmpty(property.title) ??
      nonEmpty(request.requestedSchema.title) ??
      `Question ${index + 1}`,
    question: nonEmpty(property.description) ?? nonEmpty(request.message) ?? id,
    options: optionsForProperty(property),
    ...(property.type === "array" ? { multiSelect: true } : {}),
  }));
}

function coerceElicitationAnswer(
  property: EffectAcpSchema.ElicitationPropertySchema | undefined,
  answer: unknown,
): string | number | boolean | ReadonlyArray<string> | undefined {
  if (!property) {
    return typeof answer === "string" || typeof answer === "number" || typeof answer === "boolean"
      ? answer
      : undefined;
  }
  if (property.type === "array") {
    if (Array.isArray(answer)) {
      return answer.filter((entry): entry is string => typeof entry === "string");
    }
    return typeof answer === "string" ? [answer] : undefined;
  }
  if (property.type === "boolean") {
    if (typeof answer === "boolean") return answer;
    if (typeof answer !== "string") return undefined;
    if (answer.toLowerCase() === "true" || answer.toLowerCase() === "yes") return true;
    if (answer.toLowerCase() === "false" || answer.toLowerCase() === "no") return false;
    return undefined;
  }
  if (property.type === "number" || property.type === "integer") {
    if (typeof answer === "number") return answer;
    if (typeof answer !== "string" || answer.trim().length === 0) return undefined;
    const parsed = Number(answer);
    if (!Number.isFinite(parsed)) return undefined;
    if (property.type === "integer" && !Number.isInteger(parsed)) return undefined;
    return parsed;
  }
  return typeof answer === "string" ? answer : String(answer);
}

export function ompElicitationContentFromAnswers(
  request: EffectAcpSchema.ElicitationRequest,
  answers: ProviderUserInputAnswers,
): Record<string, string | number | boolean | ReadonlyArray<string>> {
  if (request.mode !== "form") {
    return {};
  }
  const content: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const coerced = coerceElicitationAnswer(request.requestedSchema.properties?.[id], answer);
    if (coerced !== undefined) {
      content[id] = coerced;
    }
  }
  return content;
}

function permissionOptionId(
  options: EffectAcpSchema.RequestPermissionRequest["options"],
  kinds: ReadonlyArray<EffectAcpSchema.PermissionOption["kind"]>,
): string | undefined {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option.optionId;
  }
  return undefined;
}

export function ompPermissionOptionIdForDecision(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  switch (decision) {
    case "acceptForSession":
      return permissionOptionId(request.options, ["allow_always", "allow_once"]);
    case "accept":
      return permissionOptionId(request.options, ["allow_once", "allow_always"]);
    case "decline":
      return permissionOptionId(request.options, ["reject_once", "reject_always"]);
    case "cancel":
      return undefined;
  }
}

export function ompAutoApprovedPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  runtimeMode: RuntimeMode,
): string | undefined {
  if (runtimeMode === "full-access") {
    return permissionOptionId(request.options, ["allow_always", "allow_once"]);
  }
  if (
    runtimeMode === "auto-accept-edits" &&
    (request.toolCall.kind === "edit" ||
      request.toolCall.kind === "delete" ||
      request.toolCall.kind === "move")
  ) {
    return permissionOptionId(request.options, ["allow_once", "allow_always"]);
  }
  return undefined;
}
