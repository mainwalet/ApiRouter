import { useId, useMemo } from "react";
import { formatNumber, formatPercent, formatLatency } from "../../lib/format.js";

/**
 * Hand-rolled SVG charts.
 *
 * No charting dependency: the panel needs four simple shapes, and a charting
 * library would add more bytes than the rest of the application combined.
 *
 * Every chart is exposed as `role="img"` with a text summary, and each one
 * ships a visually-hidden table of the underlying numbers. A chart that only
 * communicates through colour and position is unusable with a screen reader,
 * and "the data is in the tooltip" is not an accessible answer.
 */

const PAD = { top: 8, right: 8, bottom: 18, left: 36 };

function HiddenTable({ caption, columns, rows }) {
  if (rows.length === 0) return null;
  // A <table> ignores `height: 1px; overflow: hidden`, so on its own an ".sr-only"
  // table keeps its full height and stretches the scrollable area below the page
  // (empty space you could scroll into). Clip it with a wrapper instead.
  return (
    <div className="sr-only">
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              cellIndex === 0
                ? <th key={cellIndex} scope="row">{cell}</th>
                : <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/**
 * Requests over time, split into succeeded and failed.
 *
 * Stacked rather than overlaid so the bar height is the true request total —
 * which is the figure an operator is usually looking for — while the red
 * portion still reads as "how much of this went wrong".
 */
export function TimeSeriesChart({
  series,
  height = 180,
  title = "Requests over time",
  showLatency = false
}) {
  const gradientId = useId();
  const width = 720;

  const data = Array.isArray(series) ? series : [];
  const totals = data.map((row) => row.total ?? 0);
  const max = Math.max(1, ...totals);
  const latencyValues = data.map((row) => row.avgLatencyMs).filter(Number.isFinite);
  const maxLatency = Math.max(1, ...latencyValues);

  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const barSlot = data.length > 0 ? plotWidth / data.length : plotWidth;
  const barWidth = Math.max(1, Math.min(28, barSlot * 0.68));

  const latencyPath = useMemo(() => {
    if (!showLatency || latencyValues.length === 0) return null;

    return data
      .map((row, index) => {
        if (!Number.isFinite(row.avgLatencyMs)) return null;
        const x = PAD.left + index * barSlot + barSlot / 2;
        const y = PAD.top + plotHeight - (row.avgLatencyMs / maxLatency) * plotHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  }, [data, showLatency, latencyValues.length, barSlot, plotHeight, maxLatency]);

  if (data.length === 0) {
    return <div className="chart__empty">No time-series data for this range.</div>;
  }

  const totalRequests = totals.reduce((sum, value) => sum + value, 0);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}. ${formatNumber(totalRequests)} requests across ${data.length} intervals.`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((fraction) => {
          const y = PAD.top + plotHeight * fraction;
          return (
            <g key={fraction}>
              <line className="chart__grid" x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
              <text className="chart__axis" x={PAD.left - 5} y={y + 3} textAnchor="end">
                {formatNumber(Math.round(max * (1 - fraction)))}
              </text>
            </g>
          );
        })}

        {data.map((row, index) => {
          const x = PAD.left + index * barSlot + (barSlot - barWidth) / 2;
          const totalHeight = ((row.total ?? 0) / max) * plotHeight;
          const failedHeight = ((row.failed ?? 0) / max) * plotHeight;
          const successHeight = Math.max(0, totalHeight - failedHeight);
          const baseY = PAD.top + plotHeight;

          return (
            <g key={row.bucketStart ?? index}>
              <rect
                className="chart__bar"
                x={x}
                y={baseY - successHeight}
                width={barWidth}
                height={successHeight}
              />
              {failedHeight > 0 ? (
                <rect
                  className="chart__bar--failed"
                  x={x}
                  y={baseY - totalHeight}
                  width={barWidth}
                  height={failedHeight}
                />
              ) : null}
            </g>
          );
        })}

        {latencyPath ? (
          <polyline className="chart__line" points={latencyPath} />
        ) : null}
      </svg>

      <div className="chart__legend">
        <span className="chart__legend-item">
          <span className="chart__swatch" style={{ background: "var(--accent)" }} /> succeeded
        </span>
        <span className="chart__legend-item">
          <span className="chart__swatch" style={{ background: "var(--danger)" }} /> failed
        </span>
        {showLatency && latencyValues.length > 0 ? (
          <span className="chart__legend-item">
            <span className="chart__swatch" style={{ background: "var(--accent)", height: 2 }} /> avg latency (peak {formatLatency(maxLatency)})
          </span>
        ) : null}
      </div>

      <HiddenTable
        caption={title}
        columns={["Interval", "Requests", "Succeeded", "Failed", "Avg latency"]}
        rows={data.map((row) => [
          new Date(row.bucketStart).toLocaleTimeString(),
          formatNumber(row.total),
          formatNumber(row.successful),
          formatNumber(row.failed),
          formatLatency(row.avgLatencyMs)
        ])}
      />
    </figure>
  );
}

/** Compact inline trend, used inside metric cards. */
export function Sparkline({ values, height = 28, tone = "var(--accent)", label = "Trend" }) {
  const data = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (data.length < 2) return <div className="chart__empty tiny">Not enough data for a trend.</div>;

  const width = 120;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;

  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="chart__spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${data.length} points, minimum ${min}, maximum ${max}`}
    >
      <polyline points={points} fill="none" stroke={tone} strokeWidth="1.5" />
    </svg>
  );
}

/** Horizontal bar list — the right shape for "top N by count". */
export function BarList({ items, emptyLabel = "No data", valueFormatter = formatNumber, limit = 8 }) {
  const rows = (Array.isArray(items) ? items : []).slice(0, limit);
  if (rows.length === 0) return <div className="chart__empty">{emptyLabel}</div>;

  const max = Math.max(...rows.map((row) => row.count ?? 0), 1);

  return (
    <div className="barlist">
      {rows.map((row) => (
        <div className="barlist__row" key={row.key}>
          <span className="barlist__label" title={String(row.key)}>{row.key}</span>
          <span className="barlist__count">
            {valueFormatter(row.count)}
            {Number.isFinite(row.share) ? <span className="dim"> · {formatPercent(row.share, 0)}</span> : null}
          </span>
          <span className="barlist__track">
            <span
              className="barlist__fill"
              style={{ width: `${Math.max(2, ((row.count ?? 0) / max) * 100)}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Health distribution.
 *
 * A single stacked bar rather than a donut: the segments are proportions of
 * one whole (all configured targets), and a bar makes those proportions
 * comparable at a glance, which is the only question this chart answers.
 */
export function HealthDistribution({ counts }) {
  const segments = [
    { key: "healthy", label: "Healthy", tone: "ok", value: counts?.healthy ?? 0 },
    { key: "cooldown", label: "Cooldown", tone: "warn", value: counts?.cooldown ?? 0 },
    { key: "failed", label: "Failed", tone: "danger", value: counts?.failed ?? 0 },
    { key: "unknown", label: "Unknown", tone: "neutral", value: counts?.unknown ?? 0 }
  ];

  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total === 0) {
    return <div className="chart__empty">No configured targets to summarise.</div>;
  }

  return (
    <div>
      <div className="health-bar" style={{ height: 10 }} role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}>
        {segments.filter((segment) => segment.value > 0).map((segment) => (
          <span
            key={segment.key}
            className={`health-bar__seg health-bar__seg--${segment.tone}`}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${segment.value}`}
          />
        ))}
      </div>

      <div className="chart__legend">
        {segments.map((segment) => (
          <span className="chart__legend-item" key={segment.key}>
            <span className={`swatch swatch--${segment.tone}`} />
            {segment.label}
            <span className="mono">{segment.value}</span>
            <span className="dim">{formatPercent(segment.value / total, 0)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
