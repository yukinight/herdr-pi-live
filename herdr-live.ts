// @ts-nocheck
// Sits beside herdr's own pi integration (herdr-agent-state.ts) and covers what
// it cannot see: background subagents and workflows keep running after the turn
// settles, so that file reports "idle" while work continues.
//
// Why a separate file: herdr reinstalls its own integration in place, so this
// one is never overwritten.
import net from "node:net";
import path from "node:path";

const SOURCE = "herdr:pi";
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const enabled = process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
const endpoint =
  process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

// Above herdr-agent-state.ts's `now*1000 + n`, so a late correction still wins
// its seq check. Never below our own previous seq.
let seq = Date.now() * 1000;

function nextSeq() {
  seq = Math.max(seq + 1, Date.now() * 1000 + 500);
  return seq;
}

function report(params) {
  const request = {
    id: `${SOURCE}:live:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: {
      pane_id: paneId,
      source: SOURCE,
      agent: "pi",
      seq: nextSeq(),
      ...params,
    },
  };
  // A dropped report is corrected by the next lifecycle event, so one short try.
  const socket = net.createConnection(endpoint);
  const timer = setTimeout(() => socket.destroy(), 500);
  timer.unref?.();
  socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on("data", () => {
    clearTimeout(timer);
    socket.destroy();
  });
  socket.on("error", () => {
    clearTimeout(timer);
    socket.destroy();
  });
  socket.unref?.();
}

export default function (pi) {
  if (!enabled) {
    return;
  }

  const agents = new Set();
  const workflows = new Set();
  let rootSession = false;
  let mainActive = false;
  let blocked = 0;
  let sessionRef = {};
  let timer;

  // Delayed so herdr-agent-state.ts's report for the same transition lands first.
  function publish(delay) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!rootSession || blocked > 0) {
        return;
      }
      const working = agents.size > 0 || workflows.size > 0 || mainActive;
      report({ state: working ? "working" : "idle", ...sessionRef });
    }, delay);
    timer.unref?.();
  }

  const start = (set) => (info) => {
    if (!info?.id) return;
    set.add(info.id);
    publish(0);
  };
  const settle = (set) => (info) => {
    if (!info?.id || !set.delete(info.id)) return;
    publish(1000);
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
    publish(400);
  });

  // herdr-agent-state.ts owns "blocked"; stay out of its way.
  pi.events.on("herdr:blocked", (data) => {
    blocked = Math.max(0, blocked + (data?.active ? 1 : -1));
    if (blocked === 0) {
      publish(300);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") {
      return;
    }
    rootSession = true;
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (
        typeof file === "string" &&
        (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))
      ) {
        sessionRef = { agent_session_path: file };
      }
    } catch {
      sessionRef = {};
    }
    publish(300);
  });

  pi.on("agent_start", () => {
    mainActive = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.isIdle?.() !== true) {
      return;
    }
    mainActive = false;
    publish(300);
  });
}
