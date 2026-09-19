import { ContractException } from "./errors.ts";
import { parseJsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import type { SessionId } from "./session.ts";
import { nonemptyString, record } from "./validation.ts";

/** Unique within a session; supplied by the producer for retry deduplication. */
export type EventId = string;

export interface EventBody {
  type: string;
  payload: JsonValue;
}

export interface SubmitInputRequest {
  eventId: EventId;
  event: EventBody;
}

export interface InputEnvelope<Event extends EventBody = EventBody> {
  eventId: EventId;
  /** Positive safe integer assigned in admission order within the session. */
  sequence: number;
  /** Original admission time in Unix milliseconds. */
  receivedAt: number;
  event: Event;
}

/** Durable admission, not confirmation that the harness processed the input. */
export interface InputReceipt {
  sessionId: SessionId;
  eventId: EventId;
  sequence: number;
  receivedAt: number;
  duplicate: boolean;
}

/** Validate the generic body. The harness validates its supported types/payloads. */
export function parseEventBody(value: unknown): EventBody {
  const event = record(parseJsonValue(value, "INVALID_INPUT"), ["type", "payload"], "event", "INVALID_INPUT");
  if (!Object.hasOwn(event, "payload")) {
    throw new ContractException("INVALID_INPUT", "event.payload is required.");
  }
  return {
    type: nonemptyString(event.type, "event.type", "INVALID_INPUT"),
    payload: event.payload!,
  };
}

export function parseSubmitInputRequest(value: unknown): SubmitInputRequest {
  const request = record(parseJsonValue(value), ["eventId", "event"], "request");
  return {
    eventId: nonemptyString(request.eventId, "eventId"),
    event: parseEventBody(request.event),
  };
}
