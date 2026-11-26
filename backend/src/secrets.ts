/**
 * Loads a secret once per Lambda container.
 *
 * In AWS the value lives in SSM Parameter Store as a SecureString, and the Lambda gets only the
 * parameter *name* in an environment variable. For local runs you can set the value directly.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const loaded = new Map<string, string>();
let ssm: SSMClient | undefined;

/**
 * @param valueEnvVar  env var holding the secret itself (local development only)
 * @param paramEnvVar  env var holding the SSM parameter name (used in AWS)
 */
export async function getSecret(valueEnvVar: string, paramEnvVar: string): Promise<string> {
  const direct = process.env[valueEnvVar];
  if (direct) return direct;

  const paramName = process.env[paramEnvVar];
  if (!paramName) {
    throw new Error(`Set ${valueEnvVar} (local) or ${paramEnvVar} (SSM parameter name)`);
  }

  const existing = loaded.get(paramName);
  if (existing) return existing;

  ssm ??= new SSMClient({});
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${paramName} is empty`);
  loaded.set(paramName, value);
  return value;
}
