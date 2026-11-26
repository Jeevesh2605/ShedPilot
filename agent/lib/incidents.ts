/**
 * Incidents and their audit trail, in one DynamoDB table (see docs/ARCHITECTURE.md, section 4).
 *
 *   pk = LOCK#<service>     sk = LOCK      -> which incident is open; this is the de-duplication
 *   pk = INCIDENT#<id>      sk = META      -> status, evidence, proposal, approvals, Slack message
 *   pk = INCIDENT#<id>      sk = EVENT#... -> append-only audit trail
 *
 * Every status change is a conditional write on the expected current status, written in the same
 * transaction as its audit event. A double click or a retry therefore fails cleanly instead of
 * acting twice.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';
import type { AlarmInfo, Evidence, FlagChangeResult, HumanDecision, Proposal } from './types';

export type IncidentStatus =
  | 'INVESTIGATING'
  | 'PENDING_APPROVAL'
  | 'NO_SAFE_ACTION'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SHED'
  | 'RESTORE_PROPOSED'
  | 'RESTORE_APPROVED'
  | 'RESOLVED'
  | 'FAILED';

/** The whole state machine. Anything not listed here is not allowed. */
export const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  INVESTIGATING: ['PENDING_APPROVAL', 'NO_SAFE_ACTION'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['SHED', 'FAILED'],
  SHED: ['RESTORE_PROPOSED'],
  RESTORE_PROPOSED: ['RESTORE_APPROVED', 'SHED'],
  RESTORE_APPROVED: ['RESOLVED', 'FAILED'],
  NO_SAFE_ACTION: [],
  REJECTED: [],
  EXPIRED: [],
  RESOLVED: [],
  FAILED: [],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Terminal states that release the lock. FAILED keeps it on purpose: a human should look first. */
export const RELEASES_LOCK: IncidentStatus[] = ['NO_SAFE_ACTION', 'REJECTED', 'EXPIRED', 'RESOLVED'];

export function newIncidentId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261113-091502
  return `inc-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Thrown when a conditional status change finds the incident in a different status. */
export class TransitionConflictError extends Error {
  constructor(readonly incidentId: string, readonly expected: IncidentStatus) {
    super(`Incident ${incidentId} is no longer ${expected}`);
  }
}

export interface Incident {
  incidentId: string;
  service: string;
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
  alarm: AlarmInfo;
  [key: string]: unknown; // evidence, proposal, slack, approvals, ...
}

/** An incident after the investigator has saved its evidence and proposal. */
export interface ProposalIncident extends Incident {
  evidence: Evidence;
  proposal: Proposal;
  slack?: { channel: string; ts: string };
  shedDecision?: HumanDecision;
  restoreDecision?: HumanDecision;
  shedFlags?: string[];
  shedAt?: string;
  execution?: { results: FlagChangeResult[]; blocked: string[]; dryRun: boolean };
  guardrailRejections?: string[];
  originalActions?: Proposal['actions'];
  llm?: { provider: string; model?: string; attempts: { latencyMs?: number; error?: string; rawText?: string }[]; fellBackToRules: boolean };
  // Phase 5: recovery
  recoveryCheck?: { at: string; ready: boolean; code?: string; reason: string };
  restoreCheck?: import('../recovery/assess').Assessment & { at: string };
  restoreSlack?: { channel: string; ts: string };
  restoreExecution?: { results: FlagChangeResult[]; blocked: string[]; dryRun: boolean };
  resolvedAt?: string;
}

export interface IncidentEvent {
  at: string;
  message: string;
  from?: IncidentStatus;
  to?: IncidentStatus;
}

const META = 'META';
const incidentKey = (id: string) => ({ pk: `INCIDENT#${id}`, sk: META });
const lockKey = (service: string) => ({ pk: `LOCK#${service}`, sk: 'LOCK' });
const eventKey = (id: string, at: string) => ({ pk: `INCIDENT#${id}`, sk: `EVENT#${at}#${randomBytes(2).toString('hex')}` });

export class IncidentStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly service: string,
    client = new DynamoDBClient({}),
  ) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  /** Atomically claims the service for a new incident. Fails if another incident is open. */
  async acquireLock(incidentId: string): Promise<{ acquired: true } | { acquired: false; openIncidentId: string }> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...lockKey(this.service), incidentId, lockedAt: new Date().toISOString() },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { acquired: true };
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      const existing = await this.db.send(new GetCommand({ TableName: this.tableName, Key: lockKey(this.service) }));
      return { acquired: false, openIncidentId: String(existing.Item?.incidentId ?? 'unknown') };
    }
  }

  /** Releases the lock, but only if this incident holds it. */
  async releaseLock(incidentId: string): Promise<void> {
    try {
      await this.db.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: lockKey(this.service),
          ConditionExpression: 'incidentId = :id',
          ExpressionAttributeValues: { ':id': incidentId },
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err; // someone else's lock, or already gone: leave it
    }
  }

  async getOpenIncidentId(): Promise<string | undefined> {
    const lock = await this.db.send(new GetCommand({ TableName: this.tableName, Key: lockKey(this.service) }));
    return lock.Item?.incidentId as string | undefined;
  }

  async create(incidentId: string, alarm: AlarmInfo): Promise<void> {
    const now = new Date().toISOString();
    const incident: Incident = { incidentId, service: this.service, status: 'INVESTIGATING', createdAt: now, updatedAt: now, alarm };
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: { ...incidentKey(incidentId), ...incident }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: this.tableName, Item: { ...eventKey(incidentId, now), at: now, message: `Alarm ${alarm.name} received, investigation started` } } },
        ],
      }),
    );
  }

  async get(incidentId: string): Promise<Incident | undefined> {
    const result = await this.db.send(new GetCommand({ TableName: this.tableName, Key: incidentKey(incidentId) }));
    return result.Item as Incident | undefined;
  }

  /**
   * Moves an incident from one status to another, with extra fields and an audit event,
   * in one transaction. Throws TransitionConflictError if the incident is not in `from`.
   */
  async transition(
    incidentId: string,
    from: IncidentStatus,
    to: IncidentStatus,
    changes: Record<string, unknown>,
    eventMessage: string,
  ): Promise<void> {
    if (!canTransition(from, to)) throw new Error(`Transition ${from} -> ${to} is not allowed`);
    const now = new Date().toISOString();
    const update = buildUpdate({ ...changes, status: to, updatedAt: now });
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: incidentKey(incidentId),
                UpdateExpression: update.expression,
                ConditionExpression: '#status = :expected',
                ExpressionAttributeNames: { ...update.names, '#status': 'status' },
                ExpressionAttributeValues: { ...update.values, ':expected': from },
              },
            },
            { Put: { TableName: this.tableName, Item: { ...eventKey(incidentId, now), at: now, message: eventMessage, from, to } } },
          ],
        }),
      );
    } catch (err) {
      if (isTransactionConditionalFailure(err)) throw new TransitionConflictError(incidentId, from);
      throw err;
    }
  }

  /** Updates fields that are not the status, e.g. the Slack message reference. */
  async update(incidentId: string, changes: Record<string, unknown>): Promise<void> {
    const update = buildUpdate({ ...changes, updatedAt: new Date().toISOString() });
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: incidentKey(incidentId),
        UpdateExpression: update.expression,
        ExpressionAttributeNames: update.names,
        ExpressionAttributeValues: update.values,
      }),
    );
  }

  /** The audit trail, oldest first. */
  async listEvents(incidentId: string): Promise<IncidentEvent[]> {
    const items: IncidentEvent[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `INCIDENT#${incidentId}`, ':prefix': 'EVENT#' },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((result.Items ?? []) as IncidentEvent[]));
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return items;
  }

  async addEvent(incidentId: string, message: string, details?: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    await this.db.send(new PutCommand({ TableName: this.tableName, Item: { ...eventKey(incidentId, now), at: now, message, details } }));
  }
}

/** Pure: builds "SET #f0 = :v0, #f1 = :v1" with safe placeholder names. Exported for tests. */
export function buildUpdate(fields: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([field, value], i) => {
      names[`#f${i}`] = field;
      values[`:v${i}`] = value;
      return `#f${i} = :v${i}`;
    });
  return { expression: `SET ${parts.join(', ')}`, names, values };
}

function isConditionalFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

function isTransactionConditionalFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'TransactionCanceledException') return false;
  const reasons = (err as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === 'ConditionalCheckFailed');
}
