import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry, startHealthMonitor } from "../src/health.js";
import { FALLBACK_MODES, FALLBACK_MODE_INFO, normalizeMode, remembersSuccess } from "../src/fallback-chain.js";
import {
  PHASES,
  TARGET_RETRY_ALLOWANCE,
  buildRoutePlan,
  effectiveOrder,
  resetAutomaticOrderCache,
  routeOrder
} from "../src/fallback-plan.js";
import { RouteSession, STICKY_TTL_MS, withFallback } from "../src/router.js";

const MIN = 60 * 1000;
const t = (provider, model, keyIndex = 0) => ({ provider, model, keyIndex, protocols: ["openai-chat"] });
const entry = (provider, model, extra = {}) => ({ provider, model, keys: null, enabled: true, ...extra });
const fail = (status, extra = {}) => Object.assign(new Error(`boom ${status}`), { status, ...extra });
const label = (target) => `${target.provider}/${target.model}#${target.keyIndex}`;

/**
 * The scenario from the requirements. Provider names repeat on purpose: the
 * manual selection interleaves "gemini" with other providers, and "gemini" also
 * owns an UNSELECTED model (X). The target list is deliberately provider-grouped
 * and puts the unselected models first, so any code that grouped by provider or
 * followed list order instead of the saved order would visibly fail.
 */
const targets = [
  t("gemini", "X", 0), t("gemini", "X", 1),
  t("gemini", "A", 0), t("gemini", "A", 1),
  t("gemini", "C", 0), t("gemini", "C", 1),
  t("gemini", "E", 0), t("gemini", "E", 1),
  t("groq", "B", 0),
  t("mistral", "D", 0),
  t("openrouter", "Y", 0),
  t("cerebras", "Z", 0)
];
const selection = [
  entry("gemini", "A"),
  entry("groq", "B"),
  entry("gemini", "C"),
  entry("mistral", "D"),
  entry("gemini", "E")
];

const PHASE_TWO_ORDER = ["gemini/X#0", "gemini/X#1", "openrouter/Y#0", "cerebras/Z#0"];
const MANUAL_ORDER = [
  "gemini/A#0", "gemini/A#1",
  "groq/B#0",
  "gemini/C#0", "gemini/C#1",
  "mistral/D#0",
  "gemini/E#0", "gemini/E#1"
];

let cache = 0;
const plan = (overrides = {}) => {
  resetAutomaticOrderCache();
  return buildRoutePlan({
    targets,
    chain: selection,
    health: new HealthRegistry(),
    cacheKey: `manual-${(cache += 1)}`,
    ...overrides
  });
};
const phaseSteps = (p, phase) => p.steps.filter((step) => step.phase === phase);
const labels = (steps) => steps.map((step) => label(step.target));
const models = (steps) => [...new Set(steps.map((step) => `${step.target.provider}/${step.target.model}`))];

// ---------------------------------------------------------------------------
// Mode wiring
// ---------------------------------------------------------------------------

test("there is no mode switch any more: a saved selection is manual, an empty one is automatic", () => {
  assert.equal(FALLBACK_MODES.MANUAL, "manual");
  assert.equal(FALLBACK_MODES.AUTO, "auto");
  assert.equal(normalizeMode(" Manual "), "manual");
  // The two retired ids still resolve — to the mode that replaced them.
  assert.equal(normalizeMode("fixed"), "auto");
  assert.equal(normalizeMode("last-success"), "auto");
  // Whether a selection is saved or not, the last success now leads the next request.
  assert.equal(remembersSuccess(FALLBACK_MODES.MANUAL), true);
  assert.equal(remembersSuccess(FALLBACK_MODES.AUTO), true);
  // The mode surface offers exactly the two derived modes.
  assert.deepEqual(FALLBACK_MODE_INFO.map((info) => info.id), ["auto", "manual"]);
  assert.equal(FALLBACK_MODE_INFO.find((info) => info.id === "manual").label, "Manual Model Selection");
});

