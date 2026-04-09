import { WebSocketServer, WebSocket } from "ws";
import type {
  TaskState,
  TaskPhase,
  RunSummary,
  WSEventFromServer,
  WSEventFromClient,
} from "./types.js";

export class EventBus {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private onClientMessage: ((event: WSEventFromClient) => void) | null = null;

  constructor(private readonly port: number) {}

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`[ws] client connected (total: ${this.clients.size})`);

      ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString()) as WSEventFromClient;
          this.onClientMessage?.(event);
        } catch (err) {
          console.error("[ws] failed to parse client message:", err);
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`[ws] client disconnected (total: ${this.clients.size})`);
      });

      ws.on("error", (err) => {
        console.error("[ws] client error:", err);
        this.clients.delete(ws);
      });
    });

    this.wss.on("error", (err) => {
      console.error("[ws] server error:", err);
    });

    console.log(`[ws] server listening on port ${this.port}`);
  }

  broadcast(event: WSEventFromServer): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      try {
        client.send(payload);
      } catch {
        // Don't let one bad client interrupt the rest
      }
    }
  }

  onCommand(handler: (event: WSEventFromClient) => void): void {
    this.onClientMessage = handler;
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();

      if (!this.wss) {
        resolve();
        return;
      }

      this.wss.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // ── Broadcast helpers ───────────────────────────────────────

  taskStateChanged(taskId: number, oldState: TaskState, newState: TaskState, title?: string): void {
    this.broadcast({ type: "task:state_change", taskId, oldState, newState, ...(title ? { title } : {}) });
  }

  taskLogAppend(taskId: number, line: string): void {
    this.broadcast({ type: "task:log_append", taskId, line });
  }

  agentStarted(taskId: number, phase: TaskPhase, model: string): void {
    this.broadcast({ type: "task:agent_started", taskId, phase, model });
  }

  agentFinished(
    taskId: number, phase: TaskPhase, tokens: number, cost: number,
    tokensIn: number, tokensOut: number, model: string,
    contextLimit: number, contextPercentage: number,
  ): void {
    this.broadcast({ type: "task:agent_finished", taskId, phase, tokens, cost, tokensIn, tokensOut, model, contextLimit, contextPercentage });
  }

  taskUnblocked(taskId: number): void {
    this.broadcast({ type: "task:unblocked", taskId });
  }

  runCompleted(summary: RunSummary): void {
    this.broadcast({ type: "run:completed", summary });
  }

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.broadcast({ type: "run:notification", message, level });
  }
}
