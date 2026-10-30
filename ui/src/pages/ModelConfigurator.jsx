import { useMemo, useState } from "react";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { FilterBar, FilterSelect } from "../components/ui/FilterBar.jsx";
import { SearchInput } from "../components/ui/SearchInput.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { Drawer, Modal } from "../components/ui/Overlays.jsx";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.jsx";
import { Icon } from "../components/ui/Icon.jsx";
import { useApi } from "../hooks/useApi.js";
import { useToast } from "../context/ToastContext.jsx";
import {
  bulkUpdateModelCapabilities,
  createModelConfig,
  getModelConfig,
  refreshModelConfig,
  removeModelConfig,
  updateModelConfig
} from "../api/modelConfig.js";
import {
  adapterSupportState,
  availabilityNote,
  buildDraftPayload,
  bulkCapabilityCoverage,
  bulkPreview,
  bulkTargets,
  canRemoveModel,
  capabilityGroups,
  capabilityState,
  editorFromRow,
  formatTokenCount,
  filterModels,
  findModelRow,
  normalizeModelConfigPayload,
  providerChoices,
  rowTone,
  selectionLabel,
  toggleCapability
} from "../lib/modelConfig.js";
import { providerLabel, protocolLabel } from "../lib/format.js";

/**
 * Unified Model Configurator.
 *
 * One page for the model facts that determine whether a provider/model may be
 * routed at all, and which modalities and controls it really has. Every model
 * is one row with its declared capabilities — text and vision are capabilities
 * on the model, not separate routing systems.
 *
 * The checkbox says what the operator DECLARES. A second, separate signal says
 * what an adapter can EXECUTE. A capability with no wire form (`image_output`,
 * for example) can be ticked and is honestly reported as "declared, no adapter",
 * so the page can never make a model look capable of something the gateway
 * cannot send.
 */
