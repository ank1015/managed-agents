import {
  ContractException, PI_BASH_OPERATION, PI_BASH_RECEIVER, parseBashInput, parseBashSubmission, parseProviderStatusQuery,
  parseJsonValue, parseOperationOutcome, parseExecutionGatewayEvent,
} from "@managed-agents/contracts";
import type { OperationFailure, ProviderSubmitResult, ProviderStatusResult, OperationOutcome, GatewayEventReceipt } from "@managed-agents/contracts";
import { canonical, sha256 } from "./crypto.ts";
import { Gateway, submissionRejected, terminal } from "./gateway.ts";
import { Store } from "./store.ts";
import type { OperationRow } from "./store.ts";
import { sessionNamespace } from "./types.ts";
import type { Env, Work } from "./types.ts";

export class BashService {
  readonly store: Store;
  constructor(readonly env: Env) { this.store = new Store(env.BASH_DB); }

  async submit(value: unknown): Promise<ProviderSubmitResult> {
    let parsed, input;
    try {
      parsed = parseBashSubmission(value);
      const request = parsed.submission.request;
      if (request.provider !== PI_BASH_OPERATION.provider || request.type !== PI_BASH_OPERATION.type || request.version !== PI_BASH_OPERATION.version) {
        return { status: "rejected", error: { code: "UNSUPPORTED_PI_BASH_OPERATION", message: "Expected tool-pi-bash/bash/v1." } };
      }
      input = parseBashInput(request.input);
    } catch (error) {
      if (!(error instanceof ContractException)) throw error;
      return { status: "rejected", error: { code: "INVALID_BASH_REQUEST", message: error.message } };
    }
    sessionNamespace(this.env, parsed.destination);
    const key = `pi-bash-v1:${await sha256(parsed.submission.submissionId)}`;
    const hash = await sha256(canonical(parseJsonValue({ ...parsed.submission.request, input })));
    let row = await this.store.reserve(parsed, input, hash, key);
    let terminalWakeup = row.state === "terminal";
    if (row.state === "rejected") return { status: "rejected", error: JSON.parse(row.rejection_json!) as OperationFailure };
    if (!row.gateway_job_id) {
      try {
        const accepted = await new Gateway(this.env).submit(input, key, row.submission_id);
        row = await this.store.bindJob(row.submission_id, accepted.id);
        terminalWakeup ||= row.state === "terminal";
        if (terminal(accepted.status)) {
          await this.store.terminal(row.submission_id);
          terminalWakeup = true;
        }
      } catch (error) {
        if (!submissionRejected(error)) throw error;
        const failure = { code: error.code, message: `Gateway rejected this submission (${error.code}).` };
        await this.store.reject(row.submission_id, failure);
        row = (await this.store.operation(row.submission_id))!;
        // A concurrently admitted callback/acceptance wins over an obsolete rejection.
        if (row.state === "rejected") return { status: "rejected", error: JSON.parse(row.rejection_json!) as OperationFailure };
        if (!row.gateway_job_id) throw new Error("Submission outcome remains uncertain.");
      }
    }
    // Terminal callbacks are the normal wake-up. The retained next_attempt_at plus cron
    // repairs a lost callback without polling every newly accepted execution.
    if (terminalWakeup) await this.enqueue({ kind: "operation", id: row.submission_id });
    return { status: "accepted", jobId: row.gateway_job_id! };
  }

  /** The router authenticates the webhook. This binding durably admits a wake-up, not a result. */
  async admitGatewayEvent(value: unknown): Promise<{ receipt: GatewayEventReceipt; work: Work; deferToQueue: boolean }> {
    const event = parseExecutionGatewayEvent(value);
    if (event.clientContext.receiver !== PI_BASH_RECEIVER) throw new Error("Event targets a different tool receiver.");
    // A callback may arrive while the session's submission call is still on the stack. Calling
    // that same Durable Object back before submit returns would be re-entrant, so only this rare
    // early-callback case uses the Queue handoff. Normal accepted jobs stay on the inline path.
    const before = await this.store.operation(event.clientContext.reference);
    const deferToQueue = before?.state === "submitting";
    // Reservation exists before POST; even an early callback needs no gateway lookup or separate event table.
    const operation = await this.store.admitEvent(event);
    return {
      receipt: { status: "accepted", eventId: event.eventId, jobId: event.jobId, clientContext: event.clientContext },
      work: { kind: "operation", id: operation.submission_id },
      deferToQueue,
    };
  }

