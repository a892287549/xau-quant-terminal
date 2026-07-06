import { WebSocketServer } from "ws";

export class WsHub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();
    this.wss.on("connection", (socket) => {
      this.clients.add(socket);
      socket.send(JSON.stringify({
        type: "hello",
        data: {
          connectedAt: new Date().toISOString()
        }
      }));
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  broadcast(type, data) {
    const payload = JSON.stringify({
      type,
      data,
      at: new Date().toISOString()
    });
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  status() {
    return {
      clients: this.clients.size
    };
  }
}
