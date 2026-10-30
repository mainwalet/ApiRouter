import { describe, expect, it } from "vitest";
import {
  adapterSupportState,
  adapterSupports,
  availabilityNote,
  buildDraftPayload,
  canRemoveModel,
  capabilityGroups,
  capabilityState,
  draftFromCandidate,
  draftFromRow,
  editorFromRow,
  filterModels,
  findModelRow,
  formatTokenCount,
  normalizeModelConfigPayload,
  parseTokenCount,
  providerChoices,
  rowTone,
  selectionLabel,
  summarizeModels,
  toggleCapability
} from "../modelConfig.js";

const schema = {
  version: 1,
  protocols: ["openai-chat"],
  capabilities: [
    { id: "text_input", label: "Text input", group: "Text", requestable: true, description: "accepts text" },
    { id: "text_output", label: "Text output", group: "Text", requestable: true, description: "returns text" },
    { id: "tool_calling", label: "Tool calling", group: "Tools", requestable: true },
    { id: "reasoning", label: "Reasoning", group: "Tools", requestable: false }
  ]
};

const adapters = { "openai-chat": ["text_input", "text_output", "tool_calling", "reasoning"] };

const row = (overrides = {}) => ({
  id: "mc_aaaaaaaaaaaaaaaa",
  configId: "mc_aaaaaaaaaaaaaaaa",
  provider: "groq",
  model: "llama",
  displayName: "Llama",
  enabled: true,
  enabledByConfig: true,
  capabilities: ["text_input", "text_output"],
  capabilitiesSource: "configured",
  executableCapabilities: ["text_input", "text_output"],
  unsupportedCapabilities: [],
  pools: ["text"],
  protocols: ["openai-chat"],
  keyCount: 2,
  configuredInEnvironment: true,
  stored: true,
  source: "configured",
  manualSelection: { text: true, vision: false },
  warnings: [],
  ...overrides
});

