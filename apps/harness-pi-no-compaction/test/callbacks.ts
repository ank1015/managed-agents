import { machineFixture } from "../../../packages/session-execution/test/fixture.ts";
export default {
  async fetch(request: Request, env: any) {
    const machine = await machineFixture(request);
    if (machine) return machine;
    const name = new URL(request.url).pathname.slice(1).toUpperCase();
    return Response.json(await env[name].acceptExecutionResult(await request.json()));
  }
};
