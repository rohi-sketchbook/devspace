import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { LocalAgentStore } from "./local-agent-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-local-agent-store-test-"));
const stores: LocalAgentStore[] = [];

try {
  const store = new LocalAgentStore(root);
  stores.push(store);
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.6-terra",
    thinking: "high",
    writeMode: "allowed",
    executionRoot: join(root, "worktree"),
    managedWorktree: true,
    baseSha: "abc123",
    taskPrompt: "implement feature",
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "starting");
  assert.equal(store.getById(created.id)?.thinking, "high");
  assert.equal(store.getById(created.id)?.profileName, "reviewer");
  assert.equal(store.getById(created.id.slice(0, 7)), undefined);

  const updated = store.update(created.id, {
    status: "error",
    latestResponse: "done",
    providerSessionId: "thread_123",
    thinking: "medium",
    error: "Codex executable was not found.",
    errorCode: "PROVIDER_UNAVAILABLE",
    errorRetryable: false,
    changedFiles: ["src/a.ts"],
    commandsRun: ["npm test"],
    conflictFiles: ["src/a.ts"],
    handoffReason: "file_conflict",
    providerUsage: { usedPercent: 42, remainingPercent: 58, source: "codex" },
  });

  assert.equal(updated.status, "error");
  assert.equal(updated.thinking, "medium");
  assert.equal(updated.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(updated.errorRetryable, false);
  assert.equal(store.getById("thread_123"), undefined);
  const storedError = store.getById(created.id);
  assert.equal(storedError?.error, "Codex executable was not found.");
  assert.equal(storedError?.errorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(storedError?.errorRetryable, false);
  assert.equal(storedError?.executionRoot, join(root, "worktree"));
  assert.equal(storedError?.managedWorktree, true);
  assert.equal(storedError?.baseSha, "abc123");
  assert.equal(storedError?.taskPrompt, "implement feature");
  assert.deepEqual(storedError?.changedFiles, ["src/a.ts"]);
  assert.deepEqual(storedError?.commandsRun, ["npm test"]);
  assert.deepEqual(storedError?.conflictFiles, ["src/a.ts"]);
  assert.equal(storedError?.handoffReason, "file_conflict");
  assert.equal(storedError?.providerUsage?.usedPercent, 42);
  const controlled = store.update(created.id, {
    pendingSteer: "focus on tests",
    steerRequestedAt: "2026-09-04T00:00:00.000Z",
    stopRequestedAt: "2026-09-04T00:01:00.000Z",
    lastActivityAt: "2026-09-04T00:02:00.000Z",
  });
  assert.equal(controlled.pendingSteer, "focus on tests");
  assert.equal(store.getById(created.id)?.lastActivityAt, "2026-09-04T00:02:00.000Z");
  store.appendEvent(created.id, "turn_completed", "done", { durationMs: 123 });
  const events = store.listEvents(created.id);
  assert.equal(events[0]?.eventType, "turn_completed");
  assert.equal(events[0]?.content, "done");
  assert.equal(events[0]?.metadata?.durationMs, 123);
  assert.equal(store.update(created.id, { latestResponse: undefined }).latestResponse, undefined);
  assert.deepEqual(
    store.list({ workspaceRoot: join(root, "project") }).map((agent) => agent.latestResponse),
    [undefined],
  );
assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
assert.deepEqual(store.list({ workspaceId: "ws_1", workspaceRoot: join(root, "other") }), []);
assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

  const otherStore = new LocalAgentStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, createdFromOtherStore.id].sort(),
  );

  const legacyStateDir = join(root, "legacy-state");
  mkdirSync(legacyStateDir, { recursive: true });
  const legacy = new Database(databasePath(legacyStateDir));
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    create table local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );
  `);
  const migration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  for (const [version, name] of [[1, "workspace-state"], [2, "oauth-state"], [3, "local-agent-sessions"], [4, "workspace-conversation-bindings"]] as const) {
    migration.run(version, name, "2026-08-01T00:00:00.000Z");
  }
  legacy.prepare(`
    insert into local_agent_sessions (
      id, workspace_root, profile_name, provider, status, error, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "agt_legacy",
    join(root, "legacy-project"),
    "reviewer",
    "codex",
    "error",
    "old error",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  legacy.close();

  const upgradedStore = new LocalAgentStore(legacyStateDir);
  stores.push(upgradedStore);
  const legacyRecord = upgradedStore.getById("agt_legacy");
  assert.equal(legacyRecord?.error, "old error");
  assert.equal(legacyRecord?.errorCode, undefined);
  assert.equal(legacyRecord?.errorRetryable, undefined);
  const upgradedRecord = upgradedStore.update("agt_legacy", {
    errorCode: "DAEMON_TIMEOUT",
    errorRetryable: true,
  });
  assert.equal(upgradedRecord.errorCode, "DAEMON_TIMEOUT");
  assert.equal(upgradedRecord.errorRetryable, true);
  const reloadedRecord = upgradedStore.getById("agt_legacy");
  assert.equal(reloadedRecord?.error, "old error");
  assert.equal(reloadedRecord?.errorCode, "DAEMON_TIMEOUT");
  assert.equal(reloadedRecord?.errorRetryable, true);
  assert.equal(reloadedRecord?.lastActivityAt, "2026-08-01T00:00:00.000Z");
  upgradedStore.appendEvent("agt_legacy", "migrated", "legacy history");
  assert.equal(upgradedStore.listEvents("agt_legacy")[0]?.content, "legacy history");
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
