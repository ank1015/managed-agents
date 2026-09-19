import {
  ContractException, LLM_OPERATION, parseLlmInput, parseLlmSubmission, parseProviderStatusQuery,
  parseJsonValue, parseOperationOutcome,
} from "@managed-agents/contracts";
import type { OperationFailure, ProviderSubmitResult, ProviderStatusResult, OperationOutcome } from "@managed-agents/contracts";
import { canonical, sha256 } from "./crypto.ts";
import { Gateway, submissionRejected, terminal } from "./gateway.ts";
import { Store } from "./store.ts";
import type { EventRow, OperationRow } from "./store.ts";
import { sessionNamespace } from "./types.ts";
import type { Env, Work } from "./types.ts";

export class LlmService {
  readonly store: Store;
  constructor(readonly env: Env) { this.store = new Store(env.LLM_DB); }

  async submit(value: unknown): Promise<ProviderSubmitResult> {
    let parsed, input;
    try {
      parsed = parseLlmSubmission(value);
      const request = parsed.submission.request;
      if (request.provider !== LLM_OPERATION.provider || request.type !== LLM_OPERATION.type || request.version !== LLM_OPERATION.version) {
        return { status: "rejected", error: { code: "UNSUPPORTED_LLM_OPERATION", message: "Expected llm/generate/v1." } };
      }
      input = parseLlmInput(request.input);
    } catch (error) {
      if (!(error instanceof ContractException)) throw error;
      return { status: "rejected", error: { code: "INVALID_LLM_REQUEST", message: error.message } };
    }
    sessionNamespace(this.env, parsed.destination);
    const key = `ma-v1:${await sha256(parsed.submission.submissionId)}`;
    const hash = await sha256(canonical(parseJsonValue({ ...parsed.submission.request, input })));
    let row = await this.store.reserve(parsed, hash, key);
    let terminalWakeup = row.state === "terminal";
    if (row.state === "rejected") return { status: "rejected", error: JSON.parse(row.rejection_json!) as OperationFailure };
    if (!row.gateway_job_id) {
      try {
        const accepted = await new Gateway(this.env).submit(input, key);
        row = await this.store.bindJob(row.submission_id, accepted.id);
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
    // A normal acceptance is pending. Its authenticated terminal webhook is the hot-path wake-up;
    // the retained next_attempt_at timestamp plus cron repairs a lost webhook without an eager poll.
    if (terminalWakeup) await this.enqueue({ kind: "operation", id: row.submission_id });
    return { status: "accepted", jobId: row.gateway_job_id! };
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

  /** Poll metadata only while pending; fetch the complete response only for a terminal job. */
  private async result(row: OperationRow): Promise<OperationOutcome | null> {
    const gateway = new Gateway(this.env);
    if (row.state === "terminal" && row.gateway_job_id) {
      return gateway.outcome({ id: row.gateway_job_id, idempotencyKey: row.gateway_key });
    }
    const found = await gateway.lookup(row.gateway_key);
    if (!found) {
      if (row.gateway_job_id) throw new Error("Accepted gateway job is missing; it will not be resubmitted.");
      return null; // The session still owns its input and submission retries.
    }
    await this.store.bindJob(row.submission_id, found.id);
    if (!terminal(found.status)) return null;
    return gateway.outcome(found);
  }

  /** Returns a queue retry delay; D1 remains the recovery source if queue retries are exhausted. */
  async process(work: Work): Promise<number | undefined> {
    const claim = await this.store.claim(work);
    if (!claim) return;
    try {
      if (work.kind === "event") {
        const event = claim as EventRow;
        let operation = await this.store.byJob(event.job_id);
        if (!operation) {
          // An early callback may precede recording POST's response. Recover through its stable key.
          const detail = await new Gateway(this.env).detail(event.job_id);
          operation = await this.store.byKey(detail.metadata.idempotencyKey);
        }
        if (!operation) throw new Error("Authenticated webhook has no matching operation reservation.");
        await this.store.bindJob(operation.submission_id, event.job_id);
        await this.store.terminal(operation.submission_id);
        await this.store.processed(event.event_id, event.lease_token!);
        const next: Work = { kind: "operation", id: operation.submission_id };
        // Continue directly after durable event transfer. If the delivery needs a retry, only
        // that operation (not the already-processed webhook event) is queued.
        try {
          const delay = await this.process(next);
          if (delay !== undefined) await this.enqueue(next, delay);
        } catch {
          await this.enqueue(next);
        }
        return;
      }
      const operation = claim as OperationRow;
      const outcome = await this.result(operation);
      if (!outcome) return this.store.retry(work, operation.lease_token!, operation.attempts, null, true);
      const latest = (await this.store.operation(operation.submission_id))!;
      await this.store.terminal(operation.submission_id);
      const namespace = sessionNamespace(this.env, { routeKey: operation.route_key, sessionId: operation.session_id });
      const completion = { provider: "llm", operationId: operation.operation_id, submissionId: operation.submission_id,
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

  /** Best-effort low-latency execution; durable D1 state and cron remain the final recovery source. */
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
    catch { console.error("LLM work enqueue failed; persisted work remains eligible for scheduled recovery."); }
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
