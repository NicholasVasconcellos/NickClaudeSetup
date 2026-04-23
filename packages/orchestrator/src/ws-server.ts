import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import type {
  TaskState,
  TaskPhase,
  TaskEffort,
  RunSummary,
  WSEventFromServer,
  WSEventFromClient,
} from "./types.js";

interface TreeNode {
  path: string;
  name: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

const EXCLUDED_NAMES = new Set([
  "node_modules", ".next", "dist", ".git", ".orchestrator",
  "package-lock.json", ".DS_Store",
]);

export class EventBus {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private onClientMessage: ((event: WSEventFromClient) => void) | null = null;
  private initBuffer: WSEventFromServer[] = [];
  private skillsDir: string;
  private projectDir: string;

  constructor(private readonly port: number) {
    this.skillsDir = path.resolve(process.cwd(), ".claude", "skills");
    this.projectDir = process.cwd();
  }

  setProjectDir(dir: string): void {
    this.projectDir = dir;
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`[ws] client connected (total: ${this.clients.size})`);

      // Replay buffered init events to late-connecting clients
      for (const event of this.initBuffer) {
        try { ws.send(JSON.stringify(event)); } catch {}
      }

      ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type?.startsWith("skills:")) {
            this.handleSkillEvent(ws, event);
          } else if (event.type === "files:tree") {
            this.handleFilesTree(ws);
          } else {
            this.onClientMessage?.(event as WSEventFromClient);
          }
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

  // ── Skill file I/O ─────────────────────────────────────────

  private getSkillsList(): Array<{ name: string; hasVariations: boolean }> {
    if (!fs.existsSync(this.skillsDir)) return [];
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const skills: Array<{ name: string; hasVariations: boolean }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(this.skillsDir, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const files = fs.readdirSync(skillDir);
      const hasVariations = files.some((f) => /^SKILL\.v\d+\.md$/.test(f));
      skills.push({ name: entry.name, hasVariations });
    }
    return skills;
  }

