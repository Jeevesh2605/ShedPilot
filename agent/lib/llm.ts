/**
 * The LLM behind ShedPilot's proposals, behind one small interface so the provider can change.
 *
 * Two providers, chosen with LLM_PROVIDER:
 *
 * - "groq" (default): Groq's OpenAI-compatible Chat Completions with strict JSON-schema output
 *   (constrained decoding), model openai/gpt-oss-120b. Free tier: 30 requests/min, 8K tokens/min.
 *     POST https://api.groq.com/openai/v1/chat/completions   Authorization: Bearer gsk_...
 *     body: { model, messages, response_format: { type: "json_schema", json_schema: { name, strict: true, schema } } }
 *   (console.groq.com/docs: Structured Outputs, Rate Limits.)
 *
 * - "xai": xAI Grok through its Responses API with strict JSON-schema output.
 *     POST https://api.x.ai/v1/responses   Authorization: Bearer xai-...
 *     body: { model, input, text: { format: { type: "json_schema", name, schema, strict: true } }, store: false }
 *   (docs.x.ai: Responses API reference, Structured Outputs.)
 *
 * Note: Groq (groq.com, keys start with gsk_) and Grok (xAI, keys start with xai-) are different companies.
 *
 * The LLM only ever returns text. It has no tools and no credentials for Flagsmith; code parses,
 * validates and guardrails whatever it says, and a human approves before anything changes.
 *
 * Adding Claude later (Bedrock or the Anthropic API) means adding one more implementation of
 * LlmProvider here and a new LLM_PROVIDER value.
 */
import { env } from './config';
import { getSecret } from './secrets';

export interface LlmRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string; // the model's JSON, not yet parsed or trusted
  model: string;
  latencyMs: number;
}

export interface LlmProvider {
  name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class XaiProvider implements LlmProvider {
  readonly name = 'xai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        text: { format: { type: 'json_schema', name: request.schemaName, schema: request.schema, strict: true } },
        store: false, // don't keep incident data on xAI's side (the default is 30 days)
        max_output_tokens: 4000,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = (await response.json().catch(() => ({}))) as XaiResponse;
    if (!response.ok) {
      throw new Error(`xAI HTTP ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
    }
    if (body.status !== 'completed') {
      throw new Error(`xAI response status ${body.status}: ${JSON.stringify(body.incomplete_details ?? {})}`);
    }
    const text = extractOutputText(body);
    if (!text) throw new Error('xAI response had no output_text');
    return { text, model: body.model ?? this.model, latencyMs: Date.now() - started };
  }
}

export class GroqProvider implements LlmProvider {
  readonly name = 'groq';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        // Strict mode = constrained decoding: the output always matches the schema.
        response_format: { type: 'json_schema', json_schema: { name: request.schemaName, strict: true, schema: request.schema } },
        max_completion_tokens: 3000,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(`Groq HTTP ${response.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
    }
    return { text: extractChatContent(body), model: body.model ?? this.model, latencyMs: Date.now() - started };
  }
}

interface ChatCompletionResponse {
  model?: string;
  error?: unknown;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
}

/** Pure: pulls the JSON text out of a Chat Completions body, or explains why there is none. Exported for tests. */
export function extractChatContent(body: ChatCompletionResponse): string {
  const choice = body.choices?.[0];
  if (!choice?.message) throw new Error('response had no choices');
  if (choice.message.refusal) throw new Error(`model refused: ${choice.message.refusal.slice(0, 200)}`);
  if (choice.finish_reason !== 'stop') throw new Error(`generation stopped early (finish_reason ${choice.finish_reason})`);
  if (!choice.message.content) throw new Error('response had no content');
  return choice.message.content;
}

interface XaiResponse {
  status?: string;
  model?: string;
  error?: unknown;
  incomplete_details?: unknown;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
}

/** Pure: pulls the assistant's text out of a Responses API body. Exported for tests. */
export function extractOutputText(body: XaiResponse): string | undefined {
  const message = body.output?.find((item) => item.type === 'message');
  return message?.content?.find((c) => c.type === 'output_text')?.text;
}

/**
 * DEMO ONLY: a scripted "misbehaving model" that always proposes turning off checkout_core as well
 * as pdf_export. Real models usually refuse to (Groq did, even under prompt injection), so this
 * exists to show the guardrail catching an unsafe proposal. It is labelled as simulated wherever
 * its output appears, including in Slack.
 */
export class RogueDemoProvider implements LlmProvider {
  readonly name = 'rogue-demo';
  async complete(): Promise<LlmResponse> {
    const action = (flag: string, reason: string) => ({
      flag, action: 'disable', reason, evidence: 'Scripted by the rogue demo, not measured.',
      expected_effect: 'Less load.', user_impact: flag === 'checkout_core' ? 'Nobody can check out.' : 'PDF export unavailable.',
    });
    return {
      text: JSON.stringify({
        diagnosis: 'SIMULATED MISBEHAVING MODEL (demo): proposes turning off everything that uses compute, including the core checkout path.',
        actions: [action('pdf_export', 'Biggest cost.'), action('checkout_core', 'Also uses compute, so turn it off too.')],
        alternatives_considered: ['None: this scripted model always proposes the same thing.'],
        confidence: 'high',
      }),
      model: 'SIMULATED rogue model (demo)',
      latencyMs: 0,
    };
  }
}

/** Stands in for a provider that could not be set up (e.g. missing API key), so the failure is reported, not fatal. */
class UnavailableProvider implements LlmProvider {
  constructor(readonly name: string, private readonly reason: string) {}
  async complete(): Promise<LlmResponse> {
    throw new Error(this.reason);
  }
}

/** Builds the configured provider, or null when LLM_PROVIDER is "none" (rule-based only). */
export async function createProvider(): Promise<LlmProvider | null> {
  const provider = process.env.LLM_PROVIDER ?? 'none';
  if (provider === 'none') return null;
  if (provider === 'rogue-demo') return new RogueDemoProvider();
  if (provider !== 'groq' && provider !== 'xai') return new UnavailableProvider(provider, `unknown LLM_PROVIDER "${provider}"`);
  try {
    if (provider === 'groq') return new GroqProvider(await getSecret('GROQ_API_KEY_PARAM'), env('LLM_MODEL'), 45_000);
    return new XaiProvider(await getSecret('XAI_API_KEY_PARAM'), env('LLM_MODEL'), 45_000);
  } catch (err) {
    // AWS SDK errors carry the useful part in the name (e.g. ParameterNotFound).
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new UnavailableProvider(provider, `could not load the ${provider} API key (${reason})`);
  }
}