// ---------------------------------------------------------------------------
// PHASE 1 — the manual selection
// ---------------------------------------------------------------------------

test("phase 1 walks the selection in exactly the saved order, with providers interleaved", () => {
  const first = phaseSteps(plan(), PHASES.MANUAL);
  assert.deepEqual(labels(first), MANUAL_ORDER);
  // Gemini A -> Groq B -> Gemini C -> Mistral D -> Gemini E
  assert.deepEqual(models(first), ["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"]);
});

test("models of one provider are separate entries and are never grouped, sorted or reordered", () => {
  const first = phaseSteps(plan(), PHASES.MANUAL);
  const providers = models(first).map((id) => id.split("/")[0]);
  assert.deepEqual(providers, ["gemini", "groq", "gemini", "mistral", "gemini"]);

  // Reversing the saved order reverses the walk — nothing sorts the list.
  const reversed = phaseSteps(plan({ chain: [...selection].reverse() }), PHASES.MANUAL);
  assert.deepEqual(models(reversed), ["gemini/E", "mistral/D", "gemini/C", "groq/B", "gemini/A"]);
});

test("every eligible key of a selected model is listed before the next selected model", () => {
  const first = phaseSteps(plan(), PHASES.MANUAL);
  const firstTwo = labels(first).slice(0, 2);
  assert.deepEqual(firstTwo, ["gemini/A#0", "gemini/A#1"]);
  // Contiguity: once a model is left, it does not reappear within the phase.
  const seen = [];
  for (const step of first) {
    const id = `${step.target.provider}/${step.target.model}`;
    if (seen.at(-1) !== id) {
      assert.ok(!seen.includes(id), `${id} reappears inside phase 1`);
      seen.push(id);
    }
  }
});

// ---------------------------------------------------------------------------
// PHASE 2 — everything not selected, by health
// ---------------------------------------------------------------------------

test("phase 2 holds every model that was not selected, and none that was", () => {
  const second = phaseSteps(plan(), PHASES.HEALTH);
  assert.deepEqual(new Set(models(second)), new Set(["gemini/X", "openrouter/Y", "cerebras/Z"]));
  for (const selected of ["gemini/A", "groq/B", "gemini/C", "mistral/D", "gemini/E"]) {
    assert.ok(!models(second).includes(selected), `${selected} was manually selected`);
  }
});

test("an unselected model of a provider that IS in the selection stays eligible in phase 2", () => {
  const second = phaseSteps(plan(), PHASES.HEALTH);
  assert.ok(models(second).includes("gemini/X"), "gemini/X shares a provider with A, C and E but was not selected");
  // Excluding by provider would have dropped it; excluding by model must not.
  assert.deepEqual(labels(second).filter((id) => id.startsWith("gemini/")), ["gemini/X#0", "gemini/X#1"]);
});

test("phase 2 follows the existing health ordering: measured latency, then availability", () => {
  const health = new HealthRegistry();
  health.markSuccess(t("openrouter", "Y", 0), { latencyMs: 40 });
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 90 });
  health.markSuccess(t("gemini", "X", 0), { latencyMs: 400 });
  assert.deepEqual(models(phaseSteps(plan({ health }), PHASES.HEALTH)), ["openrouter/Y", "cerebras/Z", "gemini/X"]);

  // A model with every key cooling down drops behind the available ones, whatever its latency.
  health.markFailure(t("openrouter", "Y", 0), 500, { cooldownMs: MIN });
  assert.deepEqual(models(phaseSteps(plan({ health }), PHASES.HEALTH)), ["cerebras/Z", "gemini/X", "openrouter/Y"]);
});

test("an unmeasured router orders phase 2 by configuration order, deterministically", () => {
  const a = labels(phaseSteps(plan(), PHASES.HEALTH));
  const b = labels(phaseSteps(plan(), PHASES.HEALTH));
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["gemini/X#0", "gemini/X#1", "openrouter/Y#0", "cerebras/Z#0"]);
});

