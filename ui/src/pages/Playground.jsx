import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { writeClipboard } from "../components/ui/CopyButton.jsx";
import { Markdown } from "../lib/markdown.jsx";
import { createSmoothStream } from "../lib/smoothStream.js";
import { useApi } from "../hooks/useApi.js";
import { useToast } from "../context/ToastContext.jsx";
import { getModels } from "../api/models.js";
import {
  sendPlaygroundRequest, sendCustomRequest, buildRequestBody, buildHistory, buildPinHeaders, parseMaxTokens,
  customProblem, customMaxTokens, PROTOCOL_ENDPOINTS
} from "../api/playground.js";
import { formatLatency, formatTokens, protocolLabel, providerLabel, EMPTY } from "../lib/format.js";
import { sanitizeText } from "../lib/sanitize.js";
import { loadChat, saveChat } from "../lib/chatStore.js";
import { usePageActive } from "../context/PageActivityContext.js";
import { nextStick } from "../lib/followScroll.js";
import { MAX_IMAGES, ACCEPTED_IMAGE_TYPES, imageProblem, readImageFile } from "../lib/images.js";

/**
 * Playground.
 *
 * Requests go to the gateway's public proxy endpoints, never to a provider
 * directly. With Auto Route on, the `model` field is omitted entirely, which is
 * what makes the gateway widen to every compatible target and choose — so the
 * router is never bypassed, and the playground exercises the same code path a
 * real client does, including cooldown and fallback.
 *
 * Choosing a provider, model or key switches Auto Route off and pins the
 * request: the provider (and key, when picked) travel as pin headers and the
 * gateway calls exactly that target. A model with no provider is still routed
 * by the gateway, which prefers that model and may fall back. The response
 * headers report which target actually answered.
 *
 * Every protocol can reach every configured model — the gateway translates —
 * so the lists are not narrowed by protocol.
 */
const PROTOCOLS = Object.keys(PROTOCOL_ENDPOINTS);

// "Auto" in the model list: the provider is pinned but no model is, so the
// gateway walks that provider's models (and only those) until one answers.
const AUTO_MODEL = "__auto__";
const LAST_MODEL_KEY = "apirouter.playground.lastModel";
const ROTATE_KEY = "apirouter.playground.rotateModels";

function readLastModels() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAST_MODEL_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readRotate() {
  try {
    return window.localStorage.getItem(ROTATE_KEY) === "1";
  } catch {
    return false;
  }
}


// Custom-endpoint form values that are worth keeping between visits. The API key
// is deliberately NOT among them: it lives in component state only.
const SAVED_KEY = "apirouter.playground.custom";

function readSaved(field) {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const value = raw ? JSON.parse(raw)?.[field] : "";
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function writeSaved(values) {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(values));
  } catch {
    // Private mode or a full quota: the form just starts empty next time.
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl ?? "").trim()).host;
  } catch {
    return "";
  }
}

const SUGGESTIONS = Object.freeze([
  "Explain how this router picks a provider",
  "Write a haiku about retries and fallbacks",
  "Summarize the pros and cons of streaming APIs",
  "Say hello in five languages"
]);

function MessageAction({ label, icon, onClick, disabled = false }) {
  return (
    <button type="button" className="msg-act" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Icon name={icon} size={14} />
    </button>
  );
}

function CopyAction({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await writeClipboard(text))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return <MessageAction label={copied ? "Copied" : "Copy reply"} icon={copied ? "check" : "copy"} onClick={copy} />;
}

