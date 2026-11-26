/**
 * Loads secrets from SSM Parameter Store (SecureString), once per Lambda container.
 * Secrets always live in SECRETS_REGION, even when the agent runs in another region.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { env } from './config';

const cache = new Map<string, string>();
let ssm: SSMClient | undefined;

export async function getSecret(paramEnvVar: string): Promise<string> {
  const name = env(paramEnvVar);
  const cached = cache.get(name);
  if (cached) return cached;

  ssm ??= new SSMClient({ region: env('SECRETS_REGION') });
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  cache.set(name, value);
  return value;
}
