// @ts-nocheck
import net from "node:net";
import path from "node:path";

const SOURCE = "herdr:pi";
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const enabled = process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
const endpoint =
  process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

// Keep the sequence across reloads so Herdr accepts a replacement session's first report.
const sequenceKey = Symbol.for("herdr-pi-live.report-seq");

function report(method, params) {
  const seq = Math.max((process[sequenceKey] ?? 0) + 1, Date.now() * 1000 + 500);
  process[sequenceKey] = seq;
  const request = {
    id: `${SOURCE}:live:${seq}`,
    method,
    params: { pane_id: paneId, source: SOURCE, agent: "pi", seq, ...params },
  };
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, 500);
    timer.unref?.();
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", finish);
    socket.on("end", finish);
    socket.on("error", finish);
    socket.unref?.();
  });
}

function getSessionRef(ctx) {
  const file = ctx.sessionManager.getSessionFile();
  if (typeof file === "string" && (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))) {
    return { agent_session_path: file };
  }
  const id = ctx.sessionManager.getSessionId();
  return id ? { agent_session_id: id } : undefined;
}

export default function (pi) {
  if (!enabled) {
    return;
  }

  const agents = new Set();
  const workflows = new Set();
  let mainActive = false;
  let blockedCount = 0;
  let blockedMessage;
  let sessionRef;
  let sessionReady;
  let publishPending = false;

  function publish() {
    if (!sessionReady || publishPending) return;
    publishPending = true;
    // Herdr must bind a new/resumed session before it accepts that session's state.
    void sessionReady.then(() => {
      publishPending = false;
      if (!sessionReady) return;
      const working = mainActive || agents.size > 0 || workflows.size > 0;
      const state = blockedCount > 0 ? "blocked" : working ? "working" : "idle";
      void report("pane.report_agent", { ...sessionRef, state, message: blockedMessage });
    });
  }

  const start = (set) => (info) => {
    if (!info?.id) return;
    set.add(info.id);
    publish();
  };
  const settle = (set) => (info) => {
    if (!info?.id || !set.delete(info.id)) return;
    publish();
  };

  // Only `started`: `created` is also re-announced for resumed or finished agents.
  pi.events.on("subagents:started", start(agents));
  pi.events.on("subagents:completed", settle(agents));
  pi.events.on("subagents:failed", settle(agents));
  pi.events.on("subagents:workflow_started", start(workflows));
  pi.events.on("subagents:workflow_settled", settle(workflows));
  pi.events.on("subagents:disposed", () => {
    agents.clear();
    workflows.clear();
    publish();
  });

  pi.events.on("herdr:blocked", (data) => {
    if (!sessionReady) return;
    if (data?.active) {
      blockedCount += 1;
      blockedMessage = data.label;
    } else {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
    }
    publish();
  });

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    mainActive = !ctx.isIdle();
    sessionRef = getSessionRef(ctx);
    sessionReady = sessionRef
      ? report("pane.report_agent_session", { ...sessionRef, session_start_source: event.reason })
      : Promise.resolve();
    publish();
  });

  pi.on("session_shutdown", () => {
    sessionReady = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!sessionReady) return;
    sessionRef = getSessionRef(ctx);
    mainActive = true;
    publish();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!sessionReady || !ctx.isIdle()) return;
    mainActive = false;
    publish();
  });
}