describe("model config view model", () => {
  it("normalizes a missing payload into an empty, safe view", () => {
    const view = normalizeModelConfigPayload(null);
    expect(view.available).toBe(false);
    expect(view.models).toEqual([]);
    expect(view.summary.total).toBe(0);
    expect(view.schema.version).toBe(1);
  });

  it("drops malformed rows instead of rendering them", () => {
    const view = normalizeModelConfigPayload({ models: [{ provider: "groq" }, {}, null, row()] });
    expect(view.models).toHaveLength(1);
    expect(view.models[0].model).toBe("llama");
  });

  it("keeps the declared/environment distinction explicit", () => {
    const view = normalizeModelConfigPayload({
      models: [
        row(),
        {
          provider: "groq", model: "inferred", capabilities: ["text_input"],
          capabilitiesSource: "inferred", pools: ["text"], stored: false
        }
      ]
    });
    expect(view.models[0].source).toBe("configured");
    expect(view.models[0].capabilitiesSource).toBe("configured");
    expect(view.models[1].source).toBe("environment");
    expect(view.models[1].capabilitiesSource).toBe("inferred");
    expect(view.summary).toEqual({
      total: 2, configured: 1, environmentOnly: 1, enabled: 2, disabled: 0, declaredUnsupported: 0
    });
  });

  it("groups capabilities in schema order and marks reasoning as a preference", () => {
    const groups = capabilityGroups(schema);
    expect(groups.map((group) => group.label)).toEqual(["Text", "Tools"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["text_input", "text_output"]);
    const reasoning = groups[1].items.find((item) => item.id === "reasoning");
    expect(reasoning.requestable).toBe(false);
  });

  it("reports declared and executable as separate facts", () => {
    const image = row({
      capabilities: ["text_input", "image_output"],
      executableCapabilities: ["text_input"],
      unsupportedCapabilities: ["image_output"]
    });
    expect(capabilityState(image, "image_output")).toEqual({ declared: true, executable: false, unsupported: true });
    expect(capabilityState(image, "text_input")).toEqual({ declared: true, executable: true, unsupported: false });
    expect(capabilityState(image, "audio_input")).toEqual({ declared: false, executable: false, unsupported: false });
  });

  it("knows which adapter supports a capability on a model's protocols", () => {
    expect(adapterSupports(adapters, ["openai-chat"], "tool_calling")).toBe(true);
    expect(adapterSupports(adapters, ["anthropic"], "tool_calling")).toBe(false);
    expect(adapterSupports({}, ["openai-chat"], "text_input")).toBe(false);
  });

  it("distinguishes an unsupported adapter from an unresolved protocol list", () => {
    expect(adapterSupportState(adapters, ["openai-chat"], "tool_calling")).toBe("supported");
    expect(adapterSupportState(adapters, ["anthropic"], "tool_calling")).toBe("unsupported");
    expect(adapterSupportState(adapters, [], "tool_calling")).toBe("unknown");
    expect(adapterSupportState({}, ["openai-chat"], "tool_calling")).toBe("unknown");
  });

  it("opens an environment row as a prefilled create declaration, not an edit with no id", () => {
    const environment = row({
      id: "groq/llama",
      configId: null,
      stored: false,
      source: "environment",
      displayName: "Llama",
      capabilities: ["text_input"],
      enabled: true
    });
    const editor = editorFromRow(environment);
    expect(editor.mode).toBe("create");
    expect(editor.row).toBe(environment);
    expect(editor.draft.provider).toBe("groq");
    expect(editor.draft.model).toBe("llama");
    expect(editor.draft.capabilities).toEqual(["text_input"]);
    expect(editorFromRow(row()).mode).toBe("edit");
    expect(editorFromRow(null).mode).toBe("create");
    expect(canRemoveModel(environment)).toBe(false);
    expect(canRemoveModel(row())).toBe(true);
    expect(canRemoveModel(row({ stored: true, configId: null }))).toBe(false);
    expect(findModelRow([environment], "GROQ", "llama")).toBe(environment);
    expect(findModelRow([environment], "groq", "other")).toBeNull();
  });

  it("filters by provider, pool, routing, source and free text", () => {
    const models = [
      row(),
      row({ provider: "gemini", model: "flash", source: "environment", stored: false, capabilities: ["image_input"] }),
      row({ provider: "groq", model: "off", enabled: false, enabledByConfig: false })
    ];
    const ids = (list) => list.map((item) => item.model);

    expect(ids(filterModels(models, { search: "flash" }))).toEqual(["flash"]);
    expect(ids(filterModels(models, { search: "image_input" }))).toEqual(["flash"]);
    expect(ids(filterModels(models, { status: "disabled" }))).toEqual(["off"]);
    expect(ids(filterModels(models, { source: "configured" }))).toEqual(["llama", "off"]);
    expect(ids(filterModels(models, { provider: "groq" }))).toEqual(["llama", "off"]);
    expect(providerChoices(models)).toEqual(["gemini", "groq"]);
  });

  it("builds and toggles an editable draft", () => {
    const draft = draftFromRow(row());
    expect(draft).toEqual({
      displayName: "Llama", enabled: true, capabilities: ["text_input", "text_output"], protocol: "", contextLimit: ""
    });
    expect(toggleCapability(draft.capabilities, "tool_calling")).toContain("tool_calling");
    expect(toggleCapability(draft.capabilities, "text_input")).not.toContain("text_input");

    const created = draftFromCandidate({ provider: "groq", model: "new-model", capabilities: ["text_input"] });
    expect(created.provider).toBe("groq");
    expect(created.model).toBe("new-model");
    expect(buildDraftPayload({ ...created, protocol: "" })).toEqual({
      displayName: "new-model",
      enabled: true,
      capabilities: ["text_input"],
      protocol: null,
      contextLimit: null
    });
  });

  it("never sends a disabled checkbox as enabled when the user switched it off", () => {
    expect(buildDraftPayload({ displayName: "x", enabled: false, capabilities: [], protocol: "gemini" })).toEqual({
      displayName: "x", enabled: false, capabilities: [], protocol: "gemini", contextLimit: null
    });
  });

  describe("context limit", () => {
    it("reads sizes the way an operator types them", () => {
      expect(parseTokenCount("1m")).toBe(1_000_000);
      expect(parseTokenCount("1.5M")).toBe(1_500_000);
      expect(parseTokenCount("500k")).toBe(500_000);
      expect(parseTokenCount("200,000")).toBe(200_000);
      expect(parseTokenCount(" 200000 ")).toBe(200_000);
      expect(parseTokenCount(700000)).toBe(700_000);
    });

    it("treats an empty field as not declared, and passes unreadable text through for the gateway to refuse", () => {
      for (const empty of ["", "   ", null, undefined]) expect(parseTokenCount(empty)).toBeNull();
      // Never silently turned into a different number.
      expect(parseTokenCount("lots")).toBe("lots");
      expect(parseTokenCount("12 tokens")).toBe("12 tokens");
      expect(parseTokenCount("-5")).toBe("-5");
    });

    it("shows a limit compactly, exactly when that is exact", () => {
      expect(formatTokenCount(1_000_000)).toBe("1M");
      expect(formatTokenCount(1_500_000)).toBe("1.5M");
      expect(formatTokenCount(700_000)).toBe("700K");
      expect(formatTokenCount(200_000)).toBe("200K");
      expect(formatTokenCount(1_048_576)).toBe("1,048,576");
      expect(formatTokenCount(null)).toBe("");
      expect(formatTokenCount(0)).toBe("");
    });

    it("carries the saved limit into the editor and back out as a number", () => {
      const normalized = normalizeModelConfigPayload({ models: [row({ contextLimit: 700000 }), row({ model: "other" })] });
      expect(normalized.models[0].contextLimit).toBe(700_000);
      expect(normalized.models[1].contextLimit).toBeNull();

      const draft = draftFromRow(normalized.models[0]);
      expect(draft.contextLimit).toBe("700000");
      expect(buildDraftPayload({ ...draft, contextLimit: "1m" }).contextLimit).toBe(1_000_000);
      // Emptying the field clears a saved limit.
      expect(buildDraftPayload({ ...draft, contextLimit: "" }).contextLimit).toBeNull();
      expect(draftFromRow(normalized.models[1]).contextLimit).toBe("");
    });

    it("prefills the limit when an environment-only row opens the create drawer", () => {
      const environment = row({ stored: false, configId: null, source: "environment", contextLimit: null });
      expect(editorFromRow(environment).draft.contextLimit).toBe("");
      expect(draftFromCandidate({ provider: "groq", model: "m", contextLimit: 200000 }).contextLimit).toBe("200000");
    });

    it("ignores a limit the gateway reports that is not a positive whole number", () => {
      for (const bad of [0, -1, 1.5, "200000", NaN, null]) {
        expect(normalizeModelConfigPayload({ models: [row({ contextLimit: bad })] }).models[0].contextLimit).toBeNull();
      }
    });
  });

  it("explains why a model is unavailable, preferring the outermost reason", () => {
    expect(availabilityNote(row({ disabledByProvider: true, disabledBySwitch: true })))
      .toMatch(/whole provider/);
    expect(availabilityNote(row({ disabledBySwitch: true }))).toMatch(/Control Panel/);
    expect(availabilityNote(row({ enabledByConfig: false, enabled: false }))).toMatch(/Model Configurator/);
    expect(availabilityNote(row({ enabledByConfig: false, enabled: false, disabledBySwitch: true })))
      .toMatch(/Model Configurator/);
    expect(availabilityNote(row({ configuredInEnvironment: false }))).toMatch(/No provider/);
    expect(availabilityNote(row())).toBe("");
  });

  it("labels manual-selection membership and row attention", () => {
    expect(selectionLabel(row())).toBe("");
    expect(selectionLabel(row({ manualSelection: { text: true, vision: true } }))).toBe("");
    expect(selectionLabel(row({ manualSelection: { text: false, vision: false } }))).toBe("");

    expect(rowTone(row())).toBe("ok");
    expect(rowTone(row({ stored: false, source: "environment" }))).toBe("neutral");
    expect(rowTone(row({ unsupportedCapabilities: ["image_output"] }))).toBe("warn");
    expect(rowTone(row({ disabledBySwitch: true }))).toBe("off");
  });

  it("summarizes a list without trusting its own stale buttons", () => {
    expect(summarizeModels([
      row(),
      row({ enabled: false, enabledByConfig: false }),
      row({ unsupportedCapabilities: ["image_output"] })
    ])).toEqual({
      total: 3, configured: 3, environmentOnly: 0, enabled: 2, disabled: 1, declaredUnsupported: 1
    });
  });
});
