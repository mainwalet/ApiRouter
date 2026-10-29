import { useMemo, useState } from "react";
import { getProviders, setProviderDisabled } from "../api/providers.js";
import { useApi } from "../hooks/useApi.js";
import { useConnection } from "../context/ConnectionContext.jsx";
import { PageHeader } from "../components/layout/PageHeader.jsx";
import { DataTable } from "../components/ui/DataTable.jsx";
import { StatusBadge } from "../components/ui/StatusBadge.jsx";
import { HealthBadge } from "../components/ui/HealthBadge.jsx";
import { LatencyBadge } from "../components/ui/LatencyBadge.jsx";
import { MaskedValue } from "../components/ui/MaskedValue.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { ErrorState } from "../components/ui/ErrorState.jsx";
import { TableSkeleton } from "../components/ui/LoadingSkeleton.jsx";
import { HealthDistribution } from "../components/charts/Charts.jsx";
import { ProviderDrawer } from "../components/domain/ProviderDrawer.jsx";
import { Link } from "../router.jsx";
import { formatRelativeTime, providerLabel } from "../lib/format.js";
import { sortRows } from "../lib/table.js";

/**
 * Providers.
 *
 * Every row is one provider. Text and vision are capabilities of a model —
 * declared in the Model Configurator — not separate routing pools, so there is
 * one table here and one drawer per provider. A provider healthy for one model
 * and failing for another says exactly that per-model on the Models page.
 *
 * Clicking a row opens the shared `ProviderDrawer`, which answers "is this
 * provider set up correctly?" using only values the gateway is willing to
 * expose: base URL, model lists, protocol support and a *count* of configured
 * keys. There is no code path that reads key material into the browser, so
 * nothing here can leak one.
 */

/**
 * On/Off for a whole provider: every model, every key, both capabilities
 * together. The click must not open the row's drawer.
 */
function ProviderSwitchButton({ row, busy, onToggle }) {
  if (!row.configured) return <span className="dim tiny">—</span>;
  const off = row.disabled === true;
  return (
    <button
      type="button"
      className={`btn btn--sm ${off ? "" : "btn--ghost"}`}
      aria-pressed={!off}
      disabled={busy}
      title={off
        ? "Switched off — click to enable this provider and all its models"
        : "Click to disable this provider (removes all its models from routing and fallback)"}
      onClick={(event) => { event.stopPropagation(); onToggle(row); }}
    >
      {busy ? "…" : off ? "Off" : "On"}
    </button>
  );
}