  async get(value: unknown): Promise<ProviderStatusResult> {
    const query = parseProviderStatusQuery(value);
    const row = await this.store.operation(query.submissionId);
    if (!row) return { status: "missing" };
    if (row.operation_id !== query.operationId || row.gateway_job_id !== query.jobId || row.state === "rejected") {
      throw new Error("Status query does not match the retained operation.");
    }
    const outcome = await this.result(row);
    if (!outcome) return { status: "pending" };
    await this.store.terminal(row.submission_id);
    await this.enqueue({ kind: "operation", id: row.submission_id });
    return { status: "completed", outcome };
  }

  /** Poll metadata while pending; known terminal jobs need only a single detail read. */
  private async result(row: OperationRow): Promise<OperationOutcome | null> {
    const gateway = new Gateway(this.env);
    if (row.state === "terminal" && row.gateway_job_id) {
      return gateway.outcome({ id: row.gateway_job_id, idempotencyKey: row.gateway_key, machineId: row.machine_id }, row.timeout_seconds);
    }
    const found = await gateway.lookup(row.gateway_key);
    if (!found) {
      if (row.gateway_job_id) throw new Error("Accepted gateway job is missing; it will not be resubmitted.");
      return null; // The session still owns its input and submission retries.
    }
    if (found.machineId !== row.machine_id) throw new Error("Gateway job belongs to a different machine.");
    await this.store.bindJob(row.submission_id, found.id);
    if (!terminal(found.status)) return null;
    // Retain the terminal observation even if result retrieval/delivery fails, avoiding another lookup on retry.
    await this.store.terminal(row.submission_id);
    return gateway.outcome(found, row.timeout_seconds);
  }

  /** Returns a queue retry delay; D1 remains the recovery source if queue retries are exhausted. */
  async process(work: Work): Promise<number | undefined> {
    const claim = await this.store.claim(work);
    if (!claim) return;
    try {
      const operation = claim;
      const outcome = await this.result(operation);
      if (!outcome) return this.store.retry(work, operation.lease_token!, operation.attempts, null, true);
      const latest = (await this.store.operation(operation.submission_id))!;
      await this.store.terminal(operation.submission_id);
      const namespace = sessionNamespace(this.env, { routeKey: operation.route_key, sessionId: operation.session_id });
      const completion = { provider: "tool-pi-bash", operationId: operation.operation_id, submissionId: operation.submission_id,
        jobId: latest.gateway_job_id!, outcome: parseOperationOutcome(outcome) };
      const reply: unknown = JSON.parse(await deliveryDeadline(namespace.get(namespace.idFromName(operation.session_id))
        .sessionRequest(JSON.stringify({ action: "acceptCompletion", value: completion }))));
      if (!validReceipt(reply, operation.operation_id)) throw new Error("Session did not acknowledge durable completion admission.");
      await this.store.delivered(operation.submission_id, operation.lease_token!);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Operation delivery failed.";
      return this.store.retry(work, claim.lease_token!, claim.attempts, message);
    }
  }

  /** Continue immediately after durable callback admission; Queue and cron are fallbacks. */
  async kick(work: Work): Promise<void> {
    try {
      const delay = await this.process(work);
      if (delay !== undefined) await this.enqueue(work, delay);
    } catch {
      await this.enqueue(work);
    }
  }
  async enqueue(work: Work, delaySeconds?: number): Promise<void> {
    try { await this.env.COMPLETIONS.send(work, delaySeconds === undefined ? undefined : { delaySeconds }); }
    catch { console.error("BASH work enqueue failed; persisted work remains eligible for scheduled recovery."); }
  }
  async recover(): Promise<void> {
    const due = await this.store.due();
    if (due.length) await this.env.COMPLETIONS.sendBatch(due.map(({ kind, id }) => ({ body: { kind, id } })));
  }
}
/** RPC cannot be aborted. A late admission is safe: retries use the same completion identity. */
async function deliveryDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Session completion admission timed out.")), 10_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function validReceipt(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("value" in value)) return false;
  const receipt = value.value;
  return !!receipt && typeof receipt === "object" && "operationId" in receipt && receipt.operationId === operationId
    && "eventId" in receipt && receipt.eventId === `runtime:operation:${operationId}`
    && "duplicate" in receipt && typeof receipt.duplicate === "boolean";
}
