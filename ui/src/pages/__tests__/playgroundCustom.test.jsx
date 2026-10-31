import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../hooks/useApi.js", () => ({ useApi: vi.fn() }));
vi.mock("../../context/ToastContext.jsx", () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock("../../context/ConnectionContext.jsx", () => ({ useConnection: () => ({ generation: 0 }) }));

import { useApi } from "../../hooks/useApi.js";
import Playground from "../Playground.jsx";

const model = (provider, id, extra = {}) => ({ provider, model: id, pool: "text", keyIndex: 0, status: "healthy", ...extra });

function render(models, { loading = false } = {}) {
  useApi.mockReturnValue({
    data: { models }, error: null, loading, reload() {}, refreshing: false, lastUpdatedAt: Date.now()
  });
  return renderToStaticMarkup(<Playground />);
}

describe("Playground custom endpoint mode", () => {
  beforeEach(() => useApi.mockReset());

  it("opens on Custom endpoint when nothing is configured, instead of a dead end", () => {
    const markup = render([]);
    expect(markup).not.toContain("No routable targets");
    expect(markup).toContain("Test any API key, base URL and model");
    expect(markup).toContain('id="pg-c-base"');
    expect(markup).toContain('id="pg-c-model"');
    expect(markup).toContain('id="pg-c-protocol"');
    // The key is masked by default and the browser is told not to autofill it.
    expect(markup).toMatch(/<input[^>]*id="pg-c-key"[^>]*type="password"|<input[^>]*type="password"[^>]*id="pg-c-key"/);
    expect(markup).toContain('autoComplete="new-password"');
  });

  it("tells the operator what is missing and keeps Send disabled until it is filled in", () => {
    const markup = render([]);
    expect(markup).toContain("Enter a base URL.");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*aria-label="Send"|<button[^>]*aria-label="Send"[^>]*disabled/);
  });

  it("offers every API style, since a custom endpoint speaks exactly one of them", () => {
    const markup = render([]);
    for (const label of ["OpenAI Chat", "OpenAI Responses", "Anthropic Messages", "Gemini generateContent"]) {
      expect(markup).toContain(label);
    }
  });

  it("keeps the router mode as the default when providers are configured", () => {
    const markup = render([model("groq", "llama-3.3-70b"), model("mistral", "mistral-large")]);
    expect(markup).toContain("Send a real request through the gateway router");
    expect(markup).toContain("Auto Route");
    expect(markup).not.toContain('id="pg-c-base"');
    // The switch to Custom is always on offer.
    expect(markup).toContain("Custom endpoint");
    expect(markup).toContain("Router");
  });

  it("starts with the provider's own temperature, so models that refuse one can still be tested", () => {
    const markup = render([]);
    expect(markup).toContain("provider default");
    // Nothing has been chosen yet, so there is nothing to reset.
    expect(markup).not.toContain("Use default");
  });

  it("shows the loading skeleton, not the custom form, while the catalog loads", () => {
    const markup = render([], { loading: true });
    expect(markup).toContain("skeleton");
    expect(markup).not.toContain('id="pg-c-base"');
  });
});

describe("Playground does not save endpoints", () => {
  beforeEach(() => useApi.mockReset());

  it("offers no Save permanently button, only a pointer to the Custom Endpoints page", () => {
    const markup = render([]);
    expect(markup).not.toContain("Save permanently");
    expect(markup).toContain("Custom Endpoints page");
  });
});