export default function Providers() {
  const { generation } = useConnection();
  const {
    data: providerData,
    error,
    loading,
    reload,
    lastUpdatedAt,
    refreshing
  } = useApi(getProviders, {
    intervalMs: 10_000,
    deps: [generation]
  });

  const rows = providerData?.providers ?? [];

  const [selection, setSelection] = useState(null);
  const [sort, setSort] = useState({ key: "provider", direction: "asc" });
  const [pendingProvider, setPendingProvider] = useState(null);
  const [switchError, setSwitchError] = useState(null);

  // Applies at once on the gateway: none of the provider's models is routed or
  // fallen back to while it is off, and enabling it restores them as they were.
  const toggleProvider = async (row) => {
    setPendingProvider(row.id);
    setSwitchError(null);
    try {
      await setProviderDisabled(row.id, !row.disabled);
      reload();
    } catch (switchFailure) {
      setSwitchError(switchFailure);
    } finally {
      setPendingProvider(null);
    }
  };

  const selected = useMemo(() => {
    if (!selection) return null;
    return rows.find((provider) => provider.id === selection.id) ?? null;
  }, [selection, rows]);

  const columns = useMemo(() => [
    {
      key: "provider",
      header: "Provider",
      sortable: true,
      get: (row) => row.id,
      render: (row) => (
        <div>
          <div>{providerLabel(row.id)}</div>
          <div className="tiny dim mono">{row.envPrefix}_*</div>
        </div>
      )
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      get: (row) => row.health.status,
      render: (row) => {
        if (!row.configured) return <StatusBadge tone="neutral">not configured</StatusBadge>;
        // A switched-off provider is not a health problem, so it says so rather
        // than showing a health state it is no longer being measured by.
        return row.disabled
          ? <StatusBadge tone="neutral">switched off</StatusBadge>
          : <HealthBadge status={row.health.status} />;
      }
    },
    {
      key: "models",
      header: "Models",
      align: "right",
      sortable: true,
      get: (row) => row.modelCount,
      render: (row) => <span className="mono">{row.modelCount}</span>
    },
    {
      key: "keys",
      header: "Keys",
      align: "right",
      sortable: true,
      get: (row) => row.keyCount,
      render: (row) => row.keyCount > 0
        ? <MaskedValue configured noun={`${row.keyCount} key(s)`} />
        : <MaskedValue configured={false} />
    },
    {
      key: "targets",
      header: "Targets",
      align: "right",
      sortable: true,
      get: (row) => row.targetCount,
      render: (row) => <span className="mono">{row.targetCount}</span>
    },
    {
      key: "healthy",
      header: "Healthy",
      align: "right",
      sortable: true,
      get: (row) => row.health.healthy,
      render: (row) => <span className="mono" style={{ color: row.health.healthy > 0 ? "var(--ok)" : undefined }}>{row.health.healthy}</span>
    },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      sortable: true,
      get: (row) => row.health.failed + row.health.cooldown,
      render: (row) => {
        const bad = row.health.failed + row.health.cooldown;
        return <span className="mono" style={{ color: bad > 0 ? "var(--danger)" : undefined }}>{bad}</span>;
      }
    },
    {
      key: "latency",
      header: "Avg latency",
      align: "right",
      sortable: true,
      get: (row) => row.health.latencyMs,
      render: (row) => <LatencyBadge ms={row.health.latencyMs} />
    },
    {
      key: "checked",
      header: "Last check",
      align: "right",
      sortable: true,
      get: (row) => row.health.lastUpdatedAt,
      render: (row) => <span className="dim tiny nowrap">{formatRelativeTime(row.health.lastUpdatedAt)}</span>
    },
    {
      key: "switch",
      header: "Switch",
      align: "right",
      sortable: true,
      get: (row) => (row.disabled ? 1 : 0),
      render: (row) => (
        <ProviderSwitchButton row={row} busy={pendingProvider === row.id} onToggle={toggleProvider} />
      )
    }
  ], [pendingProvider]);

  // Sort by the chosen column, then keep providers that are not configured at
  // the bottom whatever the column or direction. The partition is stable, so
  // each group keeps the order the sort gave it.
  const sortedRows = useMemo(() => {
    const byKey = Object.fromEntries(columns.map((column) => [column.key, column]));
    const sorted = sortRows(rows, byKey, sort);
    return [
      ...sorted.filter((row) => row.configured),
      ...sorted.filter((row) => !row.configured)
    ];
  }, [rows, columns, sort]);

  if (loading && !providerData) {
    return (
      <div className="page">
        <PageHeader title="Providers" description="Configured providers, credentials and per-provider health" />
        <div className="panel"><div className="panel__body"><TableSkeleton rows={8} label="Loading providers" /></div></div>
      </div>
    );
  }

  const summary = providerData?.summary ?? null;

  return (
    <div className="page">
      <PageHeader
        title="Providers"
        description="Configured providers, credentials and per-provider health"
        lastUpdatedAt={lastUpdatedAt}
        refreshing={refreshing}
        actions={<button type="button" className="btn" onClick={reload} disabled={refreshing}>Refresh</button>}
      />

      {error ? <ErrorState error={error} onRetry={reload} compact /> : null}
      {switchError ? <ErrorState error={switchError} compact /> : null}

      {rows.length === 0 ? (
        <div className="panel">
          <EmptyState title="No providers configured" icon="server">
            Add a provider to <code>.env</code> and restart — see the
            {" "}<Link to="/configuration">Configuration</Link> page for exactly which variables are needed.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="section">
            <div className="panel__body">
              <HealthDistribution counts={{
                healthy: rows.reduce((sum, p) => sum + p.health.healthy, 0),
                cooldown: rows.reduce((sum, p) => sum + p.health.cooldown, 0),
                failed: rows.reduce((sum, p) => sum + p.health.failed, 0),
                unknown: rows.reduce((sum, p) => sum + p.health.unknown, 0)
              }} />
            </div>
          </div>

          <div className="panel">
            <DataTable
              columns={columns}
              rows={sortedRows}
              sort={sort}
              onSortChange={setSort}
              rowKey={(row) => row.id}
              onRowClick={(row) => setSelection({ id: row.id })}
              caption="Providers and their routing targets"
              emptyState={(
                <EmptyState title="No providers configured" icon="server">
                  Configure a provider in <code>.env</code> and restart.
                </EmptyState>
              )}
            />
          </div>
        </>
      )}

      <ProviderDrawer
        open={Boolean(selected)}
        onClose={() => setSelection(null)}
        id={selected?.id}
        record={selected ?? null}
        onChanged={reload}
      />
    </div>
  );
}
