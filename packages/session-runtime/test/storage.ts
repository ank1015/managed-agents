import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import type { DriverStorage } from "../src/index.ts";

export class Storage implements DriverStorage {
  db = new DatabaseSync(":memory:");
  queries: string[] = [];
  alarm: number | null = null;
  alarmCalls = { get: 0, set: 0, delete: 0 };
  getHook: (() => void | Promise<void>) | undefined;
  setHook: (() => void | Promise<void>) | undefined;
  afterSetHook: (() => void | Promise<void>) | undefined;
  deleteHook: (() => void | Promise<void>) | undefined;
  sql = { exec: (query: string, ...bindings: SQLInputValue[]) => {
    this.queries.push(query);
    const rows = this.db.prepare(query).all(...bindings);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; },
      [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  constructor() { this.db.exec("PRAGMA foreign_keys = ON"); }
  transactionSync<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT test_tx");
    try { const result = fn(); this.db.exec("RELEASE test_tx"); return result; }
    catch (e) { this.db.exec("ROLLBACK TO test_tx; RELEASE test_tx"); throw e; }
  }
  async getAlarm() { this.alarmCalls.get++; await this.getHook?.(); return this.alarm; }
  async setAlarm(at: number | Date) { this.alarmCalls.set++; await this.setHook?.(); this.alarm = Number(at); await this.afterSetHook?.(); }
  async deleteAlarm() { this.alarmCalls.delete++; await this.deleteHook?.(); this.alarm = null; }
  due() { this.db.exec("UPDATE runtime_inbox SET retry_at = 0 WHERE consumed_at IS NULL"); this.alarm = null; }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