test("every key of a fallback model is listed before the next fallback model", () => {
  const second = labels(phaseSteps(plan(), PHASES.HEALTH));
  assert.deepEqual(second.slice(0, 2), ["gemini/X#0", "gemini/X#1"]);
});

test("a parked (disabled) entry and a key the operator excluded never reach phase 2", () => {
  const chain = [
    entry("gemini", "A", { keys: [1] }),     // key 0 deliberately excluded
    entry("groq", "B"),
    entry("gemini", "C", { keys: [9] }),     // narrowed to a key that does not exist
    entry("mistral", "D"),
    entry("gemini", "E", { enabled: false }) // parked
  ];
  const p = plan({ chain });

  const everything = labels(p.steps);
  assert.ok(!everything.includes("gemini/A#0"), "an excluded key is never attempted in any phase");
  assert.ok(everything.includes("gemini/A#1"));
  for (const parked of ["gemini/E#0", "gemini/E#1", "gemini/C#0", "gemini/C#1"]) {
    assert.ok(!everything.includes(parked), `${parked} must stay out of every phase`);
  }
  assert.deepEqual(labels(phaseSteps(p, PHASES.MANUAL)), ["gemini/A#1", "groq/B#0", "mistral/D#0"]);
  assert.deepEqual(new Set(models(phaseSteps(p, PHASES.HEALTH))), new Set(["gemini/X", "openrouter/Y", "cerebras/Z"]));
});

// ---------------------------------------------------------------------------
// PHASE 3 — one final manual pass
// ---------------------------------------------------------------------------

test("the plan alternates Manual -> Health -> Manual -> Health, later rounds flagged as retries", () => {
  const p = plan();
  const manualRetry = phaseSteps(p, PHASES.MANUAL_RETRY);
  const healthRetry = phaseSteps(p, PHASES.HEALTH_RETRY);
  assert.deepEqual(labels(manualRetry), MANUAL_ORDER, "the retry round keeps the saved order");
  assert.deepEqual(labels(healthRetry), PHASE_TWO_ORDER, "and the same health order as the first health batch");
  assert.ok([...manualRetry, ...healthRetry].every((step) => step.retry === true));
  assert.ok(p.steps.filter((step) => step.retry !== true).every((step) => [PHASES.MANUAL, PHASES.HEALTH].includes(step.phase)));

  // Collapsed, the plan reads MANUAL, HEALTH, MANUAL, HEALTH.
  const collapsed = p.steps.map((step) => step.phase).filter((phase, index, all) => phase !== all[index - 1]);
  assert.deepEqual(collapsed, [PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY, PHASES.HEALTH_RETRY]);
  assert.equal(p.steps.length, (MANUAL_ORDER.length + PHASE_TWO_ORDER.length) * (1 + TARGET_RETRY_ALLOWANCE));
});

test("the retry rounds list exactly the same targets as the first rounds: nothing new, nothing reordered", () => {
  const p = plan();
  const first = p.steps.filter((step) => step.retry !== true).map((step) => label(step.target));
  const later = p.steps.filter((step) => step.retry === true).map((step) => label(step.target));
  assert.deepEqual(later, first);
});

test("the plan never lists a target twice within one phase", () => {
  const dup = [...targets, t("gemini", "A", 0), t("gemini", "X", 1)];
  const p = plan({ targets: dup });
  for (const phase of [PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY, PHASES.HEALTH_RETRY]) {
    const ids = labels(phaseSteps(p, phase));
    assert.equal(new Set(ids).size, ids.length, `${phase} has a duplicate`);
  }
});

// ---------------------------------------------------------------------------
// Where manual routing must NOT apply
// ---------------------------------------------------------------------------

test("with no selection saved the router uses the plain automatic order and has no phases", () => {
  const p = plan({ chain: [] });
  assert.equal(p.source, "auto");
  assert.ok(p.steps.every((step) => step.phase === PHASES.AUTO && step.retry !== true));
});

