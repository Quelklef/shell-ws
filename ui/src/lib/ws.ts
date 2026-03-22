import type { ClientEvent, ServerEvent } from "./types";

function wsLog(direction: "->" | "<-", summary: string) {
  console.debug(`[ws${direction}] ${summary}`.slice(0, 100));
}

function summarizeClientEvent(event: ClientEvent) {
  switch (event.type) {
    case "run_node":
      return `run ${event.action} ${event.node_id}`;
    case "stop_execution":
      return `stop exec=${event.exec_id ?? "-"} node=${event.node_id ?? "-"}`;
  }
}

function summarizeServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "exec_started":
      return `start ${event.node_id} ${event.exec_id}`;
    case "exec_finished":
      return `finish ${event.node_id} ${event.exec_id} code=${event.exit_code ?? "null"} mat=${event.materialized ? 1 : 0}`;
    case "port_activity":
      return `port ${event.node_id}.${event.port} bytes=${event.bytes}`;
    case "node_output":
      return `out ${event.node_id}.${event.port} b64=${event.data_base64.length}`;
    case "stream_chunk":
      return `chunk ${event.from_node_id}->${event.to_node_id}.${event.port} b64=${event.data_base64.length}`;
    case "display_update":
      return `display ${event.node_id} b64=${event.data_base64.length} done=${event.completed}`;
    case "execution_stopped":
      return `stopped ${event.exec_id}`;
    case "error":
      return `error ${event.message}`;
  }
}

function kernelWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const port = window.location.port === "5173" ? "4000" : window.location.port;
  return `${protocol}://${window.location.hostname}${port ? `:${port}` : ""}/ws`;
}

export function connectKernel(
  onEvent: (event: ServerEvent) => void,
  onClose: () => void,
) {
  const url = kernelWsUrl();
  const socket = new WebSocket(url);

  console.debug(`[ws] open ${url}`.slice(0, 100));

  socket.addEventListener("message", (message) => {
    const parsed = JSON.parse(String(message.data)) as ServerEvent;
    wsLog("<-", summarizeServerEvent(parsed));
    onEvent(parsed);
  });

  socket.addEventListener("error", () => {
    console.debug("[ws] error".slice(0, 100));
  });

  socket.addEventListener("close", () => {
    console.debug("[ws] close".slice(0, 100));
    onClose();
  });

  return {
    send(event: ClientEvent) {
      if (socket.readyState === WebSocket.OPEN) {
        wsLog("->", summarizeClientEvent(event));
        socket.send(JSON.stringify(event));
      }
    },
    close() {
      socket.close();
    },
    get ready() {
      return socket.readyState === WebSocket.OPEN;
    },
    onOpen(callback: () => void) {
      socket.addEventListener("open", callback, { once: true });
    },
  };
}
