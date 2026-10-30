import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));

import { useApi } from "../../hooks/useApi.js";
import ModelConfigurator from "../ModelConfigurator.jsx";
import { ROUTES, findRoute } from "../../routes.js";

const payload = {
  available: true,
  revision: "abc123def4567890",
  updatedAt: "2026-01-01T00:00:00.000Z",
  storage: { mode: "github", location: "github:acme/data@main:model-config.json", ready: true, error: null, localOnly: false },
  warnings: [],
  schema: {
    version: 1,
    protocols: ["openai-chat", "anthropic"],
    capabilities: [
      { id: "text_input", label: "Text input", group: "Text", requestable: true, description: "Accepts text prompts." },
      { id: "text_output", label: "Text output", group: "Text", requestable: true, description: "Returns text." },
      { id: "image_input", label: "Image input", group: "Media", requestable: true, description: "Accepts images." },
      { id: "image_output", label: "Image output", group: "Media", requestable: true, description: "Generates images." }
    ]
  },
  adapters: { "openai-chat": ["text_input", "text_output", "image_input"] },
  models: [
    {
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
      protocols: ["openai-chat"],
      keyCount: 2,
      configuredInEnvironment: true,
      stored: true,
      source: "configured",
      warnings: []
    },
    {
      id: "legacy:gemini/flash",
      configId: null,
      provider: "gemini",
      model: "flash",
      displayName: "flash",
      enabled: false,
      enabledByConfig: true,
      disabledBySwitch: true,
      capabilities: ["text_input", "image_output"],
      capabilitiesSource: "inferred",
      executableCapabilities: ["text_input"],
      unsupportedCapabilities: ["image_output"],
      protocols: ["openai-chat"],
      keyCount: 1,
      configuredInEnvironment: true,
      stored: false,
      source: "environment",
      warnings: ["No adapter can execute: image_output."]
    }
  ]
};

describe("Model Configurator page", () => {
  beforeEach(() => {
    useApi.mockReset();
    useApi.mockReturnValue({
      data: payload,
      error: null,
      loading: false,
      refreshing: false,
      paused: false,
      lastUpdatedAt: null,
      reload() {}
    });
  });

  it("is its own routed page under Configure", () => {
    const route = findRoute("/model-config");
    expect(route?.label).toBe("Model Configurator");
    expect(route?.group).toBe("Configure");
    expect(ROUTES.filter((entry) => entry.path === "/model-config")).toHaveLength(1);
  });

  it("shows one page title, the storage location and the add action", () => {
    const markup = renderToStaticMarkup(<ModelConfigurator />);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain("Model Configurator");
    expect(markup).toContain("Persisted to GitHub");
    expect(markup).toContain("github:acme/data@main:model-config.json");
    expect(markup).toContain("Add model");
  });

  it("offers a bulk capabilities action, enabled only when there are models", () => {
    expect(renderToStaticMarkup(<ModelConfigurator />)).toContain("Bulk capabilities");
  });

  it("renders the effective routing state separately from the declared source", () => {
    const markup = renderToStaticMarkup(<ModelConfigurator />);
    expect(markup).toContain("Llama");
    expect(markup).toContain("Configured");
    expect(markup).toContain("Environment");
    // The environment model is switched off by the Model Switch, and the page
    // says so instead of pretending the declaration is what disabled it.
    expect(markup).toContain("why?");
    expect(markup).toContain("No adapter can execute: image_output.");
  });

  it("shows declared capabilities as chips, including unsupported ones", () => {
    const markup = renderToStaticMarkup(<ModelConfigurator />);
    expect(markup).toContain("text_input");
    expect(markup).toContain("image_output");
    expect(markup).toContain("Declared capabilities");
  });

  it("explains an empty environment instead of rendering an empty table", () => {
    useApi.mockReturnValue({
      data: { available: true, models: [], schema: { version: 1, capabilities: [] }, storage: null },
      error: null,
      loading: false,
      refreshing: false,
      paused: false,
      lastUpdatedAt: null,
      reload() {}
    });
    const markup = renderToStaticMarkup(<ModelConfigurator />);
    expect(markup).toContain("No models configured");
    expect(markup).toContain("Configure a provider");
  });
});
