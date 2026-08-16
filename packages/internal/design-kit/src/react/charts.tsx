"use client";

import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import {
  useId,
  type CSSProperties,
  type ReactNode,
} from "react";

import { classNames } from "./class-names";

export type BarListChartDatum = Readonly<{
  color?: string;
  detail?: string;
  id: string;
  label: string;
  value: number;
}>;

export type RadarProfileChartAxis = Readonly<{
  id: string;
  label: string;
}>;

export type RadarProfileChartSeries = Readonly<{
  color: string;
  id: string;
  label: string;
  values: Readonly<Record<string, number>>;
}>;

export type RangePlotChartDatum = Readonly<{
  color?: string;
  detail?: string;
  id: string;
  label: string;
  maximum: number;
  median: number;
  minimum: number;
}>;

type SelectableChartProps = Readonly<{
  onSelectionChange?: (id: string) => void;
  selectedId?: string | null;
}>;

type BarChartStyle = CSSProperties & Readonly<{
  "--jungle-chart-color": string;
  "--jungle-chart-value": string;
}>;

type RangeChartStyle = CSSProperties & Readonly<{
  "--jungle-chart-color": string;
  "--jungle-chart-median": string;
  "--jungle-chart-range-left": string;
  "--jungle-chart-range-width": string;
}>;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizedPercent(value: number, minimum: number, maximum: number): number {
  const span = maximum - minimum;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const bounded = Math.max(0, Math.min(100, ((finiteOr(value, minimum) - minimum) / span) * 100));
  return Math.round(bounded * 10_000) / 10_000;
}

function accessibleChartCaption({ ariaLabel }: { ariaLabel: string }) {
  if (ariaLabel.trim() === "") throw new TypeError("Charts require a nonblank accessible label.");
  return <figcaption className="jungle-visually-hidden">{ariaLabel}</figcaption>;
}

function ChartRow({
  children,
  id,
  isSelected,
  onSelectionChange,
}: Readonly<{
  children: ReactNode;
  id: string;
  isSelected: boolean;
  onSelectionChange: ((id: string) => void) | undefined;
}>) {
  if (onSelectionChange === undefined) {
    return (
      <div className="jungle-chart-row" data-selected={isSelected || undefined}>
        {children}
      </div>
    );
  }
  return (
    <button
      aria-pressed={isSelected}
      className="jungle-chart-row jungle-chart-row--selectable"
      data-selected={isSelected || undefined}
      onClick={() => onSelectionChange(id)}
      type="button"
    >
      {children}
    </button>
  );
}

export function BarListChart({
  "aria-label": ariaLabel,
  className,
  data,
  domain = [0, Math.max(1, ...data.map(({ value }) => finiteOr(value, 0)))],
  formatValue = (value) => String(value),
  onSelectionChange,
  selectedId = null,
}: Readonly<{
  "aria-label": string;
  className?: string;
  data: readonly BarListChartDatum[];
  domain?: readonly [number, number];
  formatValue?: (value: number) => string;
}> & SelectableChartProps) {
  const [minimum, maximum] = domain;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
    throw new RangeError("Bar chart domain must be finite and ascending.");
  }

  return (
    <figure className={classNames("jungle-bar-list-chart", className)}>
      {accessibleChartCaption({ ariaLabel })}
      <div className="jungle-bar-list-chart__rows">
        {data.map((datum) => {
          const value = finiteOr(datum.value, minimum);
          const width = normalizedPercent(value, minimum, maximum);
          const style: BarChartStyle = {
            "--jungle-chart-color": datum.color ?? "var(--info)",
            "--jungle-chart-value": `${String(width)}%`,
          };
          return (
            <ChartRow
              id={datum.id}
              isSelected={selectedId === datum.id}
              key={datum.id}
              onSelectionChange={onSelectionChange}
            >
              <span className="jungle-chart-row__heading">
                <span className="jungle-chart-row__label">{datum.label}</span>
                <span className="jungle-chart-row__value">{formatValue(value)}</span>
              </span>
              <span aria-hidden="true" className="jungle-bar-list-chart__track" style={style}>
                <span className="jungle-bar-list-chart__bar" />
              </span>
              {datum.detail === undefined ? null : (
                <span className="jungle-chart-row__detail">{datum.detail}</span>
              )}
            </ChartRow>
          );
        })}
      </div>
    </figure>
  );
}

type RadarTooltipPayload = Readonly<{
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  value?: unknown;
}>;

