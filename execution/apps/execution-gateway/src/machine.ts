import { DurableObject } from "cloudflare:workers";
import {
  authenticateManagement, bearer, bool, bytes, canonical, configured, deadline, digest, errorResponse,
  GatewayError, hashJson, hello, identity, integer, invalid, issueMachineSecret, jsonResponse,
  jsonValue, messageText, MAX_FRAME_BYTES, MAX_HTTP_BYTES, MAX_NATIVE_BYTES, object, outcome, readJson,
  routingFields, secretKind, sha256, signRoutingEnvelope, submission, text, uuid, verifyRoutingEnvelope,
} from "@managed-agents/execution-gateway-protocol";
import type { CompletionEvent, CompletionReceiver, Hello, MachineView } from "@managed-agents/execution-gateway-protocol";
import { authorize } from "./credentials.ts";
import { Registry } from "./registry.ts";
import type { MachineRow } from "./registry.ts";
import type { Env } from "./types.ts";
interface Attachment { machineId: string; epoch: number; credentialVersion: number; connectedAt: number; lastMessageAt: number; hello: Hello | null }
interface Pending { machineId: string; epoch: number; requestId: string; requestHash: string; runtimeGeneration: string; resolve: (value: Response) => void; reject: (error: Error) => void }
export class Machine extends DurableObject<Env> {
  private readonly registry: Registry;
  private readonly pending = new Map<string, Pending>();
  private deliveries = 0;
  private submissions = 0;
  private bufferedBytes = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); this.registry = new Registry(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("execution:ping", "execution:pong"));
  }
  private limit(name: keyof Env, fallback: number, min: number, max: number): number { return configured(this.env[name], fallback, min, max); }
  private reserve(size: number): void {
    if (this.bufferedBytes + size > this.limit("MAX_BUFFERED_BYTES", 16 * 1024 * 1024, MAX_FRAME_BYTES, 64 * 1024 * 1024)) {
      throw new GatewayError(429, "BUFFER_CAPACITY", "In-flight payload budget exhausted; retry later.", true);
    }
    this.bufferedBytes += size;
  }
  private attachment(ws: WebSocket): Attachment { return ws.deserializeAttachment() as Attachment; }
  private current(ws: WebSocket): Attachment {
    const a = this.attachment(ws), row = this.registry.get();
    if (row.machine_id !== a.machineId || row.daemon_version !== a.credentialVersion) throw new GatewayError(401, "CREDENTIAL_REVOKED", "Daemon secret changed.");
    if (row.connection_epoch !== a.epoch || ws.readyState !== WebSocket.OPEN) throw new GatewayError(409, "CONNECTION_REPLACED", "Connection was replaced.");
    return a;
  }
  private socket(row: MachineRow): WebSocket | undefined {
    return this.ctx.getWebSockets().find(ws => {
      const a = this.attachment(ws);
      return !row.deleted && ws.readyState === WebSocket.OPEN && a.epoch === row.connection_epoch && a.credentialVersion === row.daemon_version;
    });
  }
  private view(row: MachineRow): MachineView {
    const ws = this.socket(row), a = ws ? this.attachment(ws) : null, h = a?.hello;
    const metadata = h ?? (row.daemon ? JSON.parse(row.daemon) as Hello : null);
    return { machineId: row.machine_id, name: row.name, deleted: !!row.deleted,
      daemonSecretVersion: row.daemon_version, executionSecretVersion: row.execution_version,
      connectionEpoch: row.connection_epoch, createdAt: row.created_at, lastConnectedAt: row.last_connected_at, lastDisconnectedAt: row.last_disconnected_at,
      connectionStatus: h ? "ready" : ws ? "connecting" : "offline", runtimeGeneration: h?.runtimeGeneration ?? null,
      lastSeenAt: ws ? Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, a!.lastMessageAt) : null,
      daemon: metadata ? { daemonVersion: metadata.daemonVersion, os: metadata.os, arch: metadata.arch, operations: metadata.operations } : null };
  }
  private closeConnections(reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws); this.rejectWaiters(a.machineId, a.epoch);
      this.registry.disconnected(a.epoch); ws.close(4001, reason);
    }
  }
  private rejectWaiters(machineId: string, epoch: number): void {
    for (const pending of this.pending.values()) if (pending.machineId === machineId && pending.epoch === epoch) {
      pending.reject(new GatewayError(503, "SUBMISSION_UNCERTAIN", "Connection ended before acceptance was confirmed; retry the same request.", true, true));
    }
  }
  private receiver(name: string): CompletionReceiver {
    let routes: Record<string, unknown>;
    try { routes = object(JSON.parse(this.env.CALLBACK_ROUTES)); } catch { throw new GatewayError(503, "CALLBACK_CONFIGURATION", "Callback routes are not configured."); }
    const binding = Object.hasOwn(routes, name) ? routes[name] : undefined;
    const receiver = typeof binding === "string" && /^[A-Z][A-Z0-9_]*$/.test(binding) ? this.env[binding] as CompletionReceiver | undefined : undefined;
    if (!receiver || typeof receiver.acceptExecutionResult !== "function") throw new GatewayError(503, "CALLBACK_UNAVAILABLE", "Result receiver is unavailable.", true);
    return receiver;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const id = uuid(request.headers.get("X-Execution-Machine")), url = new URL(request.url);
      if (this.ctx.id.toString() !== this.env.MACHINES.idFromName(id).toString()) throw new GatewayError(403, "WRONG_MACHINE", "Machine does not own this object.");
      if (url.search) throw invalid("Query parameters are not supported.");
      if (url.pathname === "/register" && request.method === "POST") {
        await authenticateManagement(request, this.env.MANAGEMENT_SECRET);
        const body = object(await readJson(request, 16384), ["machineId", "name"]);
        if (uuid(body.machineId) !== id) throw invalid("Machine identity mismatch.");
        const name = text(body.name, 128);
        const daemonSecret = await issueMachineSecret(this.env.CREDENTIAL_SIGNING_SECRET, id, "daemon", 1);
        const executionSecret = await issueMachineSecret(this.env.CREDENTIAL_SIGNING_SECRET, id, "execution", 1);
        const daemonHash = await sha256(daemonSecret), executionHash = await sha256(executionSecret);
        const { row, duplicate } = this.registry.register(id, name, daemonHash, executionHash);
        return jsonResponse({ machine: this.view(row), daemonSecret, executionSecret, duplicate }, duplicate ? 200 : 201);
      }
      if (url.pathname === "/secrets/rotate" && request.method === "POST") {
        await authenticateManagement(request, this.env.MANAGEMENT_SECRET);
        const body = object(await readJson(request, 1024), ["kind", "expectedVersion"]);
        const kind = secretKind(body.kind), expected = integer(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1);
        this.registry.get();
        const secret = await issueMachineSecret(this.env.CREDENTIAL_SIGNING_SECRET, id, kind, expected + 1);
        const { row, changed } = this.registry.rotate(kind, expected, await sha256(secret));
        if (changed && kind === "daemon") this.closeConnections("Daemon secret rotated");
        return jsonResponse({ machineId: id, kind, version: row[`${kind}_version`], secret });
      }
      if (url.pathname === "/" && request.method === "DELETE") {
        await authenticateManagement(request, this.env.MANAGEMENT_SECRET);
        this.registry.delete(); this.closeConnections("Machine deleted");
        return jsonResponse({ deleted: true, machineId: id });
      }
      if (url.pathname === "/" && request.method === "GET") {
        const row = await authorize(this.registry, id, bearer(request), "execution");
        return jsonResponse({ machine: this.view(row) });
      }
      if (url.pathname === "/connect") return await this.connectDaemon(request, id);
      if (url.pathname === "/requests" && request.method === "POST") {
        if (this.submissions >= this.limit("MAX_PENDING_SUBMISSIONS", 8, 1, 64)) throw new GatewayError(429, "SUBMISSION_CAPACITY", "Too many acceptance waits; no request was sent.", true);
        this.submissions++; let reserved = 0;
        try { return await this.submit(request, id, size => { this.reserve(size); reserved += size; }); }
        finally { this.submissions--; this.bufferedBytes -= reserved; }
      }
      throw new GatewayError(405, "METHOD_NOT_ALLOWED", "Method is not supported for this route.");
    } catch (error) { return errorResponse(error); }
  }
  private async connectDaemon(request: Request, id: string): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new GatewayError(426, "WEBSOCKET_REQUIRED", "Use a WebSocket upgrade.");
    await authorize(this.registry, id, bearer(request), "daemon");
    const old = this.ctx.getWebSockets(), row = this.registry.connected();
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ machineId: id, epoch: row.connection_epoch, credentialVersion: row.daemon_version,
      connectedAt: row.last_connected_at!, lastMessageAt: row.last_connected_at!, hello: null } satisfies Attachment);
    for (const ws of old) { this.rejectWaiters(id, this.attachment(ws).epoch); ws.close(4001, "Connection replaced"); }
    server.send(JSON.stringify({ type: "welcome", protocolVersion: 1, machineId: id, connectionEpoch: row.connection_epoch }));
    return new Response(null, { status: 101, webSocket: client });
  }
  private async submit(request: Request, id: string, reserve: (size: number) => void): Promise<Response> {
    const token = bearer(request);
    await authorize(this.registry, id, token, "execution");
    const body = submission(await readJson(request, MAX_HTTP_BYTES, 8000, reserve));
    this.receiver(body.callback.receiver);
    const requestHash = await hashJson(jsonValue({ machineId: id, ...body }));
    const routingEnvelope = await signRoutingEnvelope(this.env.ROUTING_SIGNING_SECRET, {
      machineId: id, runtimeGeneration: body.runtimeGeneration, requestId: body.requestId, requestHash, callback: body.callback,
    });
    // Every await before dispatch may admit a concurrent rotation/deletion/reconnect.
    const row = await authorize(this.registry, id, token, "execution"), ws = this.socket(row), h = ws ? this.attachment(ws).hello : null;
    if (!ws || !h) throw new GatewayError(503, "MACHINE_OFFLINE", "Machine is not ready; no request was sent.", true);
    if (h.runtimeGeneration !== body.runtimeGeneration) throw new GatewayError(409, "RUNTIME_GENERATION_MISMATCH", "Runtime changed; do not replay into a new generation.");
    if (!h.operations.includes(body.operation.operation)) throw invalid("Daemon does not support this operation.");
    if (this.pending.size >= this.limit("MAX_PENDING_SUBMISSIONS", 8, 1, 64)) throw new GatewayError(429, "SUBMISSION_CAPACITY", "Too many acceptance waits; no request was sent.", true);
    const dispatchId = crypto.randomUUID(); let resolve!: (value: Response) => void, reject!: (error: Error) => void;
    const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    this.pending.set(dispatchId, { machineId: id, epoch: row.connection_epoch, requestId: body.requestId, requestHash, runtimeGeneration: body.runtimeGeneration, resolve, reject });
    try {
      ws.send(JSON.stringify({ type: "request", protocolVersion: 1, dispatchId, requestId: body.requestId, requestHash,
        runtimeGeneration: body.runtimeGeneration, operation: body.operation, routingEnvelope }));
      return await deadline(promise, this.limit("ACCEPT_TIMEOUT_MS", 5000, 10, 30000), new GatewayError(504, "SUBMISSION_UNCERTAIN", "Daemon acceptance was not confirmed; retry the same request.", true, true));
    } finally { this.pending.delete(dispatchId); }
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let reserved = 0;
    try {
      const a = this.current(ws); a.lastMessageAt = Date.now(); ws.serializeAttachment(a);
      if (typeof raw !== "string") throw invalid("Use JSON text frames.");
      if (bytes(raw) > MAX_FRAME_BYTES) { ws.close(1009, "Frame exceeds limit"); return; }
      const size = bytes(raw);
      try { this.reserve(size); reserved = size; }
      catch { ws.close(1013, "Payload capacity; reconnect and retry"); this.rejectWaiters(a.machineId, a.epoch); return; }
      const message = object(jsonValue(JSON.parse(raw)));
      if (message.type === "hello") {
        const h = hello(message);
        if (a.hello && canonical(jsonValue(a.hello)) !== canonical(jsonValue(h))) throw invalid("Reconnect to change daemon identity or capabilities.");
        if (!a.hello) { a.hello = h; ws.serializeAttachment(a); this.registry.metadata(JSON.stringify(h)); }
        ws.send(JSON.stringify({ type: "ready", protocolVersion: 1, connectionEpoch: a.epoch, runtimeGeneration: h.runtimeGeneration })); return;
      }
      if (!a.hello) throw invalid("Send hello before other messages.");
      if (message.type === "accepted" || message.type === "rejected") {
        object(message, ["type", "dispatchId", "requestId", "requestHash", "runtimeGeneration", "error"]);
        const dispatchId = uuid(message.dispatchId), pending = this.pending.get(dispatchId);
        if (!pending) return; // Timed-out/superseded HTTP attempt; caller retries.
        if (pending.machineId !== a.machineId || pending.epoch !== a.epoch || pending.requestId !== message.requestId || pending.requestHash !== message.requestHash || pending.runtimeGeneration !== message.runtimeGeneration) throw invalid("Acceptance does not match dispatch.");
        if (message.type === "accepted") {
          pending.resolve(jsonResponse({ status: "accepted", machineId: a.machineId, requestId: pending.requestId, requestHash: pending.requestHash, runtimeGeneration: pending.runtimeGeneration }, 202));
        } else {
          const e = object(message.error, ["code", "message", "retryable", "uncertain"]), uncertain = bool(e.uncertain), retryable = bool(e.retryable);
          pending.reject(new GatewayError(uncertain ? 503 : retryable ? 429 : 409, identity(e.code), messageText(e.message, 4096), retryable, uncertain));
        }
        return;
      }
      if (message.type === "result") { await this.deliver(ws, a, message); return; }
      throw invalid("Unknown daemon message.");
    } catch (error) {
      const e = error instanceof GatewayError ? error : invalid("Invalid daemon message.");
      try { ws.send(JSON.stringify({ type: "protocol_error", error: { code: e.code, message: e.message } })); ws.close(1008, "Protocol or authorization error"); } catch { /* peer already closed */ }
      const a = this.attachment(ws); this.rejectWaiters(a.machineId, a.epoch);
    } finally { this.bufferedBytes -= reserved; }
  }
  private async deliver(ws: WebSocket, a: Attachment, message: Record<string, unknown>): Promise<void> {
    object(message, ["type", "deliveryId", "routingEnvelope", "outcome"]);
    const deliveryId = digest(message.deliveryId);
    if (this.deliveries >= this.limit("MAX_CONCURRENT_DELIVERIES", 16, 1, 16)) {
      ws.send(JSON.stringify({ type: "result_nack", deliveryId, error: { code: "DELIVERY_CAPACITY", retryable: true } })); return;
    }
    this.deliveries++;
    try {
      const envelope = routingFields(await verifyRoutingEnvelope(this.env.ROUTING_SIGNING_SECRET, this.env.ROUTING_PREVIOUS_SIGNING_SECRET, text(message.routingEnvelope, 32768)));
      if (envelope.machineId !== a.machineId) throw new GatewayError(403, "RESULT_FORBIDDEN", "Routing envelope belongs to another machine.");
      // Saved results from an earlier core generation may be delivered by a newly
      // connected daemon; the envelope and receiver bind their original generation.
      const result = outcome(message.outcome);
      if (bytes(JSON.stringify(result)) > MAX_NATIVE_BYTES) throw new GatewayError(413, "RESULT_TOO_LARGE", "Native result exceeds limit.");
      const resultHash = await hashJson(jsonValue(result));
      if (deliveryId !== await hashJson({ requestHash: envelope.requestHash, resultHash })) throw invalid("Delivery ID does not match result.");
      this.current(ws); // Authorization might have changed during signature/hash work.
      const event: CompletionEvent = { protocolVersion: 1, ...envelope, deliveryId, resultHash, outcome: result };
      const receipt = await deadline(this.receiver(envelope.callback.receiver).acceptExecutionResult(event), this.limit("CALLBACK_TIMEOUT_MS", 8000, 10, 30000),
        new GatewayError(504, "CALLBACK_TIMEOUT", "Receiver admission was not confirmed.", true, true));
      const r = object(receipt);
      if (r.status === "rejected") {
        throw new GatewayError(409, identity(r.code), "Receiver rejected admission.", bool(r.retryable));
      }
      if (r.status !== "accepted" || r.deliveryId !== deliveryId || r.requestId !== envelope.requestId || r.requestHash !== envelope.requestHash || r.resultHash !== resultHash) {
        throw new GatewayError(503, "INVALID_CALLBACK_RECEIPT", "Receiver did not confirm matching durable admission.", true, true);
      }
      // No durable acknowledgement before the receiver's matching receipt.
      ws.send(JSON.stringify({ type: "result_ack", deliveryId, requestId: envelope.requestId, requestHash: envelope.requestHash, resultHash }));
    } catch (error) {
      const e = error instanceof GatewayError ? error : new GatewayError(503, "CALLBACK_UNAVAILABLE", "Receiver admission was not confirmed.", true, true);
      try { ws.send(JSON.stringify({ type: "result_nack", deliveryId, error: { code: e.code, retryable: e.retryable, uncertain: e.uncertain } })); } catch { /* daemon retries after reconnect */ }
    } finally { this.deliveries--; }
  }
  webSocketClose(ws: WebSocket): void {
    const a = this.attachment(ws); this.registry.disconnected(a.epoch); this.rejectWaiters(a.machineId, a.epoch);
    // Complete the close handshake even when the peer put us in CLOSING.
    if (ws.readyState !== WebSocket.CLOSED) ws.close(1000, "Closed");
  }
  webSocketError(ws: WebSocket): void {
    const a = this.attachment(ws); this.registry.disconnected(a.epoch); this.rejectWaiters(a.machineId, a.epoch);
    if (ws.readyState !== WebSocket.CLOSED) ws.close(1011, "Connection error");
  }
}