test("a selection that cannot serve the request fails closed", () => {
  const p = plan({ chain: [entry("nobody", "Ghost")] });
  assert.equal(p.failClosed, true);
  assert.deepEqual(p.steps, [], "phase 2 must not substitute for a selection that cannot be honoured");
});

test("a pinned request ignores the selection: strict, no phases, no retry", () => {
  const pin = [t("mistral", "D", 0)];
  const p = plan({ targets: pin, pinned: true });
  assert.deepEqual(labels(p.steps), ["mistral/D#0"]);
  assert.ok(p.steps.every((step) => step.phase === PHASES.CHAIN && step.retry !== true));
});

test("a remembered target that IS selected leads the walk", () => {
  // E is the last entry in the selection: on the next request it moves to the front.
  const p = plan({ stickyTargetId: "gemini:E:key-1" });
  assert.equal(label(p.sticky), "gemini/E#1");
  assert.equal(p.steps[0].phase, PHASES.STICKY);
  assert.equal(label(p.steps[0].target), "gemini/E#1");
  // The rest of E's keys, then the remaining selection, follow in saved order.
  assert.deepEqual(labels(p.steps.slice(0, 2)), ["gemini/E#1", "gemini/E#0"]);
});

test("a remembered target that is NOT selected leads the Health batch, ahead of the selection", () => {
  // X is served by gemini but was never selected: it is a Health model, and it
  // answered last, so the Health batch is walked first and the selection after it.
  const p = plan({ stickyTargetId: "gemini:X:key-1" });
  assert.equal(label(p.sticky), "gemini/X#1");
  assert.equal(p.steps[0].phase, PHASES.STICKY);
  assert.equal(label(p.steps[0].target), "gemini/X#1");
  const firstManual = p.steps.findIndex((step) => step.phase === PHASES.MANUAL);
  const lastHealthLike = p.steps.findLastIndex((step) => step.phase === PHASES.STICKY || step.phase === PHASES.HEALTH);
  assert.ok(firstManual > lastHealthLike, "no selected model is tried before the Health batch has been exhausted");
});

test("one shared selection orders every model, capability-narrowed or not", () => {
  const text = [t("p", "T1", 0), t("q", "T2", 0), t("p", "T3", 0)];
  const image = [t("p", "V1", 0), t("q", "V2", 0)];
  const chain = [entry("q", "T2"), entry("p", "T1"), entry("q", "V2")];

  // A text request sees every model; the single chain orders all of them.
  const textOrder = routeOrder([...text, ...image], { chain, health: new HealthRegistry() }).map(label);
  assert.deepEqual(textOrder.slice(0, 3), ["q/T2#0", "p/T1#0", "q/V2#0"], "the selection leads, in its saved order");
  assert.deepEqual([...textOrder.slice(3)].sort(), ["p/T3#0", "p/V1#0"], "unselected models follow the selection");

  // An image request has been narrowed (by capability) to the image-capable
  // models only: the SAME chain applies, and no incapable model leaks in.
  const imageOrder = routeOrder(image, { chain, health: new HealthRegistry() }).map(label);
  assert.deepEqual(imageOrder, ["q/V2#0", "p/V1#0"], "only capable models are routed, still in chain order");
});

// ---------------------------------------------------------------------------
// The walker over the alternating batches
// ---------------------------------------------------------------------------

/** Walks a manual plan, recording every call; `behavior(id, count)` decides each outcome. */
async function walkManual(behavior, { health = new HealthRegistry(), chain = selection, onSkip = null } = {}) {
  const p = plan({ health, chain });
  const calls = [];
  const counts = new Map();
  const phases = [];
  let result;
  let error = null;
  try {
    result = await withFallback(
      targets,
      async (target, { phase }) => {
        const id = label(target);
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        calls.push(id);
        phases.push(phase);
        return behavior(id, n, target);
      },
      new Set([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503]),
      new RouteSession(),
      health,
      { plan: p.steps, onSkip, remember: false }
    );
  } catch (caught) {
    error = caught;
  }
  return { calls, counts, phases, result, error, health };
}

