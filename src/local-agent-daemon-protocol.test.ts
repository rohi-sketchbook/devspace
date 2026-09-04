import assert from "node:assert/strict";
import {
  decodeAgentRecord,
  decodeLocalAgentDaemonRequest,
  decodeLocalAgentDaemonResponse,
  encodeLocalAgentDaemonRequest,
  encodeLocalAgentDaemonResponse,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";

const request = decodeLocalAgentDaemonRequest({
  requestId: "req_1",
  protocolVersion: 1,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "Review this",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
    writeMode: "read_only",
  },
});
assert.equal(request.method, "agent.start");
if (request.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(request.params.writeMode, "read_only");
assert.match(encodeLocalAgentDaemonRequest(request), /"method":"agent.start"/);

const whitespaceRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_whitespace",
  protocolVersion: 1,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "  keep prompt whitespace  \n",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
  },
});
if (whitespaceRequest.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(whitespaceRequest.params.prompt, "  keep prompt whitespace  \n");

const steerRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_steer",
  protocolVersion: 3,
  authToken: "test-secret",
  method: "agent.steer",
  params: {
    id: "agt_1234",
    prompt: "focus on tests",
    scope: { workspaceId: "ws_test", workspaceRoot: "/tmp/project" },
  },
});
assert.equal(steerRequest.method, "agent.steer");
if (steerRequest.method !== "agent.steer") throw new Error("expected agent.steer request");
assert.equal(steerRequest.params.prompt, "focus on tests");

const stopRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_stop",
  protocolVersion: 3,
  authToken: "test-secret",
  method: "agent.stop",
  params: {
    id: "agt_1234",
    scope: { workspaceId: "ws_test", workspaceRoot: "/tmp/project" },
  },
});
assert.equal(stopRequest.method, "agent.stop");

assert.throws(
  () => decodeLocalAgentDaemonRequest({
    requestId: "req_2",
    protocolVersion: 1,
    authToken: "test-secret",
    method: "agent.start",
    params: { target: "reviewer", prompt: "" },
  }),
  (error: unknown) => error instanceof LocalAgentDaemonProtocolError && error.code === "INVALID_PARAMS",
);

const record = decodeAgentRecord({
  id: "agt_1234",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "idle",
  latestResponse: "  response whitespace  \n",
  pendingSteer: "next direction",
  steerRequestedAt: "steer-at",
  stopRequestedAt: "stop-at",
  lastActivityAt: "activity-at",
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(record.id, "agt_1234");
assert.equal(record.latestResponse, "  response whitespace  \n");
assert.equal(record.pendingSteer, "next direction");
assert.equal(record.lastActivityAt, "activity-at");

const response = decodeLocalAgentDaemonResponse({
  requestId: "req_1",
  protocolVersion: 1,
  ok: true,
  result: record,
});
assert.equal(response.ok, true);

const errorResponse = decodeLocalAgentDaemonResponse(JSON.parse(encodeLocalAgentDaemonResponse({
  requestId: "req_error",
  protocolVersion: 1,
  ok: false,
  error: {
    code: "PROVIDER_UNAVAILABLE",
    message: "Codex executable was not found.",
    retryable: false,
    provider: "codex",
    agentId: "agt_1234",
    operation: "create_runtime",
  },
}))) ;
assert.equal(errorResponse.ok, false);
if (!errorResponse.ok) {
  assert.equal(errorResponse.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(errorResponse.error.retryable, false);
  assert.equal(errorResponse.error.provider, "codex");
  assert.equal(errorResponse.error.agentId, "agt_1234");
  assert.equal(errorResponse.error.operation, "create_runtime");
}

const failedRecord = decodeAgentRecord({
  id: "agt_error",
  workspaceId: "ws_error",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "error",
  error: "Timed out waiting for the local agent daemon.",
  errorCode: "DAEMON_TIMEOUT",
  errorRetryable: true,
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(failedRecord.errorCode, "DAEMON_TIMEOUT");
assert.equal(failedRecord.errorRetryable, true);