export default function Playground() {
  const catalog = useApi(getModels, { intervalMs: 30_000 });
  const toast = useToast();

  const models = catalog.data?.models ?? [];

  // Every configured target is reachable from every client protocol through the
  // gateway's bridges, so the protocol list is fixed rather than derived. A
  // custom endpoint speaks exactly one of them, so it needs the list even when
  // nothing is configured.
  const protocols = PROTOCOLS;

  const [protocol, setProtocol] = useState(() => readSaved("protocol"));
  const [providerPick, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [keyIndex, setKeyIndex] = useState("");
  const [autoRoute, setAutoRoute] = useState(true);
  // Two fallback systems for the "Auto" model. Round-robin ON: each request
  // starts at the model AFTER the one that answered last (model 1, then 2, ...).
  // OFF: the model that answered last is tried first next time. Either way a
  // failing model moves on to the next one, and only this provider is used.
  const [rotateModels, setRotateModels] = useState(readRotate);
  const [lastModels, setLastModels] = useState(readLastModels);
  // null = the provider's own default, so the field is not sent at all. Some models
  // (OpenAI o-series / gpt-5, for one) refuse any temperature they did not choose, so a
  // test that always sent 0.7 could never reach them. The slider turns it on.
  const [temperature, setTemperature] = useState(null);
  const [maxTokens, setMaxTokens] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState([]);
  const fileInputRef = useRef(null);

  const activeProtocol = protocols.includes(protocol) ? protocol : protocols[0];

  // "Router" sends through the gateway's own routing. "Custom" sends one request
  // to a base URL / key / model typed in here. With nothing configured there is
  // nothing to route, so the page opens on Custom instead of an empty state.
  const [sourcePick, setSourcePick] = useState(null);
  const source = sourcePick ?? (!catalog.loading && models.length === 0 ? "custom" : "gateway");
  const custom = source === "custom";
  const [customBase, setCustomBase] = useState(() => readSaved("baseUrl"));
  const [customModelName, setCustomModelName] = useState(() => readSaved("model"));
  const [customKey, setCustomKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    writeSaved({ baseUrl: customBase, model: customModelName, protocol: activeProtocol });
  }, [customBase, customModelName, activeProtocol]);

  const customHost = hostOf(customBase);
  const customBlock = custom ? customProblem({ baseUrl: customBase, model: customModelName }) : null;

  const hasImages = images.length > 0;

  const providerOptions = useMemo(() => [...new Set(models.map((entry) => entry.provider))].sort(), [models]);

  // A provider picked for one model may not exist in another; fall back to
  // "any" instead of pinning a provider that cannot serve the choice.
  const provider = providerOptions.includes(providerPick) ? providerPick : "";

  const modelOptions = useMemo(() => {
    const scoped = provider ? models.filter((entry) => entry.provider === provider) : models;
    return [...new Set(scoped.map((entry) => entry.model))].sort();
  }, [models, provider]);

  // With a provider chosen the model is always concrete: the first of that
  // provider's models until the operator picks another.
  // A hand-typed model id wins over the dropdown. It needs a provider, because a
  // custom id can only be called through a pinned provider's own credentials.
  const customId = provider ? customModel.trim() : "";

  // With a provider picked and no concrete model chosen, the model is "Auto".
  const providerAuto = Boolean(provider) && !customId && !modelOptions.includes(model);

  const selectedModel = customId || (model && modelOptions.includes(model) ? model : "");

  // Keys of the chosen provider that serve the chosen model, with their health.
  const keyOptions = useMemo(() => {
    if (!provider) return [];
    const byIndex = new Map();
    for (const entry of models) {
      if (entry.provider !== provider) continue;
      if (selectedModel && !customId && entry.model !== selectedModel) continue;
      if (!Number.isInteger(entry.keyIndex) || byIndex.has(entry.keyIndex)) continue;
      byIndex.set(entry.keyIndex, entry.status);
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, status]) => ({ index, status }));
  }, [models, provider, selectedModel, customId]);

  const pinnedKey = keyIndex !== "" && keyOptions.some((option) => option.index === Number(keyIndex))
    ? Number(keyIndex)
    : null;

  const sendBlocked = custom ? customBlock !== null : (!autoRoute && selectedModel === "" && !providerAuto);

  const pickProvider = (value) => {
    setProvider(value);
    setModel("");
    setCustomModel("");
    setKeyIndex("");
    if (value) setAutoRoute(false);
  };

  const pickModel = (value) => {
    setModel(value);
    setCustomModel("");
    setKeyIndex("");
    if (value) setAutoRoute(false);
  };

  const pickKey = (value) => {
    setKeyIndex(value);
    if (value !== "") setAutoRoute(false);
  };

  const toggleRotateModels = (checked) => {
    setRotateModels(checked);
    try { window.localStorage.setItem(ROTATE_KEY, checked ? "1" : "0"); } catch { /* not persisted */ }
  };

  const toggleAutoRoute = (checked) => {
    setAutoRoute(checked);
    if (checked) {
      setProvider("");
      setModel("");
      setCustomModel("");
      setKeyIndex("");
    }
  };

  // The conversation survives a refresh: it is restored from this browser's
  // storage and saved again whenever a reply finishes. Clearing it (New chat)
  // removes the saved copy too.
  const [messages, setMessages] = useState(() => loadChat());
  const saveWarnedRef = useRef(false);

  useEffect(() => {
    if (messages.some((message) => message.pending)) return;
    const result = saveChat(messages);
    if (result !== "saved" && !saveWarnedRef.current) {
      saveWarnedRef.current = true;
      toast.error(
        result === "failed" ? "Chat not saved" : "Images not saved",
        { detail: result === "failed"
          ? "This browser's storage is full or blocked, so the chat will be lost on refresh."
          : "Storage is nearly full, so the text is kept but attached images are not." }
      );
    }
  }, [messages, toast]);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState(null);
  const abortRef = useRef(null);

  // Phone layout: the request settings live in a bottom sheet. On a wide
  // screen the same markup is a fixed side rail and this flag does nothing.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const transcriptRef = useRef(null);
  const promptRef = useRef(null);

  // Landing on Custom endpoint with nothing filled in (including the automatic
  // switch when no provider is configured) opens the settings sheet straight
  // away, so the operator is not left staring at a disabled Send button.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || !custom || !customBlock) return;
    autoOpenedRef.current = true;
    setSettingsOpen(true);
  }, [custom, customBlock]);

  // Follow the reply as it streams in, but only while the reader is at the
  // bottom: scrolling up to re-read must not be yanked back down.
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, meta]);

  // The page stays mounted while the operator is elsewhere, so a reply keeps streaming in. A hidden list loses its
  // scroll position, so remember it and put it back when the page is shown again.
  const pageActive = usePageActive();
  const scrollTopRef = useRef(0);
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!pageActive || !el) return;
    el.scrollTop = stickRef.current ? el.scrollHeight : scrollTopRef.current;
  }, [pageActive]);

  const lastTopRef = useRef(0);
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const near = el.scrollHeight - top - el.clientHeight < 80;
    stickRef.current = nextStick(stickRef.current, near, top < lastTopRef.current - 1);
    lastTopRef.current = top;
    scrollTopRef.current = top;
    setAtBottom(stickRef.current);
  };

  // The on-screen keyboard opening or closing, or the prompt box resizing, changes the transcript's height.
  // Keep following the reply through it instead of leaving the view stranded mid-reply.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return undefined;
    const repin = () => { if (stickRef.current) el.scrollTop = el.scrollHeight; };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(repin) : null;
    observer?.observe(el);
    window.visualViewport?.addEventListener("resize", repin);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener("resize", repin);
    };
  }, []);

  const jumpToBottom = () => {
    const el = transcriptRef.current;
    if (!el) return;
    stickRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // The prompt box grows with its content, up to a cap, instead of showing a
  // fixed three-row block that eats the phone screen.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setSettingsOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  const addImages = useCallback(async (fileList) => {
    const files = Array.from(fileList ?? []);
    let count = images.length;
    const added = [];
    for (const file of files) {
      const problem = imageProblem(file, count);
      if (problem) {
        toast.error("Image not attached", { detail: problem });
        continue;
      }
      try {
        added.push(await readImageFile(file));
        count += 1;
      } catch (error) {
        toast.error("Image not attached", { detail: error?.message });
      }
    }
    if (added.length > 0) setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
  }, [images.length, custom, toast]);

  const removeImage = (id) => setImages((current) => current.filter((image) => image.id !== id));

  const onPaste = (event) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const onDrop = (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const send = useCallback(async (override) => {
    const text = (override?.text ?? prompt).trim();
    const attached = override?.images ?? images;
    if (!text && attached.length === 0) return;
    if (sendBlocked) return;
    stickRef.current = true;
    setAtBottom(true);

    // Everything said so far goes along with the new prompt, so the model
    // remembers the conversation. No limit on how far back it reaches.
    const history = override?.history ?? buildHistory(messages);

    const startedAt = Date.now();
    setBusy(true);
    setMeta(null);

    const userMessage = { id: `u-${Date.now()}`, role: "user", text, images: attached };
    const assistantId = `a-${Date.now()}`;
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", text: "", pending: true }
    ]);
    if (!override) {
      setPrompt("");
      setImages([]);
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let smoother = null;

    try {
      const body = buildRequestBody({
        protocol: activeProtocol,
        model: custom ? customModelName.trim() : selectedModel,
        autoRoute: custom ? false : autoRoute || providerAuto,
        prompt: text,
        images: attached,
        history,
        system: systemPrompt.trim() || null,
        temperature: temperature === null ? null : Number(temperature),
        maxTokens: custom ? customMaxTokens(activeProtocol, maxTokens) : parseMaxTokens(maxTokens),
        stream: true
      });

      // Text is revealed a few characters per frame instead of per network
      // chunk, so the reply flows smoothly rather than arriving in jumps.
      smoother = createSmoothStream((visible) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: visible, pending: true }
              : message
          )
        );
      });
      const onDelta = (delta) => smoother.push(delta);

      const result = custom
        ? await sendCustomRequest({
          protocol: activeProtocol,
          baseUrl: customBase,
          apiKey: customKey,
          model: customModelName,
          body,
          signal: controller.signal,
          onDelta
        })
        : await sendPlaygroundRequest({
          protocol: activeProtocol,
          // Gemini carries the model in the URL, not the body, so it is passed
          // explicitly; otherwise a pinned or custom model would never be sent.
          model: !autoRoute && selectedModel ? selectedModel : undefined,
          body,
          headers: buildPinHeaders({
            autoRoute,
            provider,
            keyIndex: pinnedKey,
            customModel: customId !== "",
            rotate: providerAuto && rotateModels,
            rotateAfter: providerAuto && rotateModels ? lastModels[provider] : "",
            preferModel: providerAuto && !rotateModels ? lastModels[provider] : ""
          }),
          signal: controller.signal,
          onDelta
        });

      // Let the reveal catch up with what the network already delivered.
      await smoother.drain();

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, text: result.text || message.text, pending: false }
            : message
        )
      );

      // Auto model: remember which of the provider's models actually answered.
      if (!custom && providerAuto && result.routed?.model) {
        const next = { ...lastModels, [provider]: result.routed.model };
        setLastModels(next);
        try { window.localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(next)); } catch { /* not persisted */ }
      }

      setMeta({
        ...result.routed,
        latencyMs: Date.now() - startedAt,
        tokens: result.tokens ?? null,
        finishReason: result.finishReason ?? null,
        requestedModel: custom ? customModelName.trim() : autoRoute || providerAuto ? null : selectedModel || null,
        pinnedProvider: !custom && !autoRoute && provider ? provider : null,
        pinnedKey: !custom && !autoRoute && provider ? pinnedKey : null,
        autoRouted: !custom && autoRoute,
        custom
      });
    } catch (error) {
      const cancelled = error?.kind === "abort";
      // Show everything received so far before the error / stop state.
      smoother?.flush();

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, pending: false, error: cancelled ? null : error, text: message.text }
            : message
        )
      );

      if (!cancelled) {
        toast.error(error?.label ?? "Request failed", { detail: custom ? (error?.message ?? error?.hint) : (error?.hint ?? error?.message) });
        setMeta((current) => ({ ...(current ?? {}), error: { label: error?.label, hint: error?.hint, message: error?.message, status: error?.status } }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [prompt, images, messages, activeProtocol, selectedModel, customId, provider, providerAuto, rotateModels, lastModels, pinnedKey, autoRoute, systemPrompt, temperature, maxTokens, sendBlocked, custom, customBase, customKey, customModelName, toast]);

  const cancel = () => abortRef.current?.abort();

  const newChat = () => {
    setMessages([]);
    setMeta(null);
    stickRef.current = true;
    setAtBottom(true);
  };

  // Regenerate re-sends the last prompt and replaces its reply.
  const regenerate = () => {
    if (busy) return;
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    // Images restored from storage no longer carry their upload data, so only
    // images still held in memory can be sent again.
    const resend = (lastUser.images ?? []).filter((image) => image.data && image.mimeType);
    if (!lastUser.text && resend.length === 0) return;
    const cut = messages.lastIndexOf(lastUser);
    setMessages((current) => current.slice(0, cut));
    void send({ text: lastUser.text, images: resend, history: buildHistory(messages.slice(0, cut)) });
  };

  const pickSuggestion = (text) => {
    setPrompt(text);
    promptRef.current?.focus();
  };

  const sourceToggle = (
    <div className="chips chips--segmented chips--source" role="group" aria-label="Where to send the request">
      <button type="button" className={`chip${!custom ? " is-active" : ""}`} aria-pressed={!custom} onClick={() => setSourcePick("gateway")} disabled={busy}>Router</button>
      <button type="button" className={`chip${custom ? " is-active" : ""}`} aria-pressed={custom} onClick={() => { setSourcePick("custom"); if (customProblem({ baseUrl: customBase, model: customModelName })) setSettingsOpen(true); }} disabled={busy}>Custom endpoint</button>
    </div>
  );

  if (!custom && catalog.loading && models.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Playground" description="Send a real request through the gateway router" actions={sourceToggle} />
        <div className="panel"><div className="panel__body"><div className="skeleton skeleton--title" /></div></div>
      </div>
    );
  }

  if (!custom && models.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Playground" description="Send a real request through the gateway router" actions={sourceToggle} />
        <div className="panel">
          <EmptyState title="No routable targets" icon="terminal">
            Configure at least one provider with an API key, models and a base URL before sending
            requests, or switch to Custom endpoint to test any base URL, key and model directly.
          </EmptyState>
        </div>
      </div>
    );
  }

  const routeSummary = custom
    ? `${customHost || "No base URL"} · ${customModelName.trim() || "no model"}`
    : autoRoute
    ? "Auto route"
    : provider
      ? `${providerLabel(provider)}${pinnedKey !== null ? ` · key ${pinnedKey + 1}` : ""} · ${providerAuto ? "Auto" : selectedModel}`
      : selectedModel ? `Prefers ${selectedModel}` : "First available target";

  return (
    <div className="page page--playground">
      <PageHeader
        title="Playground"
        description={custom ? "Test any API key, base URL and model" : "Send a real request through the gateway router"}
        lastUpdatedAt={catalog.lastUpdatedAt}
        refreshing={catalog.refreshing}
        actions={
          <>
          {sourceToggle}
          <button
            type="button"
            className="btn"
            onClick={newChat}
            disabled={busy || messages.length === 0}
            aria-label="New chat"
          >
            <Icon name="plus" className="btn__icon" size={12} />
            <span className="btn__label">New chat</span>
          </button>
          </>
        }
      />

      <div className="playground">
        <section className="panel pg-chat" aria-label="Conversation">
          <div className="pg-scroll">
          <div className="pg-transcript" ref={transcriptRef} onScroll={onTranscriptScroll} role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="pg-hero">
                <div className="pg-hero__mark"><Icon name="sparkles" size={22} /></div>
                <h2 className="pg-hero__title">What can I help with?</h2>
                <p className="pg-hero__hint">
                  {custom
                    ? "Fill in the base URL, API key and model in Settings, then send a prompt. One request goes straight to that endpoint — no routing, no fallback."
                    : "Write a prompt below and send it. The request travels through the gateway's own router, so health ranking, cooldown and fallback all apply."}
                </p>
                <div className="pg-suggest">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" className="pg-suggest__btn" onClick={() => pickSuggestion(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="transcript">
                {messages.map((message, index) => {
                  const isLast = index === messages.length - 1;

                  if (message.role === "user") {
                    return (
                      <article key={message.id} className="msg msg--user">
                        {message.images?.length ? (
                          <div className="msg__images">
                            {message.images.map((image) => (
                              <img key={image.id} className="msg__image" src={image.dataUrl} alt={image.name} />
                            ))}
                          </div>
                        ) : null}
                        {!message.images?.length && message.imageCount ? (
                          <div className="msg__body dim">{message.imageCount} image{message.imageCount === 1 ? "" : "s"} not saved</div>
                        ) : null}
                        {message.text ? <div className="msg__body">{message.text}</div> : null}
                      </article>
                    );
                  }

                  return (
                    <article key={message.id} className={`msg msg--assistant${message.error ? " msg--error" : ""}`}>
                      <div className="msg__avatar" aria-hidden="true"><Icon name="sparkles" size={14} /></div>
                      <div className="msg__content">
                        {message.text ? (
                          <Markdown
                            text={message.text}
                            trailing={message.pending ? <span className="stream-cursor" aria-label="streaming" /> : null}
                          />
                        ) : message.pending ? (
                          <span className="typing" role="status" aria-label="Thinking"><i /><i /><i /></span>
                        ) : !message.error ? (
                          <span className="dim">Provider returned an empty response.</span>
                        ) : null}
                        {message.error ? <ErrorState error={message.error} compact /> : null}
                        {!message.pending && !message.error && message.text ? (
                          <div className="msg__actions">
                            <CopyAction text={message.text} />
                            {isLast ? <MessageAction label="Regenerate" icon="refresh" onClick={regenerate} disabled={busy} /> : null}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}

                {meta && !busy ? (
                  <div className="pg-meta">
                    {meta.error ? (
                      <StatusBadge tone="danger" dot={false}>{meta.error.label ?? "Request failed"}</StatusBadge>
                    ) : (
                      <>
                      <span className="mono pg-meta__target">
                          {meta.provider ? providerLabel(meta.provider) : EMPTY} · {meta.model ?? EMPTY}
                        </span>
                        {meta.status ? (
                          <StatusBadge tone={meta.status < 400 ? "ok" : "danger"} dot={false}>{meta.status}</StatusBadge>
                        ) : null}
                        <span>{formatLatency(meta.latencyMs)}</span>
                        {Number.isFinite(meta.tokens) ? <span>{formatTokens(meta.tokens)}</span> : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {!atBottom && messages.length > 0 ? (
            <button type="button" className="pg-jump" onClick={jumpToBottom} aria-label="Jump to latest message">
              <Icon name="arrowDown" size={16} />
            </button>
          ) : null}
          </div>

          <div className="pg-composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
            <div className="pg-composer__inner">
            {hasImages ? (
              <div className="attachments">
                {images.map((image) => (
                  <div key={image.id} className="attachment">
                    <img className="attachment__thumb" src={image.dataUrl} alt={image.name} />
                    <button
                      type="button"
                      className="attachment__remove"
                      aria-label={`Remove ${image.name}`}
                      onClick={() => removeImage(image.id)}
                      disabled={busy}
                    >×</button>
                  </div>
                ))}
              </div>
            ) : null}
            {custom && customBlock ? (
              <span className="tiny" style={{ color: "var(--warn)" }}>{customBlock}</span>
            ) : null}

            <div className="pg-box">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                multiple
                hidden
                onChange={(event) => {
                  void addImages(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="pg-circle"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || images.length >= MAX_IMAGES}
                aria-label={`Attach image (up to ${MAX_IMAGES})`}
                title={`Attach up to ${MAX_IMAGES} images`}
              >
                <Icon name="plus" size={18} />
              </button>
              <label className="sr-only" htmlFor="pg-prompt">Prompt</label>
              <textarea
                id="pg-prompt"
                ref={promptRef}
                className="textarea"
                rows={1}
                placeholder="Ask something…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={onPaste}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter sends; Shift+Enter keeps its newline. Ctrl/Cmd+Enter
                  // still sends too. An Enter that confirms an IME candidate
                  // (Bengali, Japanese, ...) is composition, not a send.
                  if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
                  if (event.shiftKey && !(event.ctrlKey || event.metaKey)) return;
                  event.preventDefault();
                  if (!busy) void send();
                }}
              />
              {busy ? (
                <button type="button" className="pg-circle pg-circle--send" onClick={cancel} aria-label="Cancel request">
                  <Icon name="stop" size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="pg-circle pg-circle--send"
                  onClick={() => void send()}
                  disabled={sendBlocked || (prompt.trim().length === 0 && !hasImages)}
                  aria-label="Send"
                >
                  <Icon name="arrowUp" size={18} />
                </button>
              )}
            </div>

            <div className="pg-route">
              {custom ? <StatusBadge tone="info" dot={false}>Custom</StatusBadge> : <span className="tiny dim mono">Auto Route</span>}
              <span className="pg-route__text" title={routeSummary}>{routeSummary}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm pg-route__edit"
                onClick={() => setSettingsOpen(true)}
                aria-haspopup="dialog"
              >
                <Icon name="sliders" className="btn__icon" size={12} />
                Settings
              </button>
            </div>
            </div>
          </div>
        </section>

        <aside className="pg-rail" data-open={settingsOpen} aria-label="Request settings">
          <button type="button" className="pg-rail__scrim" aria-label="Close settings" onClick={() => setSettingsOpen(false)} />
          <div className="pg-rail__sheet">
            <div className="pg-rail__head">
              <span className="panel__title">Request settings</span>
              <button type="button" className="btn btn--sm" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
            <div className="panel pg-settings">
          <div className="panel__header"><span className="panel__title">{custom ? "Custom endpoint" : "Routing"}</span></div>
          <div className="panel__body">
            <div className="stack">
              {custom ? (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-base">Base URL</label>
                    <input
                      id="pg-c-base"
                      className="input mono"
                      type="url"
                      inputMode="url"
                      value={customBase}
                      placeholder="https://api.openai.com/v1"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setCustomBase(event.target.value)}
                    />
                    <span className="field__hint">
                      The platform&apos;s API root. The endpoint path (/chat/completions, /messages …) is added for you.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-key">API key</label>
                    <div className="row" style={{ gap: "var(--sp-2)" }}>
                      <input
                        id="pg-c-key"
                        className="input mono grow"
                        type={showKey ? "text" : "password"}
                        value={customKey}
                        placeholder="sk-… (leave blank for a local model)"
                        autoComplete="new-password"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) => setCustomKey(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-pressed={showKey}
                        onClick={() => setShowKey((current) => !current)}
                      >
                        {showKey ? "Hide" : "Show"}
                      </button>
                    </div>
                    <span className="field__hint">
                      A test sends it once to your gateway for that call and never saves or logs it. To keep an endpoint, add it on the Custom Endpoints page.
                    </span>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-model">Model</label>
                    <input
                      id="pg-c-model"
                      className="input mono"
                      type="text"
                      value={customModelName}
                      placeholder="gpt-4o-mini"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => setCustomModelName(event.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="pg-c-protocol">API style</label>
                    <select
                      id="pg-c-protocol"
                      className="select"
                      value={activeProtocol}
                      onChange={(event) => setProtocol(event.target.value)}
                    >
                      {protocols.map((value) => <option key={value} value={value}>{protocolLabel(value)}</option>)}
                    </select>
                    <span className="field__hint">
                      OpenAI Chat fits most platforms (OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama …).
                    </span>
                  </div>

                </>
              ) : (
              <>
              <label className="checkbox">
                <input type="checkbox" checked={autoRoute} onChange={(event) => toggleAutoRoute(event.target.checked)} />
                Auto Route — let the gateway pick the target
              </label>

              <div className="field">
                <label className="field__label" htmlFor="pg-provider">Provider</label>
                <select
                  id="pg-provider"
                  className="select"
                  value={provider}
                  onChange={(event) => pickProvider(event.target.value)}
                >
                  <option value="">Any provider</option>
                  {providerOptions.map((value) => <option key={value} value={value}>{providerLabel(value)}</option>)}
                </select>
                <span className="field__hint">
                  {provider
                    ? `Only ${providerLabel(provider)} is called — never another provider.`
                    : "Pick a provider to call it directly."}
                </span>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pg-model">Model</label>
                <select
                  id="pg-model"
                  className="select"
                  value={customId ? "" : providerAuto ? AUTO_MODEL : selectedModel}
                  onChange={(event) => pickModel(event.target.value === AUTO_MODEL ? "" : event.target.value)}
                >
                  {customId ? <option value="">Custom model in use</option> : null}
                  {provider && !customId ? <option value={AUTO_MODEL}>Auto — try this provider's models in turn</option> : null}
                  {provider ? null : <option value="">First available</option>}
                  {modelOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <input
                  id="pg-custom-model"
                  className="input mono"
                  type="text"
                  value={customModel}
                  placeholder="Custom model id (optional)"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="Custom model id"
                  onChange={(event) => {
                    const value = event.target.value;
                    // A custom id can only be called through one provider's own
                    // credentials, so typing one with no provider picks the first.
                    if (value.trim() && !provider && providerOptions.length > 0) setProvider(providerOptions[0]);
                    setCustomModel(value);
                    setKeyIndex("");
                    if (value.trim()) setAutoRoute(false);
                  }}
                  style={{ marginTop: "var(--sp-2)" }}
                />
                <span className="field__hint">
                  {customId
                    ? `Trying "${customId}" on ${providerLabel(provider)} with its own key and base URL. Clear the box to use the list.`
                    : providerAuto
                    ? `Auto: if a model fails, the next ${providerLabel(provider)} model is tried. No other provider is used.`
                    : provider
                    ? `Models served by ${providerLabel(provider)}. Or type any new model id above to try it.`
                    : autoRoute
                      ? "Auto Route is on — no model is sent. Pick one to switch it off."
                      : "The gateway prefers this model on any provider and may fall back."}
                </span>
              </div>

              {providerAuto ? (
                <label className="checkbox">
                  <input type="checkbox" checked={rotateModels} onChange={(event) => toggleRotateModels(event.target.checked)} />
                  {rotateModels
                    ? "Round-robin — each request starts at the next model"
                    : "Remember the model that worked — try it first next time"}
                </label>
              ) : null}

              {provider && keyOptions.length > 1 ? (
                <div className="field">
                  <label className="field__label" htmlFor="pg-key">API key</label>
                  <select
                    id="pg-key"
                    className="select"
                    value={pinnedKey ?? ""}
                    onChange={(event) => pickKey(event.target.value)}
                  >
                    <option value="">Any key (gateway picks)</option>
                    {keyOptions.map((option) => (
                      <option key={option.index} value={option.index}>
                        {`Key ${option.index + 1}${option.status ? ` — ${option.status}` : ""}`}
                      </option>
                    ))}
                  </select>
                  <span className="field__hint">
                    {pinnedKey === null
                      ? `${providerLabel(provider)} keys are tried in health order.`
                      : `Only key ${pinnedKey + 1} is used, even if it is cooling down.`}
                  </span>
                </div>
              ) : null}
              </>
              )}

              <details className="pg-advanced">
                <summary>{custom ? "Advanced: temperature, max tokens, system prompt" : "Advanced: protocol, temperature, system prompt"}</summary>
                <div className="stack">
              {custom ? null : (
              <div className="field">
                <label className="field__label" htmlFor="pg-protocol">Protocol</label>
                <select
                  id="pg-protocol"
                  className="select"
                  value={activeProtocol}
                  onChange={(event) => setProtocol(event.target.value)}
                >
                  {protocols.map((value) => <option key={value} value={value}>{protocolLabel(value)}</option>)}
                </select>
              </div>
              )}

              <div className="row" style={{ gap: "var(--sp-3)" }}>
                <div className="field grow">
                  <label className="field__label" htmlFor="pg-temperature">
                    Temperature{" "}
                    <span className="mono">{temperature === null ? "provider default" : Number(temperature).toFixed(2)}</span>
                    {temperature === null ? null : (
                      <button type="button" className="btn btn--sm" style={{ marginLeft: "var(--sp-2)" }} onClick={() => setTemperature(null)}>
                        Use default
                      </button>
                    )}
                  </label>
                  <input
                    id="pg-temperature"
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={temperature ?? 0.7}
                    onChange={(event) => setTemperature(event.target.value)}
                  />
                </div>

                <div className="field" style={{ width: 110 }}>
                  <label className="field__label" htmlFor="pg-max-tokens">Max tokens</label>
                  <input
                    id="pg-max-tokens"
                    className="input mono"
                    type="number"
                    min="1"
                    placeholder={custom && activeProtocol === "anthropic" ? "1024" : "No limit"}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="pg-system">System prompt</label>
                <textarea
                  id="pg-system"
                  className="textarea"
                  rows={3}
                  placeholder="Optional system instruction…"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                />
              </div>
                </div>
              </details>
            </div>
          </div>
        </div>

          <div className="panel">
            <div className="panel__header">
              <span className="panel__title">Last request</span>
            </div>
            <div className="panel__body">
              {!meta ? (
                <span className="dim small">Metadata appears here after the first request.</span>
              ) : (
                <dl className="dl dl--tight">
                  {meta.custom ? null : (
                    <>
                      <dt className="dl__term">Routing mode</dt>
                      <dd className="dl__desc">{meta.modeLabel ?? meta.mode ?? <span className="dim">{EMPTY}</span>}</dd>
                    </>
                  )}

                  <dt className="dl__term">{meta.custom ? "Endpoint" : "Selected provider"}</dt>
                  <dd className="dl__desc">
                    {meta.custom
                      ? <span className="mono">{meta.upstreamHost ?? customHost ?? EMPTY}</span>
                      : meta.provider ? providerLabel(meta.provider) : <span className="dim">{EMPTY}</span>}
                  </dd>

                  <dt className="dl__term">Selected model</dt>
                  <dd className="dl__desc mono">{meta.model ?? EMPTY}</dd>

                  {meta.custom ? null : (
                    <>
                      <dt className="dl__term">Key index</dt>
                      <dd className="dl__desc mono">{Number.isInteger(meta.keyIndex) ? meta.keyIndex : EMPTY}</dd>

                      <dt className="dl__term">Request ID</dt>
                      <dd className="dl__desc mono tiny">{meta.sessionId ?? EMPTY}</dd>
                    </>
                  )}

                  <dt className="dl__term">HTTP status</dt>
                  <dd className="dl__desc">
                    {meta.status
                      ? <StatusBadge tone={meta.status < 400 ? "ok" : "danger"} dot={false}>{meta.status}</StatusBadge>
                      : EMPTY}
                  </dd>

                  <dt className="dl__term">Latency</dt>
                  <dd className="dl__desc">{formatLatency(meta.latencyMs)}</dd>

                  <dt className="dl__term">Token usage</dt>
                  <dd className="dl__desc">
                    {Number.isFinite(meta.tokens)
                      ? formatTokens(meta.tokens)
                      : <span className="dim" title="The provider's response did not report usage">not reported by provider</span>}
                  </dd>

                  <dt className="dl__term">Finish reason</dt>
                  <dd className="dl__desc">
                    {meta.finishReason ?? <span className="dim" title="The provider's response did not report a finish reason">not reported by provider</span>}
                  </dd>

                  <dt className="dl__term">Routing</dt>
                  <dd className="dl__desc">
                    {meta.custom
                      ? "custom endpoint — sent directly, no routing or fallback"
                      : meta.autoRouted
                      ? "auto — the gateway selected the target"
                      : meta.pinnedProvider
                        ? `pinned to ${providerLabel(meta.pinnedProvider)}${Number.isInteger(meta.pinnedKey) ? ` · key ${meta.pinnedKey + 1}` : ""} · ${meta.requestedModel ?? EMPTY}`
                        : `prefers ${meta.requestedModel ?? "first available"} — the gateway chose the provider`}
                  </dd>

                  {meta.error ? (
                    <>
                      <dt className="dl__term">Error</dt>
                      <dd className="dl__desc">
                        <ErrorState
                          error={{ label: meta.error.label, hint: meta.error.hint, message: meta.error.message }}
                          compact
                        />
                      </dd>
                    </>
                  ) : null}
                </dl>
              )}
            </div>
          </div>

          <div className="notice">
            <span>
              {custom ? "The call is made by your gateway, not the browser, and is not added to the request log. " : ""}
              Responses stream when the selected protocol supports it. Token usage and finish reason
              are shown only when the provider reports them — the gateway does not estimate.
            </span>
          </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