  private handleSkillEvent(ws: WebSocket, event: { type: string; skillName?: string; variationName?: string; content?: string }): void {
    try {
      switch (event.type) {
        case "skills:list": {
          const skills = this.getSkillsList();
          ws.send(JSON.stringify({ type: "skills:list_result", skills }));
          break;
        }
        case "skills:get": {
          const { skillName } = event;
          if (!skillName) return;
          const skillFile = path.join(this.skillsDir, skillName, "SKILL.md");
          if (!fs.existsSync(skillFile)) {
            ws.send(JSON.stringify({ type: "skills:content", skillName, content: "", variations: [] }));
            return;
          }
          const content = fs.readFileSync(skillFile, "utf-8");
          const dir = path.join(this.skillsDir, skillName);
          const files = fs.readdirSync(dir);
          const variations = files
            .filter((f) => /^SKILL\.v(\d+)\.md$/.test(f))
            .map((f) => {
              const name = f.match(/^SKILL\.(v\d+)\.md$/)![1];
              const varContent = fs.readFileSync(path.join(dir, f), "utf-8");
              return { name, content: varContent };
            });
          ws.send(JSON.stringify({ type: "skills:content", skillName, content, variations }));
          break;
        }
        case "skills:save": {
          const { skillName: name, content: body } = event;
          if (!name || body == null) return;
          const dir = path.join(this.skillsDir, name);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
          // Respond with refreshed list
          const skills = this.getSkillsList();
          ws.send(JSON.stringify({ type: "skills:list_result", skills }));
          break;
        }
        case "skills:save_variation": {
          const { skillName: name, variationName, content: body } = event;
          if (!name || !variationName || body == null) return;
          const dir = path.join(this.skillsDir, name);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `SKILL.${variationName}.md`), body, "utf-8");
          // Re-send full skill content so frontend updates
          const skillFile = path.join(dir, "SKILL.md");
          const mainContent = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf-8") : "";
          const files = fs.readdirSync(dir);
          const variations = files
            .filter((f) => /^SKILL\.v(\d+)\.md$/.test(f))
            .map((f) => {
              const vName = f.match(/^SKILL\.(v\d+)\.md$/)![1];
              const varContent = fs.readFileSync(path.join(dir, f), "utf-8");
              return { name: vName, content: varContent };
            });
          ws.send(JSON.stringify({ type: "skills:content", skillName: name, content: mainContent, variations }));
          const skills = this.getSkillsList();
          this.broadcast({ type: "skills:list_result", skills });
          break;
        }
        case "skills:activate": {
          const { skillName: name, variationName } = event;
          if (!name || !variationName) return;
          const dir = path.join(this.skillsDir, name);
          const varFile = path.join(dir, `SKILL.${variationName}.md`);
          if (!fs.existsSync(varFile)) return;
          const varContent = fs.readFileSync(varFile, "utf-8");
          fs.writeFileSync(path.join(dir, "SKILL.md"), varContent, "utf-8");
          // Re-send full skill content so frontend updates
          const files = fs.readdirSync(dir);
          const variations = files
            .filter((f) => /^SKILL\.v(\d+)\.md$/.test(f))
            .map((f) => {
              const vName = f.match(/^SKILL\.(v\d+)\.md$/)![1];
              const vc = fs.readFileSync(path.join(dir, f), "utf-8");
              return { name: vName, content: vc };
            });
          this.broadcast({ type: "skills:content", skillName: name, content: varContent, variations });
          const skills = this.getSkillsList();
          this.broadcast({ type: "skills:list_result", skills });
          break;
        }
      }
    } catch (err) {
      console.error("[ws] skill event error:", err);
    }
  }

  // ── File tree I/O ─────────────────────────────────────────

  private buildTree(dirPath: string, depth: number): TreeNode[] {
    if (depth > 4) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      const relPath = path.relative(this.projectDir, fullPath);
      if (entry.isDirectory()) {
        const children = this.buildTree(fullPath, depth + 1);
        nodes.push({ path: relPath, name: entry.name, type: "directory", children });
      } else {
        nodes.push({ path: relPath, name: entry.name, type: "file" });
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  private handleFilesTree(ws: WebSocket): void {
    try {
      const tree = this.buildTree(this.projectDir, 1);
      ws.send(JSON.stringify({ type: "files:tree_result", tree }));
    } catch (err) {
      console.error("[ws] files:tree error:", err);
    }
  }

  // ── Broadcast helpers ───────────────────────────────────────

  taskInit(taskId: number, title: string, description: string, dependsOn: number[], milestone: string | null, effort: TaskEffort | null): void {
    const event: WSEventFromServer = { type: "task:init", taskId, title, description, dependsOn, milestone, effort };
    this.initBuffer.push(event);
    this.broadcast(event);
  }

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
    tokensIn: number, tokensOut: number, cacheRead: number, cacheCreation: number,
    model: string, contextLimit: number, contextPercentage: number,
  ): void {
    this.broadcast({ type: "task:agent_finished", taskId, phase, tokens, cost, tokensIn, tokensOut, cacheRead, cacheCreation, model, contextLimit, contextPercentage });
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

  planLoaded(taskCount: number): void {
    this.broadcast({ type: "plan:loaded", taskCount });
  }

  runStarted(mode: "automated" | "human_review", sessionId: number): void {
    this.broadcast({ type: "run:started", mode, sessionId });
  }

  taskCreated(taskId: number, title: string): void {
    this.broadcast({ type: "task:created", taskId, title });
  }

  taskNeedsReview(taskId: number, gitDiff: string, agentLogSummary: string): void {
    this.broadcast({ type: "task:needs_review", taskId, gitDiff, agentLogSummary });
  }

  promptResponse(taskId: number, response: string): void {
    this.broadcast({ type: "prompt:response", taskId, response });
  }

  suggestionNew(title: string, description: string, filePath: string): void {
    this.broadcast({ type: "suggestion:new", title, description, filePath });
  }

  branchUpdate(taskId: number, branch: string, status: "created" | "merged" | "deleted"): void {
    this.broadcast({ type: "branch:update", taskId, branch, status });
  }

  skillsListResult(skills: Array<{ name: string; hasVariations: boolean }>): void {
    this.broadcast({ type: "skills:list_result", skills });
  }

  skillsContent(skillName: string, content: string, variations: Array<{ name: string; content: string }>): void {
    this.broadcast({ type: "skills:content", skillName, content, variations });
  }

  filesTreeResult(tree: Array<{ path: string; type: "file" | "directory"; children?: any[] }>): void {
    this.broadcast({ type: "files:tree_result", tree });
  }
}
