import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = "test-socket";
process.env.HERDR_PANE_ID = "w1:p1";

const { default: herdrLive } = await import("./herdr-live.ts");

function setup(t, { file = "/sessions/root.jsonl", idle = true, mode = "tui", activate = herdrLive } = {}) {
  const sent = [];
  const events = new EventEmitter();
  const lifecycle = new EventEmitter();
  const ctx = {
    mode,
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => "root-id",
    },
  };

  t.mock.method(net, "createConnection", () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.write = (line) => {
      sent.push(JSON.parse(line));
      socket.emit("data");
    };
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  activate({ events, on: lifecycle.on.bind(lifecycle) });

  let checked = 0;
  return {
    sent,
    emit: (event, data) => events.emit(event, data),
    fire(event, data = {}) {
      if (event === "agent_start") idle = false;
      if (event === "agent_settled") idle = true;
      lifecycle.emit(event, data, ctx);
    },
    async expectState(state, message) {
      await setImmediate();
      assert.ok(sent.length > checked, `Expected a new ${state} report`);
      checked = sent.length;
      const latest = sent.at(-1);
      assert.equal(latest.method, "pane.report_agent");
      assert.equal(latest.params.state, state);
      assert.equal(latest.params.message, message);
      assert.ok(latest.params.seq > sent.at(-2).params.seq);
    },
  };
}

test("reports root work even without a background agent", async (t) => {
  const pi = setup(t);
  pi.fire("session_start", { reason: "startup" });
  await pi.expectState("idle");
  assert.equal(pi.sent[0].params.agent_session_path, "/sessions/root.jsonl");
  assert.equal(pi.sent[1].params.agent_session_path, "/sessions/root.jsonl");

  pi.fire("agent_start");
  await pi.expectState("working");
  pi.fire("agent_settled");
  await pi.expectState("idle");
});

test("keeps the pane working until root work, agents, and workflows all settle", async (t) => {
  const pi = setup(t, { idle: false });
  pi.fire("session_start", { reason: "reload" });
  await pi.expectState("working");
  pi.emit("subagents:started", { id: "agent-1" });
  pi.emit("subagents:workflow_started", { id: "workflow-1" });
  pi.fire("agent_settled");
  await pi.expectState("working");

  pi.emit("herdr:blocked", { active: true, label: "Approve write" });
  await pi.expectState("blocked", "Approve write");
  pi.emit("subagents:failed", { id: "agent-1" });
  await pi.expectState("blocked", "Approve write");
  pi.emit("herdr:blocked", { active: false });
  await pi.expectState("working");
  pi.emit("subagents:workflow_settled", { id: "workflow-1" });
  await pi.expectState("idle");
});

test("binds a replacement session even when Pi reloads in the same millisecond", async (t) => {
  t.mock.method(Date, "now", () => 1795770000000);
  const previous = setup(t);
  previous.fire("session_start", { reason: "startup" });
  await previous.expectState("idle");
  previous.fire("session_shutdown");

  const { default: reloaded } = await import("./herdr-live.ts?reload");
  const pi = setup(t, { file: null, activate: reloaded });
  pi.fire("session_start", { reason: "resume" });
  await pi.expectState("idle");
  const [session, state] = pi.sent;
  assert.ok(session.params.seq > previous.sent.at(-1).params.seq);
  assert.equal(session.method, "pane.report_agent_session");
  assert.equal(session.params.session_start_source, "resume");
  assert.equal(session.params.agent_session_id, "root-id");
  assert.equal(state.params.agent_session_id, "root-id");
});

test("does not report from headless sessions or after shutdown", async (t) => {
  const headless = setup(t, { mode: "rpc" });
  headless.fire("session_start", { reason: "startup" });
  headless.fire("agent_start");
  headless.emit("subagents:started", { id: "headless-agent" });
  await setImmediate();
  assert.deepEqual(headless.sent, []);
  t.mock.restoreAll();

  const tui = setup(t);
  tui.fire("session_start", { reason: "startup" });
  tui.fire("session_shutdown");
  tui.emit("subagents:disposed");
  await setImmediate();
  assert.deepEqual(tui.sent.map(({ method }) => method), ["pane.report_agent_session"]);
});
