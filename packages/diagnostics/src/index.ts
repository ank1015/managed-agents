export interface LogSettings {
  LOG_SUCCESS_SAMPLE_RATE?: string;
  LOG_DEBUG?: string;
}
export interface LogFields {
  stage?: string;
  sessionId?: string;
  operationId?: string;
  gatewayJobId?: string;
  errorCode?: string;
  outcome?: string;
  retryable?: boolean;
  blocked?: boolean;
  attempt?: number;
  durationMs?: number;
  httpStatus?: number;
}
export type LogLevel = "info" | "warn" | "error";
type RecordValue = Record<string, string | number | boolean>;
type Sink = (level: LogLevel, record: RecordValue) => void;
const sink: Sink = (level, record) => { console[level](record); };
const identifier = /^(?:ses_[0-9a-f-]{36}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|replay-v1:[1-9][0-9]{0,15}:[a-f0-9]{64})$/;
const label = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
function rate(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0.01;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.01;
}
/** Stable session sampling across Workers, with no storage or network calls. */
export function sampled(sessionId: string, fraction: number): boolean {
  let hash = 2166136261;
  for (let i = 0; i < sessionId.length; i++) hash = Math.imul(hash ^ sessionId.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296 < fraction;
}
/** Payloads and Error objects are intentionally not accepted. Runtime projection
 * also drops unknown fields, even if a caller bypasses the TypeScript contract. */
export class Logger {
  readonly service: string;
  readonly emit: Sink;
  readonly #rate: number;
  readonly #debug: boolean;
  constructor(service: string, settings: LogSettings = {}, emit: Sink = sink) {
    this.service = service;
    this.emit = emit;
    this.#rate = rate(settings.LOG_SUCCESS_SAMPLE_RATE);
    this.#debug = settings.LOG_DEBUG === "true";
  }
  error(event: string, fields: LogFields = {}): void { this.#write("error", event, fields); }
  warn(event: string, fields: LogFields = {}): void { this.#write("warn", event, fields); }
  success(event: string, fields: LogFields): void {
    if (this.#debug || (fields.sessionId && sampled(fields.sessionId, this.#rate))) this.#write("info", event, fields);
  }
  /** Unauthenticated traffic must never force an unsampled log per request. */
  rejection(event: string, fields: LogFields = {}): void {
    if (Math.random() < 0.01) this.#write("warn", event, fields);
  }
  #write(level: LogLevel, event: string, fields: LogFields): void {
    try {
      if (!label.test(event) || !label.test(this.service)) return;
      const record: RecordValue = { service: this.service, event };
      for (const key of ["stage", "errorCode", "outcome"] as const) {
        const value = fields[key];
        if (typeof value === "string" && label.test(value)) record[key] = value;
      }
      for (const key of ["sessionId", "operationId", "gatewayJobId"] as const) {
        const value = fields[key];
        if (typeof value === "string" && identifier.test(value)) record[key] = value;
      }
      for (const key of ["retryable", "blocked"] as const) if (typeof fields[key] === "boolean") record[key] = fields[key];
      for (const key of ["attempt", "durationMs", "httpStatus"] as const) {
        const value = fields[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = Math.round(value);
      }
      this.emit(level, record);
    } catch { /* Diagnostics must never fail or delay application work. */ }
  }
}
