import { CAPABILITY_IDS } from "./model-capabilities.js";

/**
 * What a request actually needs.
 *
 * Routing must be decided from the request, never from the model name. This
 * module reads the endpoint, the payload and the protocol semantics and reports
 * the capabilities a candidate must have before a payload is sent to it:
 * modalities in content parts, tools/functions, response-format settings,
 * requested output modalities, and streaming.
 *
 * It is deliberately conservative. A capability is required only when the
 * payload unambiguously needs it:
 *
 *   - an image/audio/video/file content part, in any protocol's own shape
 *   - a non-empty `tools` / `functions` list
 *   - an explicit structured-output setting (`response_format`, Responses
 *     `text.format`, Gemini `responseSchema`/`responseMimeType`)
 *   - an explicit generated-media modality (`modalities`,
 *     `responseModalities`, an image `response_format`)
 *   - `stream: true`, or the Gemini streaming method
 *
 * `reasoning` is a PREFERENCE, not a requirement: most requests that carry a
 * reasoning control are still perfectly servable by a model without one, and
 * hard-filtering would remove working routes. It is reported separately.
 *
 * The gateway only serves the chat-shaped routes today. The non-chat operations
 * are still classified — the capability layer, the router and the tests share
 * one vocabulary — and the server answers an unsupported endpoint with its
 * existing 404 rather than pretending a chat model can produce an embedding.
 */

const IMAGE_TYPES = new Set(["image", "image_url", "input_image"]);
const AUDIO_TYPES = new Set(["audio", "input_audio", "audio_url"]);
const VIDEO_TYPES = new Set(["video", "video_url", "input_video"]);
const FILE_TYPES = new Set(["file", "input_file", "document"]);


const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function mimeOf(value) {
  if (!isObject(value)) return "";
  const raw = value.mimeType ?? value.mime_type ?? value.media_type ?? value.mediaType ?? "";
  return typeof raw === "string" ? raw.toLowerCase() : "";
}

function kindFromMime(mime) {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  // Everything else that arrives as a file attachment is a file.
  return "file";
}

/**
 * Classifies one content part. Only positions the supported protocols define as
 * content are inspected by the caller, never arbitrary JSON: `{type:"image"}`
 * inside a tool call's arguments is a value the model produced, not an upload.
 */
export function partMediaKind(part) {
  if (!isObject(part)) return null;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (IMAGE_TYPES.has(type)) return "image";
  if (AUDIO_TYPES.has(type)) return "audio";
  if (VIDEO_TYPES.has(type)) return "video";
  if (FILE_TYPES.has(type)) return "file";

  for (const key of ["inlineData", "inline_data", "fileData", "file_data"]) {
    const kind = kindFromMime(mimeOf(part[key]));
    if (kind) return kind;
  }
  for (const key of ["source", "audio", "video", "image_url", "input_audio", "input_file", "file"]) {
    const kind = kindFromMime(mimeOf(part[key]));
    if (kind) return kind;
  }
  return null;
}

function addMedia(media, kind) {
  if (kind) media[kind] = true;
}

function walkContent(content, media) {
  if (!isObject(content) && !Array.isArray(content)) return;
  const parts = Array.isArray(content) ? content : [content];
  for (const part of parts) {
    if (!isObject(part)) continue;
    addMedia(media, partMediaKind(part));
    // Nested tool-result content is a real attachment, exactly as in vision.js.
    if (part.type === "tool_result") walkContent(part.content, media);
    if (isObject(part.functionResponse)) walkContent(part.functionResponse.parts, media);
    if (isObject(part.function_response)) walkContent(part.function_response.parts, media);
  }
}

function walkEntry(entry, media) {
  if (!isObject(entry)) return;
  addMedia(media, partMediaKind(entry));
  walkContent(entry.content, media);
  walkContent(entry.output, media);
  walkContent(entry.parts, media);
}

/**
 * Every media kind the body carries, in any supported client protocol.
 * Returns `{ image, audio, video, file }` booleans.
 */
export function collectRequestMedia(body) {
  const media = { image: false, audio: false, video: false, file: false };
  if (!isObject(body)) return media;

  for (const field of ["messages", "input", "contents"]) {
    const value = body[field];
    if (Array.isArray(value)) value.forEach((entry) => walkEntry(entry, media));
    else walkEntry(value, media);
  }
  for (const field of ["system", "systemInstruction", "system_instruction"]) {
    walkContent(body[field], media);
    walkEntry(body[field], media);
  }
  return media;
}