const PHASE_TWO = ["gemini/X#0", "gemini/X#1", "openrouter/Y#0", "cerebras/Z#0"];

test("Manual and Health alternate, in order, while permitted targets remain, then the request fails", async () => {
  const { calls, error, phases } = await walkManual(() => { throw fail(500); });
  assert.deepEqual(calls, [...MANUAL_ORDER, ...PHASE_TWO, ...MANUAL_ORDER, ...PHASE_TWO]);
  assert.equal(error.status, 502);
  assert.deepEqual(
    phases.filter((phase, index, all) => phase !== all[index - 1]),
    [PHASES.MANUAL, PHASES.HEALTH, PHASES.MANUAL_RETRY, PHASES.HEALTH_RETRY],
    "the walker reports which batch every call belonged to"
  );
});

test("termination is per target: every target is called at most 1 + the retry allowance, and the walk ends", async () => {
  const { counts } = await walkManual(() => { throw fail(500); });
  for (const id of [...MANUAL_ORDER, ...PHASE_TWO]) {
    assert.equal(counts.get(id), 1 + TARGET_RETRY_ALLOWANCE, `${id}: first attempt + its retry allowance`);
  }
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 24, "no infinite loop, no stray duplicates");
});

test("a Health target that failed transiently is retried in the second Health batch, in the same order", async () => {
  const { calls, counts } = await walkManual((id, n) => {
    if (id === "cerebras/Z#0" && n === 2) return "recovered";
    throw fail(503);
  });
  assert.equal(counts.get("cerebras/Z#0"), 2);
  // A Gemini 503 is model-wide, so the model's other keys are not tried (in either round).
  const firstKeys = (list) => list.filter((id) => !/^gemini\/[A-Z]#[1-9]/.test(id));
  assert.deepEqual(calls, [...firstKeys(MANUAL_ORDER), ...firstKeys(PHASE_TWO), ...firstKeys(MANUAL_ORDER), ...firstKeys(PHASE_TWO)],
    "second Manual batch ran in full before the second Health batch, which stopped at the success");
});

test("a Health target that failed for a credential or request reason is never retried", async () => {
  const { counts } = await walkManual((id) => {
    if (id === "openrouter/Y#0") throw fail(401);
    if (id === "cerebras/Z#0") throw fail(404);
    throw fail(500);
  });
  assert.equal(counts.get("openrouter/Y#0"), 1);
  assert.equal(counts.get("cerebras/Z#0"), 1);
  assert.equal(counts.get("gemini/X#0"), 2, "its transient siblings still get their one retry");
});

test("a refusal that skips health tracking (e.g. an image the target cannot carry) is not retried", async () => {
  const { counts, health } = await walkManual((id) => {
    if (id === "groq/B#0") throw fail(400, { skipCooldown: true, retryable: true });
    throw fail(500);
  });
  assert.equal(counts.get("groq/B#0"), 1, "same request, same refusal: retrying would only repeat it");
  assert.ok(health.isAvailable(t("groq", "B", 0)), "and it was never cooled down");
});

test("a new round alone never authorises a retry: a target nobody cooled is not replayed unless it failed transiently", async () => {
  // Success is the only way a target is 'finished' without a cooldown, and that ends the walk.
  const { calls } = await walkManual((id) => { throw fail(id.startsWith("gemini/") ? 401 : 500); });
  // Gemini key 0 and key 1 are both rejected as credentials: one call per key in the whole request.
  assert.equal(calls.filter((id) => id === "gemini/A#0").length, 1);
  assert.equal(calls.filter((id) => id === "gemini/A#1").length, 1);
});

test("a success in any later batch ends routing immediately", async () => {
  const { calls, result } = await walkManual((id, n) => {
    if (id === "mistral/D#0" && n === 2) return "second-manual-batch";
    throw fail(500);
  });
  assert.equal(result, "second-manual-batch");
  const lastIndex = calls.length - 1;
  assert.equal(calls[lastIndex], "mistral/D#0");
  assert.equal(calls.filter((id) => id === "mistral/D#0").length, 2);
  assert.ok(!calls.slice(lastIndex + 1).length, "nothing after the success");
});

test("the Health batch order is fixed for the whole request, even if measurements change while it runs", async () => {
  const health = new HealthRegistry();
  health.markSuccess(t("openrouter", "Y", 0), { latencyMs: 40 });
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 90 });
  health.markSuccess(t("gemini", "X", 0), { latencyMs: 400 });
  const { calls } = await walkManual((id) => {
    // Mid-request the measurements flip. The plan was built once, so this must not reorder anything.
    health.markSuccess(t("gemini", "X", 0), { latencyMs: 1 });
    throw fail(500);
  }, { health });
  const firstHealth = calls.filter((id) => !MANUAL_ORDER.includes(id));
  assert.deepEqual(firstHealth.slice(0, 4), ["openrouter/Y#0", "cerebras/Z#0", "gemini/X#0", "gemini/X#1"]);
});