export default function ModelConfigurator() {
  const config = useApi(getModelConfig, { intervalMs: 30_000 });
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(null);
  const [status, setStatus] = useState(null);
  const [source, setSource] = useState(null);
  const [busy, setBusy] = useState(false);

  const [editor, setEditor] = useState(null); // { mode, row, draft }
  const [removing, setRemoving] = useState(null);
  const [formError, setFormError] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const view = useMemo(() => normalizeModelConfigPayload(config.data), [config.data]);
  const groups = useMemo(() => capabilityGroups(view.schema), [view.schema]);
  const filtered = useMemo(
    () => filterModels(view.models, { search, provider, status, source }),
    [view.models, search, provider, status, source]
  );
  const providers = useMemo(() => providerChoices(view.models), [view.models]);

  const run = async (action, success) => {
    setBusy(true);
    try {
      await action();
      await config.reload();
      toast.success(success);
    } catch (failure) {
      toast.error(failure?.message || "Request failed");
    } finally {
      setBusy(false);
    }
  };

  /** A row without a saved declaration is configured first, then switched. */
  const toggleEnabled = async (row) => {
    setBusy(true);
    try {
      if (row.stored && row.configId) {
        await updateModelConfig(row.configId, { enabled: !row.enabled });
      } else {
        await createModelConfig({
          provider: row.provider,
          model: row.model,
          capabilities: row.capabilities,
          enabled: !row.enabled
        });
      }
      await config.reload();
      toast.success(`${row.model} ${row.enabled ? "switched off" : "switched on"}`);
    } catch (failure) {
      toast.error(failure?.message || "Could not change the model switch");
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (row) => {
    setFormError(null);
    setEditor(editorFromRow(row));
  };

  const openCreate = () => {
    setFormError(null);
    setEditor(editorFromRow(null));
  };

  const saveEditor = async () => {
    if (!editor) return;
    if (editor.mode === "edit" && !editor.row?.configId) {
      setFormError(new Error("This declaration has no saved id; reload the page and try again."));
      return;
    }
    setBusy(true);
    setFormError(null);
    const payload = buildDraftPayload(editor.draft);
    try {
      if (editor.mode === "create") {
        await createModelConfig({
          provider: editor.draft.provider,
          model: editor.draft.model,
          ...payload
        });
      } else {
        await updateModelConfig(editor.row.configId, payload);
      }
      setEditor(null);
      await config.reload();
      toast.success("Model configuration saved");
    } catch (failure) {
      setFormError(failure);
    } finally {
      setBusy(false);
    }
  };

  /** One request, one saved document: every chosen model changes or none does. */
  const applyBulk = async ({ rows, add, remove }) => {
    setBusy(true);
    try {
      const result = await bulkUpdateModelCapabilities({ models: bulkTargets(rows), add, remove });
      setBulkOpen(false);
      await config.reload();
      const changed = Number(result?.changed ?? 0);
      toast.success(
        changed > 0
          ? `Capabilities updated on ${changed} ${changed === 1 ? "model" : "models"}`
          : "Every chosen model already matched; nothing to save"
      );
    } catch (failure) {
      // Keep the dialog open: the operator's choices are still in it.
      toast.error(failure?.message || "Could not update the capabilities");
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing?.configId) { setRemoving(null); return; }
    setBusy(true);
    try {
      await removeModelConfig(removing.configId);
      setRemoving(null);
      await config.reload();
      toast.success("Model declaration removed");
    } catch (failure) {
      toast.error(failure?.message || "Could not remove the model declaration");
    } finally {
      setBusy(false);
    }
  };

  const columns = useMemo(() => [
    {
      key: "model",
      header: "Model",
      sortable: true,
      get: (row) => row.model,
      render: (row) => (
        <span className="stack" style={{ gap: 2 }}>
          <span className="mono truncate table__truncate" title={row.model}>{row.displayName || row.model}</span>
          <span className="tiny dim nowrap">{providerLabel(row.provider)}</span>
        </span>
      )
    },
    {
      key: "source",
      header: "Source",
      sortable: true,
      get: (row) => row.source,
      render: (row) => (
        <StatusBadge tone={row.stored ? "info" : "neutral"} dot={false} title={
          row.stored
            ? "Saved declaration: its capabilities replace what the environment implies"
            : "Inferred from the provider configuration; no declaration saved yet"
        }>
          {row.stored ? "Configured" : "Environment"}
        </StatusBadge>
      )
    },
    {
      key: "enabled",
      header: "Routing",
      sortable: true,
      get: (row) => (row.enabled ? 1 : 0),
      render: (row) => {
        const note = availabilityNote(row);
        return (
          <span className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className={`btn btn--sm ${row.enabled ? "" : "btn--ghost"}`}
              aria-pressed={row.enabled}
              disabled={busy || row.disabledByProvider}
              title={row.disabledByProvider ? note : row.enabled ? "Switch this model off" : "Switch this model on"}
              onClick={(event) => { event.stopPropagation(); toggleEnabled(row); }}
            >
              {row.enabled ? "On" : "Off"}
            </button>
            {!row.enabled && note ? <span className="tiny dim" title={note}>why?</span> : null}
          </span>
        );
      }
    },
    {
      key: "capabilities",
      header: "Declared capabilities",
      get: (row) => row.capabilities.join(","),
      render: (row) => (
        <div className="row row--wrap" style={{ gap: "var(--sp-2)", alignItems: "center" }}>
          <CapabilityChips row={row} />
          {(() => {
            const missingStreaming = !row.capabilities.includes("streaming");
            const missingTools = !row.capabilities.includes("tool_calling");
            if (!missingStreaming && !missingTools) return null;
            const label = missingStreaming && missingTools
              ? "Declare streaming + tool calling"
              : missingStreaming
                ? "Declare streaming"
                : "Declare tool calling";
            const toastMessage = missingStreaming && missingTools
              ? "Declared streaming + tool calling"
              : missingStreaming
                ? "Declared streaming"
                : "Declared tool calling";
            return (
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  run(async () => {
                    const toAdd = [];
                    if (missingStreaming) toAdd.push("streaming");
                    if (missingTools) toAdd.push("tool_calling");
                    const next = [...new Set([...row.capabilities, ...toAdd])];
                    if (row.stored && row.configId) {
                      await updateModelConfig(row.configId, { capabilities: next });
                    } else {
                      await createModelConfig({
                        provider: row.provider,
                        model: row.model,
                        capabilities: next,
                        enabled: row.enabled
                      });
                    }
                    await config.reload();
                    toast.success(toastMessage);
                  });
                }}
              >
                {label}
              </button>
            );
          })()}
        </div>
      )
    },
    {
      key: "contextLimit",
      header: "Context limit",
      sortable: true,
      get: (row) => row.contextLimit ?? 0,
      render: (row) => row.contextLimit
        ? (
          <span className="mono nowrap" title={`${row.contextLimit.toLocaleString("en-US")} tokens. Requests larger than this skip this model.`}>
            {formatTokenCount(row.contextLimit)}
          </span>
        )
        : <span className="tiny dim" title="No limit declared: this model is never skipped for request size.">not set</span>
    },
    {
      key: "selection",
      header: "Manual selection",
      get: (row) => selectionLabel(row),
      render: (row) => {
        const label = selectionLabel(row);
        return label
          ? <StatusBadge tone="ok" dot={false}>{label}</StatusBadge>
          : <span className="tiny dim">automatic</span>;
      }
    },
    {
      key: "warnings",
      header: "Attention",
      get: (row) => row.warnings.length,
      render: (row) => (
        <span className="row" style={{ gap: 4 }}>
          <StatusBadge
            tone={rowTone(row) === "off" ? "neutral" : rowTone(row) === "warn" ? "warn" : "ok"}
            dot={false}
            title={row.warnings.length > 0 ? row.warnings.join(" ") : undefined}
          >
            {rowTone(row) === "off" ? "off" : rowTone(row) === "warn" ? "check" : "ok"}
          </StatusBadge>
          {row.warnings.length > 0 ? <span className="tiny dim">{row.warnings.length}</span> : null}
        </span>
      )
    }
  ], [busy, rowTone]);

  if (config.loading && !config.data) {
    return (
      <div className="page">
        <PageHeader title="Model Configurator" description="Capabilities and routing switches for every model" />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={8} label="Loading model configuration" /></div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Model Configurator"
        description="One declaration per model: whether it may be routed, and which modalities and controls it really has."
        lastUpdatedAt={config.lastUpdatedAt}
        refreshing={config.refreshing}
        paused={config.paused}
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => refreshModelConfig(), "Model configuration reloaded")}
            >
              <Icon name="refresh" className="btn__icon" size={12} /><span className="btn__label">Reload</span>
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || view.models.length === 0}
              onClick={() => setBulkOpen(true)}
              title="Add or remove capabilities on many models at once"
            >
              <Icon name="plus" className="btn__icon" size={12} /><span className="btn__label">Bulk capabilities</span>
            </button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={openCreate}>
              <Icon name="plus" className="btn__icon" size={12} /><span className="btn__label">Add model</span>
            </button>
          </>
        }
      />

      {config.error ? <ErrorState error={config.error} onRetry={config.reload} compact /> : null}

      <StorageBanner storage={view.storage} revision={view.revision} updatedAt={view.updatedAt} />

      <div className="row row--wrap section" style={{ gap: "var(--sp-3)" }}>
        <StatusBadge tone="neutral" dot={false}>{view.summary.total} models</StatusBadge>
        <StatusBadge tone="info" dot={false}>{view.summary.configured} configured</StatusBadge>
        <StatusBadge tone="ok" dot={false}>{view.summary.enabled} enabled</StatusBadge>
        <StatusBadge tone={view.summary.disabled > 0 ? "warn" : "neutral"} dot={false}>
          {view.summary.disabled} switched off
        </StatusBadge>
        {view.summary.declaredUnsupported > 0 ? (
          <StatusBadge tone="warn" dot={false} title="Declared capabilities that no adapter can execute">
            {view.summary.declaredUnsupported} with unsupported capabilities
          </StatusBadge>
        ) : null}
      </div>

      {view.models.length === 0 ? (
        <EmptyState title="No models configured" icon="box">
          Configure a provider (or a custom endpoint) first. Every model it exposes appears here with
          its inferred capabilities, ready to be refined.
        </EmptyState>
      ) : (
        <div className="panel section">
          <FilterBar
            actions={
              <span className="tiny dim nowrap">
                {filtered.length} of {view.models.length} models
              </span>
            }
          >
            <div className="field filter-bar__search">
              <label className="field__label" htmlFor="model-config-search">Search</label>
              <SearchInput
                id="model-config-search"
                value={search}
                onChange={setSearch}
                label="Search models"
                placeholder="Model, provider or capability…"
              />
            </div>
            <FilterSelect
              label="Provider"
              value={provider}
              onChange={setProvider}
              options={providers.map((value) => ({ value, label: providerLabel(value) }))}
            />
            <FilterSelect
              label="Routing"
              value={status}
              onChange={setStatus}
              options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Switched off" }]}
            />
            <FilterSelect
              label="Source"
              value={source}
              onChange={setSource}
              options={[{ value: "configured", label: "Configured" }, { value: "environment", label: "Environment" }]}
            />
          </FilterBar>

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(row) => `${row.provider}/${row.model}`}
            onRowClick={openEditor}
            caption="Models with their routing switch, declared capabilities and persistence source"
            emptyState={
              <EmptyState title="No models match these filters" icon="filter">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => { setSearch(""); setProvider(null); setStatus(null); setSource(null); }}
                >
                  Clear filters
                </button>
              </EmptyState>
            }
          />
        </div>
      )}

      {view.warnings.length > 0 ? (
        <div className="panel">
          <div className="panel__body stack" style={{ gap: 4 }}>
            <strong className="tiny">Saved configuration warnings</strong>
            {view.warnings.map((warning) => <span key={warning} className="tiny dim">{warning}</span>)}
          </div>
        </div>
      ) : null}

      <EditorDrawer
        editor={editor}
        models={view.models}
        groups={groups}
        providers={providers}
        adapters={view.adapters}
        busy={busy}
        error={formError}
        onChange={(draft) => setEditor((current) => current ? { ...current, draft } : current)}
        onClose={() => setEditor(null)}
        onSave={saveEditor}
        onRemove={() => { setRemoving(editor?.row ?? null); setEditor(null); }}
      />

      {bulkOpen ? (
        <BulkCapabilitiesModal
          groups={groups}
          allRows={view.models}
          filteredRows={filtered}
          filtersActive={Boolean(search.trim() || provider || status || source)}
          busy={busy}
          onClose={() => setBulkOpen(false)}
          onApply={applyBulk}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={confirmRemove}
        title="Remove model declaration"
        confirmLabel="Remove declaration"
        destructive
        body={
          <span>
            Remove the saved declaration for <strong>{removing?.model}</strong>? Routing returns to
            the environment default (enabled, capabilities inferred from the provider), and any
            capability choices made here are lost.
          </span>
        }
      />
    </div>
  );
}

