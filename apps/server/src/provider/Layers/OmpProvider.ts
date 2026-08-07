import {
  type ModelCapabilities,
  type OmpSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildOmpAcpEnvironment } from "../acp/OmpAcpSupport.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const OMP_PRESENTATION = {
  displayName: "OMP",
  showInteractionModeToggle: true,
} as const;
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const OmpModelInfo = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  selector: Schema.String,
  name: Schema.String,
  reasoning: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Array(Schema.String)),
  input: Schema.optional(Schema.Array(Schema.String)),
});
const OmpModelsOutput = Schema.Struct({ models: Schema.Array(OmpModelInfo) });
type OmpModelInfo = typeof OmpModelInfo.Type;
const decodeOmpModelsJson = Schema.decodeUnknownSync(Schema.fromJsonString(OmpModelsOutput));

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_THINKING_LEVELS = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function titleCase(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function thinkingCapabilities(levels: ReadonlyArray<string>): ModelCapabilities {
  const values = Array.from(new Set(["auto", "off", ...levels]));
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "thinking",
        label: "Thinking",
        description: "Controls OMP reasoning effort for this model.",
        options: values.map((value) => ({
          value,
          label: titleCase(value),
          ...(value === "auto" ? { isDefault: true as const } : {}),
        })),
      }),
    ],
  });
}

const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "OMP configured model",
  isDefault: true,
  isCustom: false,
  capabilities: thinkingCapabilities(DEFAULT_THINKING_LEVELS),
};

export function parseOmpModelsJson(stdout: string): ReadonlyArray<OmpModelInfo> {
  return decodeOmpModelsJson(stdout).models;
}

export function ompModelsFromInventory(
  inventory: ReadonlyArray<OmpModelInfo>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [DEFAULT_MODEL];
  seen.add(DEFAULT_MODEL.slug);

  for (const model of inventory) {
    const slug = model.selector.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name = model.name.trim() || model.id.trim() || slug;
    const subProvider = model.provider.trim();
    models.push({
      slug,
      name,
      ...(subProvider ? { subProvider } : {}),
      isCustom: false,
      capabilities:
        model.reasoning || (model.thinking?.length ?? 0) > 0
          ? thinkingCapabilities(model.thinking ?? [])
          : EMPTY_CAPABILITIES,
    });
  }

  return models;
}

function ompModelsFromSettings(
  settings: OmpSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [DEFAULT_MODEL],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES);
}

export const buildInitialOmpProviderSnapshot = (
  settings: OmpSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: ompModelsFromSettings(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking OMP CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "OMP is disabled in T3 Code settings.",
          },
    });
  });

const runOmpCommand = (
  settings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "omp";
    const env = buildOmpAcpEnvironment(settings, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(settings);
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OMP is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("OMP CLI health check failed", { errorTag: error._tag });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "OMP CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute OMP CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OMP CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OMP CLI is installed but failed to run.",
      },
    });
  }

  const modelArgs = [
    "models",
    "--json",
    ...(settings.profile ? ["--profile", settings.profile] : []),
  ];
  const modelsResult = yield* runOmpCommand(settings, modelArgs, environment).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(modelsResult)) {
    yield* Effect.logWarning("OMP model discovery failed", {
      errorTag: modelsResult.failure._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "OMP is installed, but model discovery failed. Check OMP credentials and profile settings.",
      },
    });
  }
  if (Option.isNone(modelsResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `OMP model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const modelsOutput = modelsResult.success.value;
  if (modelsOutput.code !== 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "OMP is installed, but `omp models --json` failed. Check OMP credentials and profile settings.",
      },
    });
  }

  let inventory: ReadonlyArray<OmpModelInfo>;
  try {
    inventory = parseOmpModelsJson(modelsOutput.stdout);
  } catch {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "OMP returned an invalid model inventory.",
      },
    });
  }

  const discovered = ompModelsFromInventory(inventory);
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models: ompModelsFromSettings(settings, discovered),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      ...(inventory.length === 0
        ? { message: "OMP is ready, but no configured provider models were found." }
        : {}),
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("OMP version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
