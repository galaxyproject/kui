// Galaxy chart theme and option builders. Deliberately free of any `echarts`
// import so the server bundle stays small; registration lives in
// `echartsRegister.ts`, which only ever loads in the browser.
import { compact, monthLabel, shiftMonth, signedPercent } from './format';

export const GALAXY_DARK = '#2c3143';
export const GALAXY_PRIMARY = '#25537b';
export const GALAXY_ACCENT = '#20b2c8';
export const GALAXY_ALERT = '#e8127f';
export const AXIS_TEXT = '#5b6478';
export const GRID_LINE = '#e6edf4';

/** Series palette for multi-series per-server charts (aggregate page uses the
 *  registry colors instead). */
export const SERIES_COLORS = [GALAXY_DARK, GALAXY_ACCENT, GALAXY_ALERT, '#5ba85f', '#f4761f'];

/** One series' entry in an axis-triggered tooltip callback. */
export interface TooltipParam {
  axisValue: string;
  dataIndex: number;
  marker: string;
  seriesName: string;
  value: number | null | undefined;
}

/** An earlier period to hold each bar against, keyed by series name and
 *  aligned to the chart's month axis. Only meaningful for monthly flows: a
 *  cumulative counter would report a rise every single month. */
export interface TooltipComparison {
  offsetMonths: number;
  bySeries: Record<string, (number | null)[]>;
}

/** Name of the faded prior-year series drawn behind the current bars. Shared so
 *  the chart and the tooltip agree on which series to leave out of the rows. */
export const PRIOR_YEAR_SERIES = 'Same month, prior year';

/** Trend line colour, chosen to stay legible over the dark, cyan and magenta
 *  series it has to cross. */
export const GALAXY_TREND = '#f4761f';
export const TREND_SERIES = '12-month trend';

/** Hovering anywhere in a month's column lists every series' value for that
 *  month. Series with no data are dropped rather than shown as em dashes —
 *  with six servers on the aggregate charts, the gaps crowd out the numbers. */
export function axisTooltip(
  format: (value: number) => string,
  {
    showTotal = false,
    comparison = null,
    omitSeries = [],
  }: {
    showTotal?: boolean;
    comparison?: TooltipComparison | null;
    omitSeries?: string[];
  } = {},
) {
  return {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    backgroundColor: '#ffffff',
    borderColor: GRID_LINE,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: GALAXY_DARK, fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 12px rgba(44, 49, 67, 0.15); border-radius: 6px;',
    formatter: (params: TooltipParam[]) => {
      if (!params?.length) return '';
      const header = `<div style="font-weight:700;margin-bottom:4px">${monthLabel(params[0].axisValue)}</div>`;
      const present = params.filter(
        (param): param is TooltipParam & { value: number } =>
          !omitSeries.includes(param.seriesName) &&
          param.value !== null &&
          param.value !== undefined &&
          Number.isFinite(param.value),
      );
      if (present.length === 0) {
        return `${header}<span style="color:${AXIS_TEXT}">No data</span>`;
      }

      const row = (marker: string, name: string, value: string, bold = false) =>
        `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between${
          bold ? `;margin-top:4px;padding-top:4px;border-top:1px solid ${GRID_LINE};font-weight:700` : ''
        }"><span>${marker}${name}</span><span style="font-variant-numeric:tabular-nums">${value}</span></div>`;

      const comparedMonth = comparison
        ? monthLabel(shiftMonth(params[0].axisValue, comparison.offsetMonths))
        : '';

      const rows = present.map((param) => {
        const main = row(param.marker, param.seriesName, format(param.value));
        const prior = comparison?.bySeries[param.seriesName]?.[param.dataIndex];
        if (prior === null || prior === undefined || !Number.isFinite(prior)) return main;

        const change = prior === 0 ? null : ((param.value - prior) / prior) * 100;
        // Deliberately no red/green: a rise in errored jobs is not an improvement.
        const arrow = change === null || change === 0 ? '' : change > 0 ? '▲' : '▼';
        const delta = change === null ? '' : ` ${arrow} ${signedPercent(change)}`;
        return `${main}<div style="margin-left:18px;color:${AXIS_TEXT};font-size:11px">vs ${comparedMonth}: ${format(prior)}${delta}</div>`;
      });

      if (showTotal && present.length > 1) {
        const total = present.reduce((sum, param) => sum + param.value, 0);
        rows.push(row('', 'Total', format(total), true));
      }

      return header + rows.join('');
    },
  };
}

export function baseOption(months: string[]) {
  return {
    animationDuration: 400,
    textStyle: { fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif" },
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: months,
      axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: (m: string) => monthLabel(m) },
      axisLine: { lineStyle: { color: GRID_LINE } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: (v: number) => compact(v) },
      splitLine: { lineStyle: { color: GRID_LINE } },
    },
    legend: {
      top: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 12,
      textStyle: { color: GALAXY_DARK, fontSize: 12 },
    },
  };
}

/** Dashed reference line labelled with the range average — used in five of the
 *  dashboard sections. */
export function averageMarkLine(
  value: number | null,
  label: string,
  color = GALAXY_DARK,
  format: (value: number) => string = compact,
) {
  if (value === null) return undefined;
  return {
    silent: true,
    symbol: 'none',
    lineStyle: { color, type: 'dashed', width: 1.5 },
    label: {
      formatter: `${label}: ${format(value)}`,
      position: 'insideStartTop',
      color: GALAXY_DARK,
      backgroundColor: '#ffffffcc',
      padding: [2, 4],
      fontSize: 11,
    },
    data: [{ yAxis: value }],
  };
}
