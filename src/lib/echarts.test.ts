import { describe, expect, it } from 'vitest';
import { axisTooltip, PRIOR_YEAR_SERIES, type TooltipParam } from './echarts';
import { integer, percent } from './format';

function param(seriesName: string, value: number | null, dataIndex = 0): TooltipParam {
  return {
    axisValue: '2026-06',
    dataIndex,
    marker: `<span data-series="${seriesName}"></span>`,
    seriesName,
    value,
  };
}

/** The formatter returns an HTML string; strip tags to assert on what a reader
 *  actually sees. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '|').replace(/\|+/g, '|');
}

describe('axisTooltip', () => {
  it('lists every series value under the month heading', () => {
    const html = axisTooltip(integer).formatter([param('US', 483799), param('EU', 120500)]);
    expect(text(html)).toBe('|Jun 2026|US|483,799|EU|120,500|');
  });

  it('drops series that have no data for the month', () => {
    const html = axisTooltip(integer).formatter([
      param('US', 483799),
      param('EU', null),
      param('BE', 1200),
    ]);
    expect(text(html)).not.toContain('EU');
    expect(text(html)).toContain('BE');
  });

  it('says so when the whole month is empty rather than rendering blank', () => {
    const html = axisTooltip(integer).formatter([param('US', null), param('EU', null)]);
    expect(text(html)).toBe('|Jun 2026|No data|');
  });

  it('adds a total row for stacked charts', () => {
    const html = axisTooltip(integer, { showTotal: true }).formatter([
      param('US', 100),
      param('EU', 25),
    ]);
    expect(text(html)).toContain('Total|125');
  });

  it('omits the total when only one series has data, since it would repeat it', () => {
    const html = axisTooltip(integer, { showTotal: true }).formatter([
      param('US', 100),
      param('EU', null),
    ]);
    expect(text(html)).not.toContain('Total');
  });

  it('formats percentage charts as percentages', () => {
    const html = axisTooltip(percent).formatter([param('US', 12.34)]);
    expect(text(html)).toContain('12.3%');
  });

  it('survives an empty params array', () => {
    expect(axisTooltip(integer).formatter([])).toBe('');
  });
});

describe('axisTooltip year-over-year comparison', () => {
  const comparison = { offsetMonths: -12, bySeries: { US: [4724, 3990] } };

  it('names the compared month and shows its value and change', () => {
    const html = axisTooltip(integer, { comparison }).formatter([param('US', 4771)]);
    expect(text(html)).toContain('vs Jun 2025: 4,724');
    expect(text(html)).toContain('+1.0%');
  });

  it('marks a decline without implying it is bad', () => {
    const html = axisTooltip(integer, { comparison }).formatter([param('US', 4000)]);
    expect(text(html)).toContain('−15.3%');
    expect(html).toContain('▼');
    expect(html).not.toMatch(/color:\s*(red|green|#[0-9a-f]*(00ff00|ff0000))/i);
  });

  it('reads the comparison at the hovered month, not the first one', () => {
    const html = axisTooltip(integer, { comparison }).formatter([param('US', 4000, 1)]);
    expect(text(html)).toContain('3,990');
  });

  it('omits the line for a series with no prior-year data', () => {
    const html = axisTooltip(integer, {
      comparison: { offsetMonths: -12, bySeries: { US: [null] } },
    }).formatter([param('US', 4771)]);
    expect(text(html)).not.toContain('vs ');
  });

  it('omits the line for a series absent from the comparison entirely', () => {
    const html = axisTooltip(integer, { comparison }).formatter([param('BE', 120)]);
    expect(text(html)).not.toContain('vs ');
  });

  it('leaves the ghost series out of the rows, since the vs line already has it', () => {
    const html = axisTooltip(integer, {
      comparison,
      omitSeries: [PRIOR_YEAR_SERIES],
    }).formatter([param('US', 4771), { ...param(PRIOR_YEAR_SERIES, 4724), dataIndex: 0 }]);
    expect(text(html)).not.toContain(PRIOR_YEAR_SERIES);
    expect(text(html)).toContain('vs Jun 2025: 4,724');
  });

  it('reports no data when every remaining series is omitted', () => {
    const html = axisTooltip(integer, { omitSeries: [PRIOR_YEAR_SERIES] }).formatter([
      param(PRIOR_YEAR_SERIES, 4724),
    ]);
    expect(text(html)).toBe('|Jun 2026|No data|');
  });

  it('skips the percentage when the prior month was zero', () => {
    const html = axisTooltip(integer, {
      comparison: { offsetMonths: -12, bySeries: { US: [0] } },
    }).formatter([param('US', 500)]);
    expect(text(html)).toContain('vs Jun 2025: 0');
    expect(text(html)).not.toContain('%');
  });
});
