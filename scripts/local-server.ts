/**
 * Runs the real reports-api Lambda handler on http://localhost:3000, for quick local checks.
 * It reads FLAGSMITH_SERVER_KEY from .env. With no valid key, every flag uses its fail-safe default.
 *
 *   npm run local
 *   curl 'http://localhost:3000/api/reports?format=pdf' -o report.pdf
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

if (existsSync('.env')) process.loadEnvFile('.env');
const { handler } = await import('../backend/src/handler');

const ROUTES = ['/api/reports', '/api/reports/summary', '/api/checkout'];
const port = Number(process.env.PORT ?? 3000);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const routeKey = ROUTES.includes(url.pathname) ? `${req.method} ${url.pathname}` : '$default';
  const event = {
    routeKey,
    rawPath: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: { requestId: randomUUID() },
  } as unknown as APIGatewayProxyEventV2;

  const result = await handler(event);
  res.writeHead(result.statusCode, result.headers as Record<string, string>);
  res.end(result.isBase64Encoded ? Buffer.from(String(result.body), 'base64') : result.body);
}).listen(port, () => console.log(`reports-api running on http://localhost:${port}`));
