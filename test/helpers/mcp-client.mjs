import { spawn } from "node:child_process";
import { once } from "node:events";

export class McpClient {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
  }

  async start() {
    this.child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.on("error", (err) => this._failAll(err));
    this.child.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        this._failAll(new Error(`server exited (code=${code}, signal=${signal}) with pending requests`));
      }
    });

    await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gradle-mcp-test", version: "0" },
    });
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools() {
    return this._request("tools/list");
  }

  async callTool(name, args, timeoutMs = 180_000) {
    const res = await this._request("tools/call", { name, arguments: args }, timeoutMs);
    if (res.isError) {
      throw new Error(`tool ${name} returned isError: ${JSON.stringify(res.content)}`);
    }
    const text = res.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`tool ${name} returned no text content`);
    }
    return JSON.parse(text);
  }

  async initializeResponse() {
    return this._initResult;
  }

  async close() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    try {
      await once(this.child, "exit");
    } catch {
      // ignore
    }
    this.child = null;
  }

  _send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async _request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this._send(msg);
    const result = await promise;
    if (method === "initialize") this._initResult = result;
    return result;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const { resolve, reject, timer } = this.pending.get(parsed.id);
        clearTimeout(timer);
        this.pending.delete(parsed.id);
        if (parsed.error) reject(new Error(`JSON-RPC error: ${JSON.stringify(parsed.error)}`));
        else resolve(parsed.result);
      }
    }
  }

  _failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}
