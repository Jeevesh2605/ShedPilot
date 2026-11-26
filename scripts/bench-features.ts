/**
 * Times the real work behind each flag on this machine, so we can choose PDF_PAGES and
 * ANALYTICS_ROWS. Lambda CPU scales with memory, so Lambda numbers will be higher.
 * Confirm on Lambda by reading feature_timings_ms in the logs after one real request.
 *
 *   npm run bench
 */
import { buildPdfReport } from '../backend/src/features/pdfReport';
import { buildRichAnalytics } from '../backend/src/features/richAnalytics';
import { buildCsvReport } from '../backend/src/features/csvReport';

async function time<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  await work(); // warm-up run, like a warm Lambda container
  const start = performance.now();
  const result = await work();
  console.log(`${label.padEnd(32)} ${Math.round(performance.now() - start)} ms`);
  return result;
}

for (const pages of [20, 40, 80]) {
  const pdf = await time(`pdf_export, ${pages} pages`, () => buildPdfReport(pages));
  console.log(`${''.padEnd(32)} size ${(pdf.length / 1024).toFixed(0)} KB`);
}
for (const rows of [150_000, 300_000, 600_000]) {
  await time(`rich_analytics, ${rows} rows`, () => buildRichAnalytics(rows));
}
await time('basic_csv, 50 rows', () => buildCsvReport());
