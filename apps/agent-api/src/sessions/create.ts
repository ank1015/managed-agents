import { ContractException, parseCreateSessionRequest, parseJsonValue } from "@managed-agents/contracts";
import type { CreateSessionResult, InitializeSessionResult } from "@managed-agents/contracts";
import { callSession, creationRoute } from "../harness-routing.ts";
import type { Env } from "../types.ts";
import { SessionDirectory, throwCreationFailure } from "./directory.ts";

export async function createSession(env: Env, value: unknown): Promise<CreateSessionResult> {
  const request = parseCreateSessionRequest(value);
  const directory = new SessionDirectory(env.SESSION_DIRECTORY);
  const { entry, duplicate } = await directory.reserve(request, () => creationRoute(request.harness).key);
  throwCreationFailure(entry);
  try {
    // Idempotent even if the previous request died after initialization or the ready write.
    const initialized = await callSession<InitializeSessionResult>(env, entry.route_key, entry.session_id, {
      action: "initialize", value: parseJsonValue({ session: { sessionId: entry.session_id,
        harness: JSON.parse(entry.harness_json) }, config: request.config }),
    });
    if (entry.creation_state !== "ready") await directory.ready(entry.session_id);
    return { session: initialized.session, duplicate };
  } catch (error) {
    // Only definitive config rejection becomes terminal. Transport/storage failures remain retryable.
    if (error instanceof ContractException && error.code === "INVALID_CONFIG") await directory.fail(entry.session_id, error.toJSON());
    throw error;
  }
}
