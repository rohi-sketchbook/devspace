import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentIsolationError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  type LocalAgentIsolationMode,
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentProviderUsage,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { extractAgentCommands, inspectLocalAgentWorkspace, overlappingChangedFiles } from "./local-agent-workspace.js";
import { assertAllowedPath } from "./roots.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId: string;
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  isolation?: LocalAgentIsolationMode;
  usageThresholdPercent?: number;
}

export interface RunOverrides {
  model?: string;
  thinking?: string;
  writeMode?: LocalAgentWriteMode;
  usageThresholdPercent?: number;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentWorktreeAllocation {
  path: string;
  baseSha: string;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  createWorktree?: (workspaceRoot: string) => Promise<LocalAgentWorktreeAllocation>;
  logger?: LocalAgentManagerLogger;
}

export type AgentStartError = AgentTargetError | AgentScopeError | AgentIsolationError | AgentConflictError | AgentStoreError;
export type AgentContinueError = AgentStartError;
export type AgentControlError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly createWorktree?: (workspaceRoot: string) => Promise<LocalAgentWorktreeAllocation>;
  private readonly logger?: LocalAgentManagerLogger;
  private readonly activeTurns = new Map<string, Promise<void>>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.createWorktree = options.createWorktree;
    this.logger = options.logger;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    return this.store.reconcileActiveRunsResult(message);
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(input.workspaceRoot, "start");
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
      const target = resolveLocalAgentTarget(input.target, profiles, input.model, input.thinking);
      if (!target) {
        return Result.err(new AgentTargetError({
          code: "UNKNOWN_TARGET",
          target: input.target,
          retryable: false,
          message: `Unknown subagent profile or provider: ${input.target}.`,
        }));
      }
      if (target.kind === "profile" && target.profile.disabled) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_DISABLED",
          target: target.name,
          provider: target.provider,
          retryable: false,
          message: `Subagent profile is disabled: ${target.name}.`,
        }));
      }
      yield* manager.driverResult(target.provider, "start");
      const writeMode = input.writeMode ?? (target.kind === "profile" ? target.profile.writeMode : undefined) ?? "allowed";
      const isolation = input.isolation ?? (target.kind === "profile" ? target.profile.isolation : undefined) ?? "auto";
      const execution = yield* Result.await(manager.executionWorkspaceResult(
        workspaceRoot,
        target.provider,
        writeMode,
        isolation,
      ));
      const record = yield* manager.store.createResult({
        workspaceId: input.workspaceId,
        workspaceRoot,
        executionRoot: execution.executionRoot,
        profileName: target.name,
        provider: target.provider,
        model: target.model,
        thinking: target.thinking,
        writeMode,
        managedWorktree: execution.managedWorktree,
        baseSha: execution.baseSha,
        taskPrompt: input.prompt,
      });
      return manager.begin(record, input.prompt, {
        model: target.model,
        thinking: target.thinking,
        writeMode,
        usageThresholdPercent: input.usageThresholdPercent,
      });
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
      yield* manager.profileForRecordResult(record, profiles);
      yield* manager.driverResult(record.provider, "continue", agentId);
      return manager.begin(record, prompt, overrides);
    });
  }

  async steer(
    agentId: string,
    prompt: string,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentControlError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("steer", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "steer");
      const driver = yield* manager.driverResult(record.provider, "steer", agentId);
      const timestamp = new Date().toISOString();
      manager.store.appendEvent(agentId, "steer_requested", prompt, { provider: record.provider });
      if (!manager.activeTurns.has(agentId)) {
        return manager.begin(record, prompt, {});
      }

      const queued = yield* manager.store.updateResult(agentId, {
        pendingSteer: mergeSteeringPrompt(record.pendingSteer, prompt),
        steerRequestedAt: timestamp,
        lastActivityAt: timestamp,
      });
      if (!queued.providerSessionId) return Result.ok(queued);
      const context = manager.runtimeContext(queued, driver);
      let nativeSteer = false;
      try {
        nativeSteer = await manager.pool.steer(driver, context, queued.providerSessionId, prompt);
      } catch (error) {
        manager.log("warn", "agent_steer_native_failed", { agentId, provider: record.provider, error: errorMessage(error) });
      }
      if (!nativeSteer) return Result.ok(queued);
      manager.store.appendEvent(agentId, "steer_applied", prompt, { provider: record.provider, mode: "same_turn" });
      return manager.store.updateResult(agentId, {
        pendingSteer: undefined,
        steerRequestedAt: undefined,
        lastActivityAt: new Date().toISOString(),
      });
    });
  }

  async stop(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentControlError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("stop", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "stop");
      const timestamp = new Date().toISOString();
      manager.store.appendEvent(agentId, "stop_requested", undefined, { provider: record.provider });
      if (!manager.activeTurns.has(agentId)) {
        return manager.store.updateResult(agentId, {
          status: "stopped",
          pendingSteer: undefined,
          steerRequestedAt: undefined,
          stopRequestedAt: timestamp,
          lastActivityAt: timestamp,
        });
      }
      const driver = yield* manager.driverResult(record.provider, "stop", agentId);
      const stopping = yield* manager.store.updateResult(agentId, {
        pendingSteer: undefined,
        steerRequestedAt: undefined,
        stopRequestedAt: timestamp,
        lastActivityAt: timestamp,
      });
      if (!stopping.providerSessionId) return Result.ok(stopping);
      const interrupted = await manager.pool.interrupt(
        driver,
        manager.runtimeContext(stopping, driver),
        stopping.providerSessionId,
      );
      if (!interrupted) {
        return Result.err(new AgentConflictError({
          code: "AGENT_CONFLICT",
          agentId,
          operation: "stop",
          retryable: true,
          message: `Agent ${agentId} could not be interrupted safely because its provider runtime is shared by another active turn.`,
        }));
      }
      return Result.ok(stopping);
    });
  }

  get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentRecord, AgentLookupError> {
    const lookup = this.store.getByIdResult(agentId);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (!record) return Result.err(agentNotFound(agentId));
    const scoped = this.agentWorkspaceResult(record, scope, "get");
    if (scoped.isErr()) return scoped;
    return Result.ok(record);
  }

  list(scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord[], AgentListError> {
    return this.authorizeWorkspace(scope.workspaceRoot, "list").andThen((workspaceRoot) => (
      this.store.listResult({
        workspaceId: scope.workspaceId,
        workspaceRoot,
      })
    ));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    const turns = Array.from(this.activeTurns.values());
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRecord, AgentConflictError | AgentStoreError> {
    if (
      record.writeMode === "read_only"
      && overrides.writeMode !== undefined
      && overrides.writeMode !== "read_only"
      && !record.managedWorktree
    ) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: false,
        message: `Agent ${record.id} started read-only in the owner checkout and cannot be escalated to write access. Start a new isolated write-capable agent instead.`,
      }));
    }
    if (this.activeTurns.has(record.id)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: true,
        message: `Agent ${record.id} already has a running turn.`,
      }));
    }

    const updated = this.store.updateResult(record.id, {
      status: "running",
      model: overrides.model ?? record.model,
      thinking: overrides.thinking ?? record.thinking,
      writeMode: overrides.writeMode ?? record.writeMode ?? "allowed",
      latestResponse: undefined,
      error: undefined,
      errorCode: undefined,
      errorRetryable: undefined,
      stopRequestedAt: undefined,
      lastActivityAt: new Date().toISOString(),
    });
    if (updated.isErr()) return updated;
    this.store.appendEvent(record.id, "turn_started", prompt, { provider: record.provider });
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const turn = Promise.resolve().then(() => this.runTurn(updated.value, prompt, overrides));
    this.activeTurns.set(record.id, turn);
    void turn.catch(() => undefined);
    return updated;
  }

  private async runTurn(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, "run");
      if (authorized.isErr()) {
        await this.persistRunError(record, authorized.error, startedAt);
        return;
      }
      const workspaceRoot = authorized.value;
      const executionAuthorized = this.authorizeWorkspace(record.executionRoot ?? record.workspaceRoot, "run");
      if (executionAuthorized.isErr()) {
        await this.persistRunError(record, executionAuthorized.error, startedAt);
        return;
      }
      const executionRoot = executionAuthorized.value;
      const authorizedRecord = {
        ...record,
        workspaceRoot,
        executionRoot,
      };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
      if (profiles.isErr()) {
        await this.persistRunError(record, profiles.error, startedAt);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        await this.persistRunError(record, profile.error, startedAt);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        await this.persistRunError(record, input.error, startedAt);
        return;
      }
      const driver = this.driverResult(record.provider, "run", record.id);
      if (driver.isErr()) {
        await this.persistRunError(record, driver.error, startedAt);
        return;
      }
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.value.provider,
        workspaceRoot: executionRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        model: input.value.model,
        thinking: input.value.thinking,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        onSessionId: async (providerSessionId) => {
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value) return;
          let latest = current.value;
          if (latest.providerSessionId !== providerSessionId) {
            const updated = this.store.updateResult(record.id, {
              providerSessionId,
              lastActivityAt: new Date().toISOString(),
            });
            if (updated.isErr()) throw updated.error;
            latest = updated.value;
          }
          // `agents stop` may arrive while a provider runtime is starting, before
          // its durable session/thread ID exists. Re-check the persisted stop
          // request at the session-ID boundary and interrupt immediately so the
          // request cannot be lost in that startup race.
          if (!latest.stopRequestedAt) return;
          const interrupted = await this.pool.interrupt(
            driver.value,
            { ...context, providerSessionId },
            providerSessionId,
          );
          if (!interrupted) {
            this.log("warn", "agent_stop_deferred", {
              agentId: record.id,
              provider: record.provider,
              reason: "provider_session_started_without_safe_interrupt",
            });
          }
        },
      };
      const result = await this.pool.run(driver.value, context, input.value, callbacks);
      if (result.isErr()) {
        await this.persistRunError(record, result.error, startedAt);
        return;
      }
      const runResult = result.value;
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      if (current.value.stopRequestedAt) {
        const stopped = this.store.updateResult(record.id, {
          providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
          latestResponse: runResult.finalResponse || current.value.latestResponse,
          status: "stopped",
          pendingSteer: undefined,
          steerRequestedAt: undefined,
          stopRequestedAt: undefined,
          lastActivityAt: new Date().toISOString(),
          error: undefined,
          errorCode: undefined,
          errorRetryable: undefined,
        });
        if (stopped.isErr()) throw stopped.error;
        this.store.appendEvent(record.id, "turn_stopped", runResult.finalResponse, { provider: record.provider });
        return;
      }
      const updated = this.store.updateResult(record.id, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        latestResponse: runResult.finalResponse,
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
        handoffReason: undefined,
        providerUsage: runResult.providerUsage,
        lastActivityAt: new Date().toISOString(),
      });
      if (updated.isErr()) throw updated.error;
      await this.refreshTaskSnapshot(updated.value.id, runResult.items, runResult.providerUsage);
      this.activeTurns.delete(record.id);
      this.store.appendEvent(record.id, "turn_completed", runResult.finalResponse, {
        provider: record.provider,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      const pendingSteer = updated.value.pendingSteer?.trim();
      const completed = this.store.updateResult(updated.value.id, {
        status: "idle",
        pendingSteer: undefined,
        steerRequestedAt: undefined,
      });
      if (completed.isErr()) throw completed.error;
      const finalRecord = completed.value;
      if (pendingSteer) {
        const steered = this.begin(finalRecord, pendingSteer, {});
        if (steered.isErr()) {
          this.log("warn", "agent_queued_steer_failed", { agentId: record.id, error: steered.error.message });
        }
      }
      this.log("info", "agent_run_completed", {
        provider: finalRecord.provider,
        agentId: finalRecord.id,
        providerSessionIdPrefix: finalRecord.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      const stopState = this.store.getByIdResult(record.id);
      if (!stopState.isErr() && stopState.value?.stopRequestedAt) {
        this.store.updateResult(record.id, {
          status: "stopped",
          stopRequestedAt: undefined,
          pendingSteer: undefined,
          steerRequestedAt: undefined,
          lastActivityAt: new Date().toISOString(),
          error: undefined,
          errorCode: undefined,
          errorRetryable: undefined,
        });
        this.store.appendEvent(record.id, "turn_stopped", undefined, { provider: record.provider });
        return;
      }
      if (isLocalAgentError(error)) {
        await this.persistRunError(record, error, startedAt);
        return;
      }
      const persisted = this.store.updateResult(record.id, {
        status: "error",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: "Unexpected internal subagent failure.",
        errorType: error instanceof Error ? error.name : typeof error,
        persistenceFailed: persisted.isErr(),
      });
      throw error;
    } finally {
      this.activeTurns.delete(record.id);
    }
  }

  private async persistRunError(
    record: LocalAgentRecord,
    error: LocalAgentError,
    startedAt: number,
  ): Promise<void> {
    const current = this.store.getByIdResult(record.id);
    if (!current.isErr() && current.value?.stopRequestedAt) {
      this.store.updateResult(record.id, {
        status: "stopped",
        stopRequestedAt: undefined,
        pendingSteer: undefined,
        steerRequestedAt: undefined,
        lastActivityAt: new Date().toISOString(),
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
      });
      this.store.appendEvent(record.id, "turn_stopped", undefined, { provider: record.provider });
      return;
    }
    const handoffReason = handoffReasonForError(error);
    const persisted = this.store.updateResult(record.id, {
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
      handoffReason,
    });
    this.log("error", "agent_run_failed", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: error.code,
      error: error.message,
      causeType: safeCauseType("cause" in error ? error.cause : undefined),
      persistenceFailed: persisted.isErr(),
    });
    if (!persisted.isErr()) {
      this.store.appendEvent(record.id, "turn_failed", error.message, {
        provider: record.provider,
        errorCode: error.code,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      const cause = "cause" in error ? error.cause : undefined;
      await this.refreshTaskSnapshot(record.id, cause, providerUsageFromCause(cause), handoffReason);
      this.activeTurns.delete(record.id);
      this.store.updateResult(record.id, { status: "error" });
    }
  }

  private runtimeContext(record: LocalAgentRecord, driver: LocalAgentDriver): LocalAgentRuntimeContext {
    return {
      agentId: record.id,
      provider: driver.provider,
      workspaceRoot: record.executionRoot ?? record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: record.writeMode,
      model: record.model,
      thinking: record.thinking,
      agentDir: this.agentDir,
    };
  }

  private async executionWorkspaceResult(
    workspaceRoot: string,
    provider: LocalAgentProvider,
    writeMode: LocalAgentWriteMode,
    isolation: LocalAgentIsolationMode,
  ): Promise<BetterResult<{ executionRoot: string; managedWorktree: boolean; baseSha?: string }, AgentIsolationError>> {
    const autoIsolate = isolation === "auto" && provider === "codex" && writeMode !== "read_only";
    const mustIsolate = isolation === "worktree" && writeMode !== "read_only";
    if (!autoIsolate && !mustIsolate) {
      return Result.ok({ executionRoot: workspaceRoot, managedWorktree: false });
    }
    if (!this.createWorktree) {
      if (mustIsolate) {
        return Result.err(new AgentIsolationError({
          code: "WORKTREE_CREATE_FAILED",
          workspaceRoot,
          operation: "start",
          retryable: false,
          message: "This DevSpace runtime cannot create an isolated subagent worktree.",
        }));
      }
      return Result.ok({ executionRoot: workspaceRoot, managedWorktree: false });
    }
    try {
      const worktree = await this.createWorktree(workspaceRoot);
      return Result.ok({
        executionRoot: resolve(worktree.path),
        managedWorktree: true,
        baseSha: worktree.baseSha,
      });
    } catch (cause) {
      const code = gitWorktreeCauseCode(cause);
      return Result.err(new AgentIsolationError({
        code: code === "GIT_SOURCE_DIRTY" ? "WORKTREE_SOURCE_DIRTY" : "WORKTREE_CREATE_FAILED",
        workspaceRoot,
        operation: "start",
        retryable: false,
        cause,
        message: code === "GIT_SOURCE_DIRTY"
          ? "The source workspace has uncommitted changes, so DevSpace kept this write task with the host instead of starting Codex from a stale HEAD."
          : `Unable to create an isolated subagent worktree: ${errorMessage(cause)}`,
      }));
    }
  }

  private async refreshTaskSnapshot(
    agentId: string,
    items?: unknown,
    providerUsage?: LocalAgentProviderUsage,
    handoffReason?: string,
  ): Promise<void> {
    const currentResult = this.store.getByIdResult(agentId);
    if (currentResult.isErr() || !currentResult.value) return;
    const current = currentResult.value;
    const snapshot = await inspectLocalAgentWorkspace(current.executionRoot ?? current.workspaceRoot);
    const commands = Array.from(new Set([
      ...(current.commandsRun ?? []),
      ...extractAgentCommands(items),
    ])).slice(-64);
    const updated = this.store.updateResult(agentId, {
      changedFiles: snapshot.changedFiles,
      commandsRun: commands,
      ...(providerUsage ? { providerUsage } : {}),
      ...(handoffReason ? { handoffReason } : {}),
    });
    if (updated.isErr()) return;
    await this.recomputeConflictState({
      workspaceId: current.workspaceId ?? "",
      workspaceRoot: current.workspaceRoot,
    });
  }

  private async recomputeConflictState(scope: LocalAgentWorkspaceScope): Promise<void> {
    if (!scope.workspaceId) return;
    const listed = this.store.listResult(scope);
    if (listed.isErr()) return;
    const records = listed.value.filter((record) => record.managedWorktree && (record.changedFiles?.length ?? 0) > 0);
    const conflicts = new Map<string, Set<string>>();
    const ownerSnapshot = await inspectLocalAgentWorkspace(scope.workspaceRoot);
    for (const record of records) {
      const ownerOverlap = overlappingChangedFiles(record.changedFiles, ownerSnapshot.changedFiles);
      if (ownerOverlap.length === 0) continue;
      const set = conflicts.get(record.id) ?? new Set<string>();
      for (const path of ownerOverlap) set.add(path);
      conflicts.set(record.id, set);
    }
    for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
      const left = records[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
        const right = records[rightIndex];
        if (!right) continue;
        const overlap = overlappingChangedFiles(left.changedFiles, right.changedFiles);
        if (overlap.length === 0) continue;
        const leftSet = conflicts.get(left.id) ?? new Set<string>();
        const rightSet = conflicts.get(right.id) ?? new Set<string>();
        for (const path of overlap) {
          leftSet.add(path);
          rightSet.add(path);
        }
        conflicts.set(left.id, leftSet);
        conflicts.set(right.id, rightSet);
      }
    }
    for (const record of records) {
      const files = Array.from(conflicts.get(record.id) ?? []).sort((a, b) => a.localeCompare(b));
      const nextHandoffReason = files.length > 0
        ? (record.handoffReason ?? "file_conflict")
        : (record.handoffReason === "file_conflict" ? undefined : record.handoffReason);
      this.store.updateResult(record.id, {
        conflictFiles: files,
        handoffReason: nextHandoffReason,
      });
    }
  }

  private buildRunInputResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRunInput, AgentTargetError> {
    const isRawProvider = record.profileName === record.provider;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    const body = profile?.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    return Result.ok({
      prompt: fullPrompt,
      workspaceRoot: record.executionRoot ?? record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: overrides.writeMode ?? record.writeMode ?? profile?.writeMode ?? "allowed",
      model: record.model ?? profile?.model,
      thinking: record.thinking ?? profile?.thinking,
      modelOverrideRequested: overrides.model !== undefined,
      thinkingOverrideRequested: overrides.thinking !== undefined,
      usageThresholdPercent: overrides.usageThresholdPercent ?? (record.provider === "codex" ? 90 : undefined),
    });
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    if (record.profileName === record.provider) return Result.ok(undefined);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    if (profile.disabled) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: profile.name,
        provider: profile.provider,
        retryable: false,
        message: `Subagent profile is disabled: ${profile.name}.`,
      }));
    }
    return Result.ok(profile);
  }

  private driverResult(
    provider: string,
    operation: string,
    agentId?: string,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    const driver = this.drivers.get(provider);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? provider,
        provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    return Result.ok(driver);
  }

  private acceptingResult(
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentConflictError> {
    if (this.accepting) return Result.ok(undefined);
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation,
      retryable: false,
      message: "Local agent manager is closed.",
    }));
  }

  private authorizeWorkspace(
    workspaceRoot: string,
    operation: string,
  ): BetterResult<string, AgentScopeError> {
    const normalized = resolve(workspaceRoot);
    if (!this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private agentWorkspaceResult(
    record: LocalAgentRecord,
    scope: LocalAgentWorkspaceScope,
    operation: string,
  ): BetterResult<void, AgentScopeError> {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, operation);
    if (workspaceRoot.isErr()) return workspaceRoot;
    if (workspaceRoot.value !== record.workspaceRoot || record.workspaceId !== scope.workspaceId) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_MISMATCH",
        agentId: record.id,
        workspaceId: scope.workspaceId,
        operation,
        retryable: false,
        message: `Subagent ${record.id} belongs to a different workspace.`,
      }));
    }
    return Result.ok(undefined);
  }

  private async loadProfilesResult(
    workspaceRoot: string,
    target: string,
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target,
        retryable: false,
        cause,
        message: "Unable to load subagent profiles.",
      }));
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function mergeSteeringPrompt(current: string | undefined, next: string): string {
  const trimmed = next.trim();
  if (!current?.trim()) return trimmed;
  return `${current.trim()}\n\nAdditional steering:\n${trimmed}`.slice(0, 16_384);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitWorktreeCauseCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function handoffReasonForError(error: LocalAgentError): string | undefined {
  if (error.code === "PROVIDER_USAGE_LIMIT") return "usage_limit";
  if (
    error.code === "PROVIDER_EXECUTION_ERROR"
    || error.code === "PROVIDER_PROTOCOL_ERROR"
    || error.code === "PROVIDER_UNAVAILABLE"
  ) {
    return "provider_failure";
  }
  return undefined;
}

function providerUsageFromCause(cause: unknown): LocalAgentProviderUsage | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const direct = (cause as { providerUsage?: unknown }).providerUsage;
  if (!direct || typeof direct !== "object" || Array.isArray(direct)) return undefined;
  const record = direct as Record<string, unknown>;
  return {
    usedPercent: typeof record.usedPercent === "number" ? record.usedPercent : undefined,
    remainingPercent: typeof record.remainingPercent === "number" ? record.remainingPercent : undefined,
    resetsAt: typeof record.resetsAt === "number" ? record.resetsAt : undefined,
    source: typeof record.source === "string" ? record.source : undefined,
  };
}

function safeCauseType(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (cause && typeof cause === "object" && "error" in cause) {
    const nested = (cause as { error?: unknown }).error;
    if (nested instanceof Error) return nested.name;
  }
  return cause === undefined ? undefined : typeof cause;
}

function agentNotFound(agentId: string): AgentTargetError {
  return new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: agentId,
    retryable: false,
    message: `Unknown subagent id: ${agentId}.`,
  });
}
