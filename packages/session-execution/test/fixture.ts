export const executionFor = (machineId: string) => ({ token: `me1.${machineId}.1.${"x".repeat(43)}` });
export const fixtureRuntimeGeneration = "00000000-0000-4000-8000-000000000002";
/** Fake discovery only; the real session host pins runtime identity and owns credentials. */
export async function machineFixture(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/v1/machines/")) return Response.json({ machine: { machineId: path.split("/").at(-1), connectionStatus: "ready", runtimeGeneration: fixtureRuntimeGeneration } });
}
