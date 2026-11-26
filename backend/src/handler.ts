/**
 * reports-api: one Lambda behind an API Gateway HTTP API.
 *
 * Every route checks its Flagsmith flag, does real work (or a cheap degraded response when the
 * flag is off), and writes exactly one structured log line. See docs/ARCHITECTURE.md, section 3.1.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FLAG, getFlagSnapshot } from './flags';
import { RequestLog } from './requestLog';
import { buildPdfReport } from './features/pdfReport';
import { buildCsvReport } from './features/csvReport';
import { buildRichAnalytics } from './features/richAnalytics';
import { basicSummary, generateOrders } from './data';

type Result = APIGatewayProxyStructuredResultV2 & { statusCode: number };

const PDF_PAGES = Number(process.env.PDF_PAGES ?? 40);
const ANALYTICS_ROWS = Number(process.env.ANALYTICS_ROWS ?? 300_000);

export async function handler(event: APIGatewayProxyEventV2): Promise<Result> {
  const format = event.queryStringParameters?.format ?? null;
  const log = new RequestLog(event.requestContext.requestId, event.routeKey, format);

  try {
    const response = await route(event.routeKey, format, log);
    log.write(response.statusCode);
    return response;
  } catch (err) {
    // Include the error name: AWS SDK errors such as ParameterNotFound often have a vague message.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.write(500, message);
    return json(500, { error: 'internal_error' });
  }
}

async function route(routeKey: string, format: string | null, log: RequestLog): Promise<Result> {
  const flags = await getFlagSnapshot();
  log.flagsSource = flags.source;

  switch (routeKey) {
    case 'GET /api/reports':
      if (format === 'pdf') {
        if (!log.evaluated(FLAG.pdfExport, flags.enabled.pdf_export)) {
          return json(200, {
            status: 'degraded',
            message: 'PDF export is temporarily unavailable. Please download the CSV instead.',
            csv_url: '/api/reports?format=csv',
          });
        }
        const pdf = await log.timeFeature(FLAG.pdfExport, () => buildPdfReport(PDF_PAGES));
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="report.pdf"' },
          body: pdf.toString('base64'),
          isBase64Encoded: true,
        };
      }
      if (format === 'csv') {
        if (!log.evaluated(FLAG.basicCsv, flags.enabled.basic_csv)) {
          return json(200, { status: 'degraded', message: 'CSV export is temporarily unavailable.' });
        }
        const csv = await log.timeFeature(FLAG.basicCsv, () => buildCsvReport());
        return { statusCode: 200, headers: { 'content-type': 'text/csv' }, body: csv };
      }
      return json(400, { error: 'format must be pdf or csv' });

    case 'GET /api/reports/summary': {
      const summary = basicSummary(generateOrders(500));
      if (!log.evaluated(FLAG.richAnalytics, flags.enabled.rich_analytics)) {
        return json(200, { summary, analytics: null, analytics_status: 'disabled' });
      }
      const analytics = await log.timeFeature(FLAG.richAnalytics, () => buildRichAnalytics(ANALYTICS_ROWS));
      return json(200, { summary, analytics, analytics_status: 'ok' });
    }

    case 'GET /api/checkout':
      if (!log.evaluated(FLAG.checkoutCore, flags.enabled.checkout_core)) {
        return json(503, { error: 'checkout_unavailable' });
      }
      return json(200, await log.timeFeature(FLAG.checkoutCore, () => ({ status: 'ok', cart_total_rs: 4_999 })));

    default:
      return json(404, { error: 'not_found' });
  }
}

function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
