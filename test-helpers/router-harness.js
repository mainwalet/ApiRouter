import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFreePort } from "./mock-upstream.js";

const SERVER_PATH = fileURLToPath(new URL("../src/server.js", import.meta.url));

/**
 * Boots a real `src/server.js` process with a controlled environment.
 * No real AI provider is ever contacted.
 */
export async function startRouter(env = {}) {
  const port = await getFreePort();
  // Routing configuration is persisted, so every router gets its own file. A
  // test must never read (or write) the developer's real chain, and no test may
  // seed another's — both would make the suite depend on the order it ran in.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "apirouter-config-"));

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.dirname(SERVER_PATH),
    env: {
      ...process.env,
      PORT: String(port),
      // Clear every provider so each test fully controls its own config.
      ...clearProviderEnv(),
      FALLBACK_CHAIN_FILE: path.join(configDir, "fallback-chain.json"),
      MANUAL_SELECTION_FILE: path.join(configDir, "manual-selection.json"),
      GATEWAY_STATE_FILE: path.join(configDir, "gateway-state.json"),
      EFFORT_STATE_FILE: path.join(configDir, "effort-state.json"),
      DISABLED_MODELS_FILE: path.join(configDir, "disabled-models.json"),
      CUSTOM_ENDPOINTS_FILE: path.join(configDir, "custom-endpoints.json"),
      MODEL_CONFIG_FILE: path.join(configDir, "model-config.json"),
      PROVIDER_MODELS_FILE: path.join(configDir, "provider-models.json"),
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });

  const exited = new Promise((resolve) => child.once("exit", resolve));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Router did not start.\nstdout: ${stdout}\nstderr: ${stderr}`)),
      10000
    );
    child.stdout.on("data", () => {
      if (stdout.includes("listening")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Router exited early (code ${code}).\nstderr: ${stderr}`));
    });
  });

  const baseUrl = `http://localhost:${port}`;

  // The startup health monitor fires immediately; let it settle so its
  // uniform success marks cannot interleave with a test's assertions.
  await new Promise((resolve) => setTimeout(resolve, 250));

  return {
    port,
    baseUrl,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exited,
    request: (pathname, options) => fetch(baseUrl + pathname, options),
    async close() {
      if (child.exitCode !== null) return;
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  };
}

const PROVIDER_IDS = [
  "AGENTROUTER", "GEMINI", "GROQ", "HUGGINGFACE", "MISTRAL",
  "OPENROUTER", "CEREBRAS", "CLOUDFLARE", "COHERE", "ZAI", "VERCEL", "OPENCODE", "NVIDIA", "POLLINATIONS", "LLM7", "UNOROUTER"
];

function clearProviderEnv() {
  const env = {};
  for (const id of PROVIDER_IDS) {
    env[`${id}_API_KEYS`] = "";
    env[`${id}_MODELS`] = "";
    env[`${id}_BASE_URL`] = "";
    for (const name of ["API_KEYS", "MODELS", "BASE_URL", "ACCOUNT_IDS"]) env[`${id}_VISION_${name}`] = "";
  }
  env.APIROUTER_API_KEYS = "";
  env.RETRY_STATUS_CODES = "";
  // An ambient SYSTEM_PROMPT / SYSTEM_PROMPT_FILE must not change what a test sends upstream.
  env.SYSTEM_PROMPT = "";
  env.SYSTEM_PROMPT_FILE = "";
  // The legacy routing sources. Cleared so an ambient variable on the
  // developer's machine can never seed or influence a test's routing; a test
  // that wants to exercise the migration sets them explicitly afterwards.
  env.TEXT_PRIORITY_MODELS = "";
  env.VISION_PRIORITY_MODELS = "";
  // Remote persistence must be opt-in per test. An ambient repository in the
  // developer's shell would otherwise make every test talk to GitHub.
  for (const name of ["REPO", "TOKEN", "BRANCH", "PATH", "API"]) {
    env[`CUSTOM_ENDPOINTS_GITHUB_${name}`] = "";
    env[`MODEL_CONFIG_GITHUB_${name}`] = "";
    env[`PROVIDER_MODELS_GITHUB_${name}`] = "";
  }
  return env;
}

export function postJson(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
