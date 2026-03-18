import type { ClientEvent, ServerEvent } from "./types";

function kernelWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const port = window.location.port === "5173" ? "4000" : window.location.port;
  return `${protocol}://${window.location.hostname}${port ? `:${port}` : ""}/ws`;
}

export function connectKernel(
  onEvent: (event: ServerEvent) => void,
  onClose: () => void,
) {
  const socket = new WebSocket(kernelWsUrl());

  socket.addEventListener("message", (message) => {
    const parsed = JSON.parse(String(message.data)) as ServerEvent;
    onEvent(parsed);
  });

  socket.addEventListener("close", onClose);

  return {
    send(event: ClientEvent) {
      if (socket.readyState === WebSocket.OPEN) {
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
