/** basic_csv: a small CSV export. Cheap on purpose, so shedding it would not help much. */
import { generateOrders } from '../data';

export function buildCsvReport(rows = 50): string {
  const lines = ['order_id,day,region,product,quantity,amount_rs'];
  for (const o of generateOrders(rows)) {
    lines.push([o.id, o.day, o.region, o.product, o.quantity, o.amount].join(','));
  }
  return lines.join('\n') + '\n';
}