test("a health refresh changes the Health order of the NEXT request only when the measurements warrant it", () => {
  const health = new HealthRegistry();
  health.markSuccess(t("openrouter", "Y", 0), { latencyMs: 40 });
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 90 });
  const before = models(phaseSteps(plan({ health }), PHASES.HEALTH));
  // A refresh that finds the same ordering of numbers does not move anything.
  health.markSuccess(t("openrouter", "Y", 0), { latencyMs: 41 });
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 91 });
  assert.deepEqual(models(phaseSteps(plan({ health }), PHASES.HEALTH)), before, "effectively the same measurements, same order");
  // A refresh that finds cerebras now faster does.
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 5 });
  assert.deepEqual(models(phaseSteps(plan({ health }), PHASES.HEALTH)).slice(0, 2), ["cerebras/Z", "openrouter/Y"]);
});

test("a health refresh never clears a cooldown or makes a cooling target callable", async () => {
  const health = new HealthRegistry();
  health.markFailure(t("openrouter", "Y", 0), 500);
  const before = health.get(health.key(t("openrouter", "Y", 0))).cooldownUntil;
  health.markSuccess(t("cerebras", "Z", 0), { latencyMs: 5 }); // a refresh of someone else
  assert.equal(health.get(health.key(t("openrouter", "Y", 0))).cooldownUntil, before);
  const { calls } = await walkManual(() => { throw fail(500); }, { health });
  assert.ok(!calls.includes("openrouter/Y#0"), "still cooling, so never called, in any batch");
});

test("a success in phase 1 stops the walk: phase 2 and 3 are never reached", async () => {
  const { calls, result } = await walkManual((id) => (id === "mistral/D#0" ? "ok" : (() => { throw fail(500); })()));
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["gemini/A#0", "gemini/A#1", "groq/B#0", "gemini/C#0", "gemini/C#1", "mistral/D#0"]);
});

test("phase 2 starts only after the whole selection failed, and phase 3 only after phase 2 did", async () => {
  const { calls, result } = await walkManual((id) => (id === "openrouter/Y#0" ? "fallback" : (() => { throw fail(500); })()));
  assert.equal(result, "fallback");
  assert.deepEqual(calls, [...MANUAL_ORDER, "gemini/X#0", "gemini/X#1", "openrouter/Y#0"]);
  assert.ok(!calls.slice(MANUAL_ORDER.length).some((id) => MANUAL_ORDER.includes(id)), "no manual target before phase 2 ends");
});