/** The operation an endpoint names, independent of which routes exist today. */
export function requestOperation(pathname, protocol = null) {
  const path = String(pathname || "");
  if (path === "/v1/embeddings" || path.endsWith("/embeddings")) return "embeddings";
  if (path === "/v1/images/generations") return "image_generation";
  if (path === "/v1/audio/speech") return "audio_generation";
  if (path === "/v1/audio/transcriptions") return "audio_transcription";
  if (path === "/v1/audio/translations") return "audio_translation";
  if (path === "/v1/realtime" || path.endsWith("/realtime")) return "realtime_audio";
  if (path === "/v1/rerank" || path.endsWith("/rerank")) return "reranking";
  if (path === "/v1/moderations" || path.endsWith("/moderations")) return "moderation";
  if (protocol) return "chat";
  return "unknown";
}

/**
 * A tool the CLIENT executes: a function/custom tool, anything carrying a
 * schema, or a Gemini functionDeclarations group. Provider-side server tools
 * (web_search, googleSearch...) have none of these. A client function
 * that merely happens to be NAMED web_search is still a client tool.
 */
function isClientTool(tool) {
  if (!isObject(tool)) return false;
  const type = typeof tool.type === "string" ? tool.type.toLowerCase() : "";
  if (type === "function" || type === "custom") return true;
  // Anthropic-defined tools the CLIENT executes carry no schema: bash_20250124, text_editor_20250728 ...
  if (/^(bash|text_editor)_\d/.test(type)) return true;
  if (isObject(tool.input_schema) || isObject(tool.parameters) || isObject(tool.function)) return true;
  return Array.isArray(tool.functionDeclarations) || Array.isArray(tool.function_declarations);
}

function serverToolRequirements(tools) {
  const required = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool) && typeof tool !== "string") continue;
    if (isClientTool(tool)) continue;
    const type = String(isObject(tool) ? tool.type ?? "" : "").toLowerCase();
    const name = String(isObject(tool) ? tool.name ?? "" : tool).toLowerCase();
    const marker = `${type} ${name}`;
    if (/file[_-]?search/.test(marker)) required.add("file_search");
    if (/computer([_-]?use)?/.test(marker) || type.startsWith("computer_") || name === "computer") required.add("computer_use");
    // Gemini declares server tools as an empty object key.
    if (isObject(tool?.fileSearch) || isObject(tool?.file_search)) required.add("file_search");
  }
  return required;
}

function structuredOutputRequested(body) {
  const format = body?.response_format?.type ?? body?.text?.format?.type ?? null;
  if (format === "json_schema" || format === "json_object" || format === "image") return format;
  const config = body?.generationConfig ?? body?.generation_config;
  if (isObject(config)) {
    if (isObject(config.responseSchema) || isObject(config.response_schema)) return "json_schema";
    if (String(config.responseMimeType ?? config.response_mime_type ?? "").toLowerCase() === "application/json") return "json_object";
  }
  return null;
}

function requestedOutputKinds(body) {
  const out = new Set();
  const modalities = [
    ...(Array.isArray(body?.modalities) ? body.modalities : []),
    ...(Array.isArray(body?.output_modalities) ? body.output_modalities : [])
  ];
  const config = body?.generationConfig ?? body?.generation_config;
  if (Array.isArray(config?.responseModalities)) modalities.push(...config.responseModalities);
  if (Array.isArray(config?.response_modalities)) modalities.push(...config.response_modalities);

  for (const raw of modalities) {
    const value = String(raw ?? "").toLowerCase();
    if (value === "image") out.add("image_output");
    if (value === "audio") out.add("audio_output");
  }
  if (body?.response_format?.type === "image") out.add("image_output");
  return out;
}

function reasoningRequested(body) {
  if (!isObject(body)) return false;
  if (body.reasoning !== undefined && body.reasoning !== null && body.reasoning !== false) return true;
  if (body.reasoning_effort !== undefined) return true;
  if (body.thinking !== undefined && body.thinking !== false) return true;
  if (body.enable_thinking !== undefined) return true;
  const config = body.generationConfig ?? body.generation_config;
  return isObject(config?.thinkingConfig) || isObject(config?.thinking_config);
}

const orderCapabilities = (set) => CAPABILITY_IDS.filter((id) => set.has(id));

// A base64 payload is not text: counting its characters at 4 per token would make
// a 1 MB image look like ~250,000 tokens and wrongly rule out every smaller model.
// Each payload is replaced by a bounded estimate instead (about 750 base64
// characters per token, capped), the same figure /v1/messages/count_tokens uses.
const MEDIA_CHARS_PER_TOKEN = 750;
const MEDIA_TOKEN_CAP = 8000;
const MIN_INLINE_MEDIA_CHARS = 1000;

/** The request fields that carry what the model reads, in every supported client protocol. */
const PROMPT_FIELDS = [
  "system", "messages", "tools", "functions", "tool_config", "toolConfig",
  "input", "instructions", "contents", "systemInstruction", "system_instruction"
];

