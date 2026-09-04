import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import type { LocalAgentProviderUsage, LocalAgentWriteMode } from "./local-agent-runtime.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  executionRoot?: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  managedWorktree?: boolean;
  baseSha?: string;
  taskPrompt?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  changedFiles?: string[];
  commandsRun?: string[];
  conflictFiles?: string[];
  handoffReason?: string;
  providerUsage?: LocalAgentProviderUsage;
  pendingSteer?: string;
  steerRequestedAt?: string;
  stopRequestedAt?: string;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId: string;
  workspaceRoot: string;
  executionRoot?: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  managedWorktree?: boolean;
  baseSha?: string;
  taskPrompt?: string;
}

export interface LocalAgentWorkspaceScope {
  workspaceId: string;
  workspaceRoot: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LocalAgentRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  execution_root: string | null;
  profile_name: string;
  provider: string;
  model: string | null;
  thinking: string | null;
  write_mode: string | null;
  managed_worktree: string | null;
  base_sha: string | null;
  task_prompt: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  changed_files_json: string | null;
  commands_run_json: string | null;
  conflict_files_json: string | null;
  handoff_reason: string | null;
  provider_usage_json: string | null;
  pending_steer: string | null;
  steer_requested_at: string | null;
  stop_requested_at: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      executionRoot: resolve(input.executionRoot ?? input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      writeMode: input.writeMode,
      managedWorktree: input.managedWorktree,
      baseSha: input.baseSha,
      taskPrompt: input.taskPrompt,
      status: "starting",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          execution_root,
          profile_name,
          provider,
          model,
          thinking,
          write_mode,
          managed_worktree,
          base_sha,
          task_prompt,
          status,
          last_activity_at,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.executionRoot ?? record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.thinking ?? null,
        record.writeMode ?? null,
        record.managedWorktree === undefined ? null : String(record.managedWorktree),
        record.baseSha ?? null,
        record.taskPrompt ?? null,
        record.status,
        record.lastActivityAt ?? record.updatedAt,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Identity lookup is exact and never falls back to provider session IDs.
   */
  get(id: string): LocalAgentRecord | undefined {
    return this.getById(id);
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          execution_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          thinking = ?,
          write_mode = ?,
          managed_worktree = ?,
          base_sha = ?,
          task_prompt = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          changed_files_json = ?,
          commands_run_json = ?,
          conflict_files_json = ?,
          handoff_reason = ?,
          provider_usage_json = ?,
          pending_steer = ?,
          steer_requested_at = ?,
          stop_requested_at = ?,
          last_activity_at = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        resolve(updated.executionRoot ?? updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.thinking ?? null,
        updated.writeMode ?? null,
        updated.managedWorktree === undefined ? null : String(updated.managedWorktree),
        updated.baseSha ?? null,
        updated.taskPrompt ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        encodeStringArray(updated.changedFiles),
        encodeStringArray(updated.commandsRun),
        encodeStringArray(updated.conflictFiles),
        updated.handoffReason ?? null,
        updated.providerUsage ? JSON.stringify(updated.providerUsage) : null,
        updated.pendingSteer ?? null,
        updated.steerRequestedAt ?? null,
        updated.stopRequestedAt ?? null,
        updated.lastActivityAt ?? updated.updatedAt,
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  appendEvent(agentId: string, eventType: string, content?: string, metadata?: Record<string, unknown>): void {
    const createdAt = new Date().toISOString();
    this.database.sqlite
      .prepare(`insert into local_agent_events (agent_id, event_type, content, metadata_json, created_at) values (?, ?, ?, ?, ?)`)
      .run(agentId, eventType, content?.slice(0, 16_384) ?? null, metadata ? JSON.stringify(metadata) : null, createdAt);
    this.database.sqlite.exec(`
      delete from local_agent_events
      where id in (
        select id from local_agent_events order by created_at desc, id desc limit -1 offset 5000
      );
    `);
  }

  listEvents(agentId: string, limit = 50): Array<{
    id: number;
    agentId: string;
    eventType: string;
    content?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }> {
    const max = Math.max(1, Math.min(Math.trunc(limit) || 50, 500));
    const rows = this.database.sqlite.prepare(`
      select id, agent_id, event_type, content, metadata_json, created_at
      from local_agent_events where agent_id = ?
      order by created_at desc, id desc limit ?
    `).all(agentId, max) as Array<{
      id: number; agent_id: string; event_type: string; content: string | null; metadata_json: string | null; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      eventType: row.event_type,
      content: row.content ?? undefined,
      metadata: decodeMetadata(row.metadata_json),
      createdAt: row.created_at,
    }));
  }

  reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running."): number {
    const now = new Date().toISOString();
    const result = this.database.sqlite
      .prepare(
        `update local_agent_sessions
         set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
         where status in ('starting', 'running')`,
      )
      .run(message, now);
    return Number(result.changes);
  }

  reconcileActiveRunsResult(
    message = "DevSpace restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  close(): void {
    this.database.close();
  }

}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    executionRoot: row.execution_root ?? row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    writeMode: readWriteMode(row.write_mode),
    managedWorktree: readOptionalBoolean(row.managed_worktree),
    baseSha: row.base_sha ?? undefined,
    taskPrompt: row.task_prompt ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    changedFiles: decodeStringArray(row.changed_files_json),
    commandsRun: decodeStringArray(row.commands_run_json),
    conflictFiles: decodeStringArray(row.conflict_files_json),
    handoffReason: row.handoff_reason ?? undefined,
    providerUsage: decodeProviderUsage(row.provider_usage_json),
    pendingSteer: row.pending_steer ?? undefined,
    steerRequestedAt: row.steer_requested_at ?? undefined,
    stopRequestedAt: row.stop_requested_at ?? undefined,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeStringArray(value: string[] | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

function decodeProviderUsage(value: string | null): LocalAgentProviderUsage | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LocalAgentProviderUsage
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readWriteMode(value: string | null): LocalAgentWriteMode | undefined {
  if (value === "read_only" || value === "allowed" || value === "full_access") return value;
  return undefined;
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(new AgentStoreError(operation, cause));
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}
