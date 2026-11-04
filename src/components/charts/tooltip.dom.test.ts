// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import '../../lib/echartsRegister';
import { axisTooltip, baseOption } from '../../lib/echarts';
import { integer } from '../../lib/format';

// Production renders to canvas, which jsdom does not implement; SVG exercises
// the same tooltip path without needing a real 2D context.
use([SVGRenderer]);

const MONTHS = ['2026-04', '2026-05', '2026-06'];

function showTooltipAt(dataIndex: number, stack: boolean) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const chart = init(element, undefined, { renderer: 'svg', width: 600, height: 300 });

  const base = baseOption(MONTHS);
  chart.setOption({
    ...base,
    tooltip: axisTooltip(integer, { showTotal: stack }),
    series: [
      {
        type: 'bar',
        name: 'US',
        stack: stack ? 'total' : undefined,
        data: [600_000, 610_000, 620_000],
      },
      {
        type: 'bar',
        name: 'EU',
        stack: stack ? 'total' : undefined,
        data: [120_000, null, 130_000],
      },
    ],
  });

  chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex });
  // ECharts appends the tooltip alongside the chart it belongs to, so scope the
  // lookup to this container rather than picking up a previous test's tooltip.
  const tooltip = element.querySelector<HTMLElement>('div[style*="position: absolute"]');
  return tooltip?.textContent ?? '';
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('bar chart tooltips', () => {
  it('shows each server value when a bar is hovered', () => {
    const text = showTooltipAt(2, true);
    expect(text).toContain('Jun 2026');
    expect(text).toContain('620,000');
    expect(text).toContain('130,000');
  });

  it('totals the stack', () => {
    expect(showTooltipAt(2, true)).toContain('750,000');
  });

  it('hides servers with no data for that month', () => {
    const text = showTooltipAt(1, true);
    expect(text).toContain('610,000');
    expect(text).not.toContain('EU');
  });

  it('omits the total on grouped (non-stacked) charts', () => {
    expect(showTooltipAt(2, false)).not.toContain('750,000');
  });
});