/**
 * A cheap estimate of the INPUT tokens a request carries: the prompt, the system
 * prompt and the tool definitions, at about 4 characters per token. It is used
 * to keep a request away from a model whose declared context limit is smaller,
 * so it is deliberately an estimate, never a count: it must not be precise
 * enough to be mistaken for billing, and it must never over-count media.
 *
 * Only the prompt fields are measured (generation settings and metadata are not
 * part of the context), and the output budget (`max_tokens`) is not added: the
 * limit a gateway can hold a request to is the one it can actually measure.
 */
export function estimateRequestTokens(body) {
  if (!isObject(body)) return 0;
  const prompt = {};
  for (const field of PROMPT_FIELDS) {
    if (body[field] !== undefined) prompt[field] = body[field];
  }
  if (Object.keys(prompt).length === 0) return 0;

  let mediaTokens = 0;
  const addMedia = (length) => { mediaTokens += Math.min(Math.ceil(length / MEDIA_CHARS_PER_TOKEN), MEDIA_TOKEN_CAP); };
  let text = "";
  try {
    text = JSON.stringify(prompt, (key, value) => {
      if (typeof value !== "string") return value;
      // Anthropic `source.data`, Gemini `inlineData.data`, OpenAI `input_audio.data`.
      if (key === "data" && value.length >= MIN_INLINE_MEDIA_CHARS) { addMedia(value.length); return ""; }
      // An inline `data:` URL (OpenAI image_url, Responses input_image).
      if (value.startsWith("data:") && value.length >= MIN_INLINE_MEDIA_CHARS) { addMedia(value.length); return ""; }
      return value;
    }) || "";
  } catch {
    // A body that cannot be serialized (a cycle) has no measurable size.
    return 0;
  }
  return Math.ceil(text.length / 4) + mediaTokens;
}

/**
 * Analyses one request.
 *
 * @returns {{
 *   operation: string,
 *   required: string[],
 *   preferred: string[],
 *   media: {image:boolean,audio:boolean,video:boolean,file:boolean},
 *   stream: boolean,
 *   reasons: string[],
 *   estimatedInputTokens: number
 * }}
 */
export function analyzeRequest({ protocol = null, pathname = "", body = {}, stream = false } = {}) {
  const operation = requestOperation(pathname, protocol);
  const media = collectRequestMedia(body);
  const required = new Set();
  const preferred = new Set();
  const reasons = [];

  if (operation === "embeddings") {
    required.add("embeddings");
  } else if (operation === "image_generation") {
    required.add("image_output");
  } else if (operation === "audio_generation") {
    required.add("audio_output");
  } else if (operation === "audio_transcription") {
    required.add("audio_transcription");
  } else if (operation === "audio_translation") {
    required.add("audio_translation");
  } else if (operation === "realtime_audio") {
    required.add("realtime_audio");
  } else if (operation === "reranking") {
    required.add("reranking");
  } else if (operation === "moderation") {
    required.add("moderation");
  } else {
    // Chat-shaped routes (and anything unknown that still reached a chat bridge).
    required.add("text_input");
    required.add("text_output");
  }

  if (media.image) { required.add("image_input"); reasons.push("image content part"); }
  if (media.audio) { required.add("audio_input"); reasons.push("audio content part"); }
  if (media.video) { required.add("video_input"); reasons.push("video content part"); }
  if (media.file) { required.add("file_input"); reasons.push("file content part"); }

  const tools = Array.isArray(body?.tools) ? body.tools : Array.isArray(body?.functions) ? body.functions : [];
  if (tools.length > 0) {
    reasons.push("tools");
    // Only server tools a target must run natively (file_search, computer_use) are requirements.
    // Others (web search, code execution...) are passed through or dropped by the bridges and
    // never decide routing.
    let needsToolCalling = tools.some(isClientTool);
    for (const id of serverToolRequirements(tools)) {
      required.add(id);
      needsToolCalling = true;
    }
    if (needsToolCalling) required.add("tool_calling");
  }

  const format = structuredOutputRequested(body);
  if (format === "json_schema" || format === "json_object") {
    required.add("structured_output");
    reasons.push(`response_format:${format}`);
  }

  for (const id of requestedOutputKinds(body)) {
    required.add(id);
    reasons.push(`requested output:${id.replace("_output", "")}`);
  }

  if (reasoningRequested(body)) preferred.add("reasoning");

  const wantsStream = stream === true
    || body?.stream === true
    || (protocol === "gemini" && /:streamGenerateContent$/i.test(String(pathname || "")));
  if (wantsStream) { required.add("streaming"); reasons.push("streaming"); }

  return {
    operation,
    required: orderCapabilities(required),
    preferred: orderCapabilities(preferred),
    media,
    stream: wantsStream,
    reasons,
    estimatedInputTokens: estimateRequestTokens(body)
  };
}
