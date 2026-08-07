import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  ompModelsFromInventory,
  parseOmpModelsJson,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const inventoryJson = JSON.stringify({
  models: [
    {
      provider: "openai",
      id: "gpt-5",
      selector: "openai/gpt-5",
      name: "GPT-5",
      reasoning: true,
      thinking: ["low", "high"],
      input: ["text", "image"],
      cost: { input: 1, output: 2 },
    },
  ],
});

describe("OMP model inventory", () => {
  it("maps provider-qualified models and thinking levels", () => {
    const models = ompModelsFromInventory(parseOmpModelsJson(inventoryJson));

    expect(models.map((model) => model.slug)).toEqual(["default", "openai/gpt-5"]);
    expect(models[0]).toMatchObject({
      name: "OMP configured model",
      isDefault: true,
    });
    expect(models[1]).toMatchObject({
      name: "GPT-5",
      subProvider: "openai",
      capabilities: {
        optionDescriptors: [
          {
            id: "thinking",
            currentValue: "auto",
            options: [
              { id: "auto", label: "Auto", isDefault: true },
              { id: "off", label: "Off" },
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    });
  });
});

describe("buildInitialOmpProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when OMP is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(
        decodeOmpSettings({ enabled: false }),
      );
      expect(snapshot).toMatchObject({
        enabled: false,
        installed: false,
        status: "disabled",
      });
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot with the configured-model option", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({}));
      expect(snapshot).toMatchObject({
        enabled: true,
        installed: true,
        status: "warning",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      expect(snapshot.showInteractionModeToggle).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  it.effect("reports a missing OMP binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ binaryPath: "/definitely/not/installed/omp-binary" }),
      );
      expect(snapshot).toMatchObject({ installed: false, status: "error" });
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("uses the configured profile and agent directory during model discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-status-" });
        const ompPath = path.join(dir, "omp");
        const agentDir = path.join(dir, "agent");
        yield* fs.writeFileString(
          ompPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            '  printf "omp/17.2.10\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "models" ] && [ "$2" = "--json" ] && [ "$3" = "--profile" ] && [ "$4" = "work" ] && [ "$PI_CODING_AGENT_DIR" = "' +
              agentDir +
              '" ]; then',
            `  printf '%s\\n' '${inventoryJson}'`,
            "  exit 0",
            "fi",
            "exit 3",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(ompPath, 0o755);

        const snapshot = yield* checkOmpProviderStatus(
          decodeOmpSettings({
            binaryPath: ompPath,
            profile: "work",
            agentDir,
          }),
        );

        expect(snapshot).toMatchObject({
          installed: true,
          version: "17.2.10",
          status: "ready",
        });
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "openai/gpt-5"]);
      }),
    ),
  );
});
