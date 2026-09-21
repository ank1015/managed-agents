import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseOperationDefinition, parseOperationRequest, parseOperationOutcome, parseOperationCompletion,
  parseProviderSubmitResult, ContractException,
  parseProviderSubmission,
} from "../src/index.ts";

test("operation declarations require an exact provider/type/version and exclude input or transport", () => {
  const definition = { provider: "echo", type: "echo", version: "v1" };
  assert.deepEqual(parseOperationDefinition(definition), definition);
  for (const value of [
    { ...definition, provider: "" }, { ...definition, type: " " }, { ...definition, version: undefined },
    { ...definition, input: null }, { ...definition, url: "https://worker/" },
  ]) assert.throws(() => parseOperationDefinition(value), ContractException);
});

test("operation requests require immutable-versioned JSON content and reject transport fields", () => {
  const valid = { provider: "echo", type: "echo", version: "v1", input: null };
  assert.deepEqual(parseOperationRequest(valid), valid);
  for (const bad of [
    { ...valid, version: " " }, { ...valid, input: undefined }, { ...valid, provider: "" },
    { ...valid, callbackUrl: "https://caller/" }, { ...valid, operationId: "caller-picked" },
    { ...valid, input: new Date() },
  ]) assert.throws(() => parseOperationRequest(bad), ContractException);
});

test("terminal outcomes and submission results are separate strict variants", () => {
  for (const value of [
    { status: "succeeded", result: null },
    { status: "failed", origin: "execution", error: { code: "ERROR", message: "failed", details: { attempt: 1 } } },
    { status: "failed", origin: "submission", error: { code: "REJECTED", message: "rejected" } },
    { status: "cancelled" },
  ]) assert.deepEqual(parseOperationOutcome(value), value);
  for (const value of [
    { status: "pending" }, { status: "succeeded" }, { status: "cancelled", result: null },
    { status: "failed", origin: "timeout", error: { code: "error", message: "oops" } },
  ]) assert.throws(() => parseOperationOutcome(value), ContractException);
  for (const value of [
    { status: "accepted", jobId: "job" },
    { status: "completed", jobId: "job", outcome: { status: "succeeded", result: 1 } },
    { status: "rejected", error: { code: "no", message: "no" } },
  ]) assert.deepEqual(parseProviderSubmitResult(value), value);
  assert.throws(() => parseProviderSubmitResult({ status: "accepted", jobId: "job", outcome: null }));
  assert.throws(() => parseProviderSubmitResult({ status: "accepted", jobId: "" }));
});

test("completion admission requires the complete provider/submission/job correlation", () => {
  const value = { operationId: "op", submissionId: "submission", provider: "echo", jobId: "job", outcome: { status: "succeeded", result: 2 } };
  assert.deepEqual(parseOperationCompletion(value), value);
  for (const key of Object.keys(value)) {
    const bad = { ...value } as Record<string, unknown>;
    delete bad[key];
    assert.throws(() => parseOperationCompletion(bad), ContractException);
  }
  assert.throws(() => parseOperationCompletion({ ...value, outcome: {
    status: "failed", origin: "submission", error: { code: "REJECTED", message: "not accepted" },
  } }), /accepted provider job/);
});

test("provider submissions preserve correlation and reject extra fields", () => {
  const submission = { operationId: "op", submissionId: "stable", request: { provider: "echo", type: "echo", version: "v1", input: null } };
  assert.deepEqual(parseProviderSubmission(submission), submission);
  assert.throws(() => parseProviderSubmission({ ...submission, callbackUrl: "https://other/" }));
});