function RadarProfileTooltip({
  active,
  label,
  payload,
  series,
}: Readonly<{
  active?: boolean;
  label?: unknown;
  payload?: readonly RadarTooltipPayload[];
  series: readonly RadarProfileChartSeries[];
}>) {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const labels = new Map(series.map((item) => [item.id, item.label]));
  return (
    <div className="jungle-chart-tooltip">
      <strong>{typeof label === "string" ? label : "Benchmark"}</strong>
      <dl>
        {payload.map((item, index) => {
          const key = String(item.dataKey ?? item.name ?? index);
          const value = typeof item.value === "number" && Number.isFinite(item.value)
            ? item.value.toFixed(1)
            : "–";
          return (
            <div key={key}>
              <dt>
                <i aria-hidden="true" style={{ background: item.color }} />
                {labels.get(key) ?? key}
              </dt>
              <dd>{value}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export function RadarProfileChart({
  "aria-label": ariaLabel,
  axes,
  className,
  onSelectionChange,
  selectedId = null,
  series,
}: Readonly<{
  "aria-label": string;
  axes: readonly RadarProfileChartAxis[];
  className?: string;
  series: readonly RadarProfileChartSeries[];
}> & SelectableChartProps) {
  const gradientPrefix = useId().replaceAll(":", "");
  const effectiveSelectedId = series.some(({ id }) => id === selectedId) ? selectedId : null;
  const data = axes.map((axis) => {
    const row: Record<string, number | string> = { axis: axis.label };
    for (const item of series) row[item.id] = finiteOr(item.values[axis.id] ?? 0, 0);
    return row;
  });

  return (
    <figure className={classNames("jungle-radar-profile-chart", className)}>
      {accessibleChartCaption({ ariaLabel })}
      <div aria-hidden="true" className="jungle-radar-profile-chart__plot">
        <ResponsiveContainer
          height="100%"
          initialDimension={{ height: 280, width: 360 }}
          width="100%"
        >
          <RadarChart data={data} margin={{ bottom: 22, left: 28, right: 28, top: 22 }}>
            <PolarGrid
              gridType="polygon"
              stroke="var(--grid)"
              strokeDasharray="2 5"
            />
            <PolarAngleAxis
              dataKey="axis"
              tick={{ fill: "var(--muted)", fontFamily: "var(--font-text)", fontSize: 11 }}
              tickLine={false}
            />
            <PolarRadiusAxis axisLine={false} domain={[0, 100]} tick={false} />
            <RechartsTooltip
              content={<RadarProfileTooltip series={series} />}
              cursor={false}
              isAnimationActive={false}
            />
            <defs>
              {series.map((item, index) => {
                const gradientId = `${gradientPrefix}-${String(index)}`;
                return (
                  <radialGradient id={gradientId} key={item.id}>
                    <stop offset="0%" stopColor={item.color} stopOpacity="0.06" />
                    <stop offset="100%" stopColor={item.color} stopOpacity="0.72" />
                  </radialGradient>
                );
              })}
            </defs>
            {series.map((item, index) => {
              const gradientId = `${gradientPrefix}-${String(index)}`;
              const dimmed = effectiveSelectedId !== null && effectiveSelectedId !== item.id;
              return (
                <Radar
                  dataKey={item.id}
                  fill={`url(#${gradientId})`}
                  fillOpacity={dimmed ? 0.05 : 0.17}
                  isAnimationActive={false}
                  key={item.id}
                  name={item.label}
                  stroke={item.color}
                  strokeOpacity={dimmed ? 0.2 : 0.88}
                  strokeWidth={dimmed ? 1 : 1.75}
                />
              );
            })}
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <div aria-label="Profiles" className="jungle-radar-profile-chart__legend" role="group">
        {series.map((item) => (
          <ChartRow
            id={item.id}
            isSelected={selectedId === item.id}
            key={item.id}
            onSelectionChange={onSelectionChange}
          >
            <i aria-hidden="true" style={{ background: item.color }} />
            <span>{item.label}</span>
          </ChartRow>
        ))}
      </div>
      <table className="jungle-visually-hidden">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Benchmark</th>
            {series.map((item) => <th key={item.id} scope="col">{item.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {axes.map((axis) => (
            <tr key={axis.id}>
              <th scope="row">{axis.label}</th>
              {series.map((item) => (
                <td key={item.id}>{finiteOr(item.values[axis.id] ?? 0, 0).toFixed(1)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function RangePlotChart({
  "aria-label": ariaLabel,
  className,
  data,
  domain = [0, 100],
  formatValue = (value) => String(value),
  onSelectionChange,
  selectedId = null,
}: Readonly<{
  "aria-label": string;
  className?: string;
  data: readonly RangePlotChartDatum[];
  domain?: readonly [number, number];
  formatValue?: (value: number) => string;
}> & SelectableChartProps) {
  const [domainMinimum, domainMaximum] = domain;
  if (!Number.isFinite(domainMinimum) || !Number.isFinite(domainMaximum) || domainMinimum >= domainMaximum) {
    throw new RangeError("Range plot domain must be finite and ascending.");
  }

  return (
    <figure className={classNames("jungle-range-plot-chart", className)}>
      {accessibleChartCaption({ ariaLabel })}
      <div className="jungle-range-plot-chart__rows">
        {data.map((datum) => {
          const minimum = finiteOr(datum.minimum, domainMinimum);
          const maximum = finiteOr(datum.maximum, domainMaximum);
          const median = finiteOr(datum.median, minimum);
          const left = normalizedPercent(Math.min(minimum, maximum), domainMinimum, domainMaximum);
          const right = normalizedPercent(Math.max(minimum, maximum), domainMinimum, domainMaximum);
          const middle = normalizedPercent(median, domainMinimum, domainMaximum);
          const style: RangeChartStyle = {
            "--jungle-chart-color": datum.color ?? "var(--info)",
            "--jungle-chart-range-left": `${String(left)}%`,
            "--jungle-chart-range-width": `${String(Math.max(0, right - left))}%`,
            "--jungle-chart-median": `${String(middle)}%`,
          };
          return (
            <ChartRow
              id={datum.id}
              isSelected={selectedId === datum.id}
              key={datum.id}
              onSelectionChange={onSelectionChange}
            >
              <span className="jungle-chart-row__heading">
                <span className="jungle-chart-row__label">{datum.label}</span>
                <span className="jungle-chart-row__value">
                  {formatValue(minimum)}–{formatValue(maximum)}
                </span>
              </span>
              <span aria-hidden="true" className="jungle-range-plot-chart__track" style={style}>
                <span className="jungle-range-plot-chart__range" />
                <span className="jungle-range-plot-chart__median" />
              </span>
              {datum.detail === undefined ? null : (
                <span className="jungle-chart-row__detail">{datum.detail}</span>
              )}
            </ChartRow>
          );
        })}
      </div>
    </figure>
  );
}