test("the final pass can still recover a target whose first failure was transient", async () => {
  const { calls, result, counts } = await walkManual((id, n) => {
    if (id === "gemini/E#0" && n === 2) return "recovered";
    throw fail(503);
  });
  assert.equal(result, "recovered");
  assert.equal(counts.get("gemini/E#0"), 2);
  // Gemini's other keys are skipped after a 503, so the original order has no key 1 entries.
  const expected = MANUAL_ORDER.filter((id) => !/^gemini\/[A-Z]#[1-9]/.test(id));
  assert.deepEqual(calls.slice(-expected.length), expected, "phase 3 walked the original order up to the success");
});

test("targets that fail for a non-transient reason are not retried in a later batch", async () => {
  const { counts } = await walkManual((id) => {
    if (id === "groq/B#0") throw fail(404);   // the model is gone
    if (id === "mistral/D#0") throw fail(429); // transient: worth a second look
    throw fail(500);
  });
  assert.equal(counts.get("groq/B#0"), 1, "a 404 would only fail the same way again");
  assert.equal(counts.get("mistral/D#0"), 2, "a 429 is transient and gets its one retry");
});

test("a rejected request (400) is never forced through a second time, and still surfaces as a 400", async () => {
  const { calls, error } = await walkManual(() => { throw fail(400); });
  assert.deepEqual(calls, [...MANUAL_ORDER, ...PHASE_TWO], "phase 3 retries nothing: every 400 is a genuine cooldown");
  assert.equal(error.status, 400);
});

test("a 401 cools that key's other models too and is never retried", async () => {
  const { calls, counts } = await walkManual((id) => {
    if (id === "gemini/A#0") throw fail(401);
    throw fail(500);
  });
  assert.equal(counts.get("gemini/A#0"), 1, "a 401 would only fail the same way again");
  // A 401 describes the credential, so the same key's other models are cooled with it.
  for (const id of ["gemini/C#0", "gemini/E#0", "gemini/X#0"]) {
    assert.ok(!calls.includes(id), `${id} shares key 0 with the failing 401 and must not be tried`);
  }
  // Key 1 is a different credential and is unaffected.
  assert.equal(counts.get("gemini/A#1"), 2);
});

test("a cooldown that existed before the request is genuine: never attempted, never forced", async () => {
  const health = new HealthRegistry();
  health.markFailure(t("groq", "B", 0), 500); // already cooling when the request arrives
  const skips = [];
  const { calls } = await walkManual(() => { throw fail(500); }, { health, onSkip: (target, info) => skips.push(`${label(target)}:${info.reason}`) });
  assert.ok(!calls.includes("groq/B#0"), "not attempted in any phase, including the final pass");
  assert.deepEqual(skips.filter((entry) => entry.startsWith("groq/B#0")), ["groq/B#0:cooldown"], "reported once");
});

test("a cooldown someone else refreshed during the request is not looked past either", async () => {
  const health = new HealthRegistry();
  const { counts } = await walkManual((id) => {
    // While phase 2 is running, another request puts gemini/A key 0 on a fresh, longer cooldown.
    if (id === "cerebras/Z#0") health.markFailure(t("gemini", "A", 0), 500, { cooldownMs: 99 * MIN });
    throw fail(500);
  }, { health });
  assert.equal(counts.get("gemini/A#0"), 1, "a genuine, newer cooldown beats the final pass");
  assert.equal(counts.get("gemini/A#1"), 2, "its sibling key is untouched and retried once");
});

test("when every target is already cooling, nothing is called and the existing 503 is returned", async () => {
  const health = new HealthRegistry();
  for (const target of targets) health.markFailure(target, 500);
  const { calls, error } = await walkManual(() => "never", { health });
  assert.equal(calls.length, 0, "the final pass does not force requests to genuinely ineligible targets");
  assert.equal(error.status, 503);
});

test("a retried target that fails again gets a fresh cooldown and is not called a third time", async () => {
  const health = new HealthRegistry();
  const { counts } = await walkManual(() => { throw fail(502); }, { health });
  for (const id of MANUAL_ORDER) assert.ok(counts.get(id) <= 2);
  assert.ok(!health.isAvailable(t("gemini", "A", 0)), "the failure is still on record");
});

test("the retry of a target succeeds and clears its cooldown", async () => {
  const health = new HealthRegistry();
  await walkManual((id, n) => {
    if (id === "gemini/A#0" && n === 2) return "ok";
    throw fail(500);
  }, { health });
  assert.ok(health.isAvailable(t("gemini", "A", 0)), "a success is the one thing that ends a cooldown early");
});

test("a plan that lists a target twice still walks it once, never retried", async () => {
  const p = buildRoutePlan({ targets, chain: selection, health: new HealthRegistry(), cacheKey: "dup" });
  // The first pass, listed twice: the walker must still attempt each target once.
  const first = p.steps.filter((step) => step.retry !== true);
  const doubled = [...first, ...first];
  const calls = [];
  const skips = [];
  await assert.rejects(withFallback(
    targets,
    async (target) => { calls.push(label(target)); throw fail(500); },
    new Set([500]),
    new RouteSession(),
    new HealthRegistry(),
    { plan: doubled, onSkip: (target, info) => skips.push(info.reason), remember: false }
  ));
  assert.deepEqual(calls, [...MANUAL_ORDER, ...PHASE_TWO], "the existing once-per-request rule is untouched");
  assert.ok(skips.includes("already_attempted"));
});

test("effectiveOrder shows each target once, in phase order", () => {
  const order = effectiveOrder(plan().steps);
  assert.deepEqual(order.map((step) => label(step.target)), [...MANUAL_ORDER, ...PHASE_TWO]);
});

// ---------------------------------------------------------------------------
// Health and cooldown timing — each constant tested on its own
// ---------------------------------------------------------------------------

test("the default model cooldown is exactly 12 minutes", () => {
  const registry = new HealthRegistry();
  assert.equal(registry.cooldownMs, 12 * MIN);
  const now = 1_000_000;
  registry.markFailure(t("a", "A"), 500, {}, now);
  assert.equal(registry.get("a:A:key-0").cooldownUntil, now + 12 * MIN);
});

test("a custom cooldown override still wins, per registry and per failure", () => {
  const registry = new HealthRegistry({ cooldownMs: 5_000 });
  registry.markFailure(t("a", "A"), 500, {}, 1_000);
  assert.equal(registry.get("a:A:key-0").cooldownUntil, 6_000);
  registry.markFailure(t("a", "B"), 500, { cooldownMs: 42 }, 1_000);
  assert.equal(registry.get("a:B:key-0").cooldownUntil, 1_042);
});

test("status-specific cooldowns are unchanged: 400 is 8 minutes, 408 is 1 minute, 413 is 5 minutes", async () => {
  const cases = [[400, 8 * MIN], [408, 1 * MIN], [413, 5 * MIN], [500, 12 * MIN]];
  for (const [status, expected] of cases) {
    const health = new HealthRegistry();
    const target = t("solo", `M${status}`);
    const before = Date.now();
    await assert.rejects(withFallback(
      [target],
      async () => { throw fail(status); },
      new Set([status]),
      new RouteSession(),
      health,
      { remember: false }
    ));
    const after = Date.now();
    const until = health.get(health.key(target)).cooldownUntil;
    assert.ok(until >= before + expected && until <= after + expected, `${status}: expected ${expected}ms, got ${until - before}ms`);
  }
});

test("the automatic health-check interval is exactly 12 minutes, independent of the cooldown", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let cycles = 0;
    const check = async () => { cycles += 1; return { ok: true, status: 200, latencyMs: 1 }; };
    const stop = startHealthMonitor([t("a", "A")], check);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 1, "one cycle runs immediately");

    mock.timers.tick(12 * MIN - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 1, "nothing runs before 12 minutes");

    mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cycles, 2, "the next cycle runs at exactly 12 minutes");
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("the remembered-session TTL is a separate setting and is still 20 minutes", () => {
  assert.equal(STICKY_TTL_MS, 20 * MIN);
  assert.equal(new RouteSession().ttlMs, 20 * MIN);
});
