/**
 * rich_analytics: CPU-bound aggregation over a large synthetic order set.
 *
 * It builds the data set, groups it by region and product, computes percentiles by sorting,
 * and computes a 7-day moving average of daily revenue. ANALYTICS_ROWS controls the cost
 * (tuned to roughly 1 s on Lambda). No sleep anywhere.
 */
import { generateOrders } from '../data';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function buildRichAnalytics(rows: number) {
  const orders = generateOrders(rows, 7);

  const groups = new Map<string, number[]>();
  const daily = new Array<number>(90).fill(0);
  for (const o of orders) {
    const key = `${o.region}|${o.product}`;
    let amounts = groups.get(key);
    if (!amounts) groups.set(key, (amounts = []));
    amounts.push(o.amount);
    daily[o.day] += o.amount;
  }

  const segments = [...groups.entries()].map(([key, amounts]) => {
    amounts.sort((a, b) => a - b);
    const [region, product] = key.split('|');
    const revenue = amounts.reduce((sum, a) => sum + a, 0);
    return {
      region, product, orders: amounts.length, revenue,
      p50: percentile(amounts, 50), p90: percentile(amounts, 90), p99: percentile(amounts, 99),
    };
  });
  segments.sort((a, b) => b.revenue - a.revenue);

  const movingAverage7d = daily.map((_, day) => {
    const window = daily.slice(Math.max(0, day - 6), day + 1);
    return Math.round(window.reduce((s, v) => s + v, 0) / window.length);
  });

  return { rows_analysed: rows, top_segments: segments.slice(0, 10), revenue_7d_moving_average: movingAverage7d };
}