/**
 * Add or remove capabilities on many models at once.
 *
 * Each capability is "keep" (default), "add to every chosen model" or "remove
 * from every chosen model". The scope is either the models the table currently
 * shows (so the filters pick the set) or every model. The dialog states how
 * many models would actually change before anything is saved.
 */
function BulkCapabilitiesModal({ groups, allRows, filteredRows, filtersActive, busy, onClose, onApply }) {
  const [scope, setScope] = useState("filtered");
  const [ops, setOps] = useState({});

  const rows = scope === "all" ? allRows : filteredRows;
  const add = Object.keys(ops).filter((id) => ops[id] === "add");
  const remove = Object.keys(ops).filter((id) => ops[id] === "remove");
  const preview = bulkPreview(rows, { add, remove });
  const nothingChosen = add.length === 0 && remove.length === 0;

  const setOp = (id, value) => setOps((current) => {
    const next = { ...current };
    if (value === "keep") delete next[id]; else next[id] = value;
    return next;
  });

  const close = onClose;

  return (
    <Modal
      open
      onClose={close}
      title="Bulk capabilities"
      labelledBy="bulk-capabilities-title"
      footer={
        <>
          <span className="tiny dim grow" aria-live="polite">
            {nothingChosen
              ? "Choose at least one capability."
              : `${preview.willChange} of ${preview.total} ${preview.total === 1 ? "model" : "models"} will change`}
          </span>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || nothingChosen || preview.total === 0 || preview.willChange === 0}
            onClick={() => onApply({ rows, add, remove })}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Apply to {preview.willChange} {preview.willChange === 1 ? "model" : "models"}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: "var(--sp-4)" }}>
        <div className="field">
          <label className="field__label" htmlFor="bulk-scope">Apply to</label>
          <select id="bulk-scope" className="select" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="filtered">
              {filtersActive ? `Models matching the current filters (${filteredRows.length})` : `All models shown (${filteredRows.length})`}
            </option>
            <option value="all">Every model ({allRows.length})</option>
          </select>
          <p className="field__hint">
            Everything else a model has (switch, protocol, context limit) stays as it is. Models without a saved
            declaration get one, starting from the capabilities the gateway already infers for them. All changes are
            saved together in one write.
          </p>
        </div>

        {groups.length === 0 ? <p className="tiny dim">The capability schema was not reported by the gateway.</p> : null}

        {groups.map((group) => (
          <fieldset key={group.id} className="panel" style={{ margin: 0 }}>
            <legend className="tiny dim" style={{ padding: "0 var(--sp-2)" }}>{group.label}</legend>
            <div className="panel__body stack" style={{ gap: "var(--sp-2)" }}>
              {group.items.map((item) => {
                const coverage = bulkCapabilityCoverage(rows, item.id);
                const value = ops[item.id] ?? "keep";
                const controlId = `bulk-cap-${item.id}`;
                return (
                  <div key={item.id} className="row" style={{ gap: "var(--sp-2)", alignItems: "center", justifyContent: "space-between" }}>
                    <label htmlFor={controlId} className="grow">
                      <span className="row" style={{ gap: 6 }}>
                        <span>{item.label}</span>
                        <span className="tiny dim">
                          {coverage === "all" ? "all have it" : coverage === "some" ? "some have it" : "none have it"}
                        </span>
                      </span>
                      <span className="tiny dim">{item.description}</span>
                    </label>
                    <select
                      id={controlId}
                      className="select"
                      style={{ width: "auto" }}
                      value={value}
                      onChange={(event) => setOp(item.id, event.target.value)}
                    >
                      <option value="keep">Keep</option>
                      <option value="add">Add to all</option>
                      <option value="remove">Remove from all</option>
                    </select>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}

/** Where the document lives, and whether it is really reachable. */
function StorageBanner({ storage, revision, updatedAt }) {
  if (!storage) return null;
  const github = storage.mode === "github";
  const tone = storage.ready ? (github ? "info" : "neutral") : "danger";
  const label = github
    ? `Persisted to GitHub · ${storage.location}`
    : `Persisted to the local file · ${storage.location}`;
  const updated = updatedAt ? new Date(updatedAt).toLocaleString() : null;

  return (
    <div className="panel section">
      <div className="panel__body row row--wrap" style={{ gap: "var(--sp-3)", alignItems: "center" }}>
        <StatusBadge tone={tone} dot={false}>{github ? "GitHub" : "Local file"}</StatusBadge>
        <span className="tiny">{label}</span>
        {storage.error ? (
          <span className="tiny" style={{ color: "var(--danger)" }}>{storage.error}</span>
        ) : (
          <span className="tiny dim">{storage.ready ? "reachable" : "not checked"}</span>
        )}
        {updated ? <span className="tiny dim">saved {updated}</span> : null}
        {revision ? <span className="tiny dim mono">rev {revision.slice(0, 12)}</span> : null}
      </div>
    </div>
  );
}

function CapabilityChips({ row, limit = 5 }) {
  const declared = row.capabilities;
  if (declared.length === 0) return <span className="tiny dim">none declared</span>;
  const shown = declared.slice(0, limit);
  return (
    <span className="row row--wrap" style={{ gap: 4 }}>
      {shown.map((id) => {
        const state = capabilityState(row, id);
        return (
          <StatusBadge
            key={id}
            tone={state.unsupported ? "warn" : "neutral"}
            dot={false}
            title={state.unsupported ? "Declared, but no adapter can execute it" : id}
          >
            {id}
          </StatusBadge>
        );
      })}
      {declared.length > shown.length ? (
        <span className="tiny dim">+{declared.length - shown.length}</span>
      ) : null}
    </span>
  );
}

/**
 * The editor. `mode: "create"` also asks provider/model; an edit can never
 * change them (the API refuses it), so those fields are shown read-only.
 */
function EditorDrawer({ editor, models, groups, providers, adapters, busy, error, onChange, onClose, onSave, onRemove }) {
  if (!editor) return null;
  const { mode, row, draft } = editor;
  const create = mode === "create";
  // A row opened from the table carries its environment facts; a blank Add form
  // may match a model once the operator types one. `row` is null only for the
  // latter, so the adapter badges can distinguish "unsupported" from "unknown".
  const environmentRow = row ?? findModelRow(models, draft.provider, draft.model);
  const protocols = environmentRow?.protocols ?? [];
  const protocolOptions = [...new Set([
    ...protocols,
    ...(draft.protocol ? [draft.protocol] : []),
    ...(protocols.length === 0 ? ["openai-chat", "openai-responses", "anthropic", "gemini"] : [])
  ])];
  const identityLocked = Boolean(row);

  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={create ? (row ? `Configure ${row.model}` : "Add a model declaration") : row?.displayName || row?.model || "Model"}
      subtitle={
        create
          ? (row
            ? `${providerLabel(row.provider)} · this environment model has no saved declaration yet`
            : "Provider + model must already be configured by the environment")
          : providerLabel(row.provider)
      }
      footer={
        <>
          {!create && canRemoveModel(row) ? (
            <button type="button" className="btn btn--danger" disabled={busy} onClick={onRemove}>
              <Icon name="trash" className="btn__icon" size={12} /><span className="btn__label">Remove</span>
            </button>
          ) : null}
          <div className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={onSave} disabled={busy || (create && (!draft.provider || !draft.model))}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {create ? "Add declaration" : "Save changes"}
          </button>
        </>
      }
    >
      {error ? <ErrorState error={error} compact /> : null}

      <div className="stack" style={{ gap: "var(--sp-4)" }}>
        {create ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--sp-3)" }}>
            <div className="field">
              <label className="field__label" htmlFor="mc-provider">Provider</label>
              <input
                id="mc-provider"
                className="input"
                list={identityLocked ? undefined : "mc-provider-options"}
                value={draft.provider ?? ""}
                onChange={(event) => onChange({ ...draft, provider: event.target.value })}
                placeholder="groq"
                autoComplete="off"
                readOnly={identityLocked}
              />
              {!identityLocked ? (
                <datalist id="mc-provider-options">
                  {providers.map((value) => <option key={value} value={value} />)}
                </datalist>
              ) : null}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="mc-model">Model</label>
              <input
                id="mc-model"
                className="input"
                value={draft.model ?? ""}
                onChange={(event) => onChange({ ...draft, model: event.target.value })}
                placeholder="llama-3.3-70b-versatile"
                autoComplete="off"
                readOnly={identityLocked}
              />
              <p className="field__hint">
                {identityLocked
                  ? "Provider and model are fixed for an existing environment model."
                  : "Must match a model a configured provider actually exposes."}
              </p>
            </div>
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="mc-display-name">Display name</label>
          <input
            id="mc-display-name"
            className="input"
            value={draft.displayName ?? ""}
            onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
            placeholder={row?.model ?? "Model name"}
          />
        </div>

        <label className="row" style={{ gap: "var(--sp-2)" }}>
          <input
            type="checkbox"
            checked={draft.enabled !== false}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          <span>Enabled for routing</span>
          <span className="tiny dim">Unchecking removes this model from routing and the fallback walk.</span>
        </label>

        <div className="field">
          <label className="field__label" htmlFor="mc-protocol">Protocol override</label>
          <select
            id="mc-protocol"
            className="select"
            value={draft.protocol ?? ""}
            onChange={(event) => onChange({ ...draft, protocol: event.target.value })}
          >
            <option value="">Use the provider&rsquo;s protocols</option>
            {protocolOptions.map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocolLabel(protocol)}{protocols.length > 0 && !protocols.includes(protocol) ? " (not offered)" : ""}
              </option>
            ))}
          </select>
          <p className="field__hint">
            Only needed when this model must be reached by one specific wire format. The provider must offer it.
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="mc-context-limit">Context limit (tokens)</label>
          <input
            id="mc-context-limit"
            className="input"
            inputMode="text"
            value={draft.contextLimit ?? ""}
            onChange={(event) => onChange({ ...draft, contextLimit: event.target.value })}
            placeholder="e.g. 200000, 200k or 1m"
          />
          <p className="field__hint">
            The most tokens this model can take in one request. A request larger than this skips the model, and the
            fallback goes on to the next model that can hold it. Leave empty if unknown: the model is then never
            skipped for size.
          </p>
        </div>

        <div className="stack" style={{ gap: "var(--sp-3)" }}>
          <div>
            <strong>Declared capabilities</strong>
            <p className="tiny dim">
              What you declare. A capability is only routable when an adapter can also execute it; ticking a box
              never invents a wire form.
            </p>
          </div>

          {groups.length === 0 ? <p className="tiny dim">The capability schema was not reported by the gateway.</p> : null}
          {(draft.capabilities ?? []).length === 0 && groups.length > 0 ? (
            <p className="tiny dim">
              No capabilities are declared. The model stays visible but cannot serve any request until at least one
              capability is selected.
            </p>
          ) : null}

          {groups.map((group) => (
            <fieldset key={group.id} className="panel" style={{ margin: 0 }}>
              <legend className="tiny dim" style={{ padding: "0 var(--sp-2)" }}>{group.label}</legend>
              <div className="panel__body stack" style={{ gap: "var(--sp-2)" }}>
                {group.items.map((item) => {
                  const declared = (draft.capabilities ?? []).includes(item.id);
                  const support = adapterSupportState(adapters, protocols, item.id);
                  const controlId = `mc-cap-${item.id}`;
                  return (
                    <label key={item.id} className="row" style={{ gap: "var(--sp-2)", alignItems: "flex-start" }}>
                      <input
                        id={controlId}
                        type="checkbox"
                        checked={declared}
                        onChange={() => onChange({ ...draft, capabilities: toggleCapability(draft.capabilities, item.id) })}
                      />
                      <span className="grow">
                        <span className="row" style={{ gap: 6 }}>
                          <span>{item.label}</span>
                          {support === "supported" ? (
                            <StatusBadge tone="ok" dot={false}>adapter</StatusBadge>
                          ) : support === "unsupported" ? (
                            <StatusBadge tone="warn" dot={false} title="No adapter on this model's protocols can execute it">
                              no adapter
                            </StatusBadge>
                          ) : (
                            <span className="tiny dim" title="Choose a provider and model to resolve its protocols">
                              adapter unknown
                            </span>
                          )}
                          {!item.requestable ? <span className="tiny dim">preference only</span> : null}
                        </span>
                        <span className="tiny dim">{item.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        {row?.warnings?.length > 0 ? (
          <div className="panel">
            <div className="panel__body stack" style={{ gap: 4 }}>
              <strong className="tiny">Current warnings</strong>
              {row.warnings.map((warning) => <span key={warning} className="tiny dim">{warning}</span>)}
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
