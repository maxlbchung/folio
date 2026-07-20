// Hand-rolled streamable-HTTP MCP server (no SDK — the broker must run on a
// bare Node install). Serves the shared inktile tools to the user's CLIs.
//
// Interop notes, learned against the real clients:
// - Sessions are stateful: initialize returns an Mcp-Session-Id header and the
//   Codex rmcp client sends it on every later request (plus a GET SSE stream).
// - POST responses use the single-event SSE encoding when the client accepts
//   text/event-stream, otherwise plain JSON.
// - tools/list must include explicit annotations; Codex cancels un-annotated
//   tool calls when running headless under a restricted sandbox.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { inktileTools, runTool } from "./tools.mjs";

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL = "2025-06-18";

/**
 * Starts the loopback MCP endpoint on an ephemeral port.
 * @param {string} bearerToken required on every request
 * @param {() => object | null} getRuntime resolves the active turn's tool runtime
 * @param {(line: string) => void} log diagnostics sink (stderr)
 */
export const startMcpEndpoint = async (bearerToken, getRuntime, log) => {
  /** @type {Map<string, { streams: Set<import("node:http").ServerResponse> }>} */
  const sessions = new Map();

  const respondJson = (response, status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  };

  const respondResult = (request, response, payload, sessionId) => {
    const headers = sessionId ? { "mcp-session-id": sessionId } : {};
    if (String(request.headers.accept ?? "").includes("text/event-stream")) {
      response.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-store" });
      response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else {
      const body = JSON.stringify(payload);
      response.writeHead(200, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    }
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  const handleRequest = async (message) => {
    const { id, method, params } = message;
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      return {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "inktile", version: "0.2.0" }
        }
      };
    }
    if (method === "ping") return { result: {} };
    if (method === "tools/list") {
      return {
        result: {
          tools: inktileTools.map((spec) => ({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
            annotations: spec.annotations
          }))
        }
      };
    }
    if (method === "tools/call") {
      const spec = inktileTools.find((candidate) => candidate.name === params?.name);
      if (!spec) return { error: rpcError(id, -32602, `Unknown tool ${params?.name}`).error };
      const runtime = getRuntime();
      if (!runtime) {
        return { result: { content: [{ type: "text", text: "Error: no agent turn is active." }], isError: true } };
      }
      const { text, isError } = await runTool(spec, runtime, params?.arguments ?? {});
      return { result: { content: [{ type: "text", text }], isError } };
    }
    return { error: { code: -32601, message: `Method not found: ${method}` } };
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.headers.authorization !== `Bearer ${bearerToken}`) {
          respondJson(response, 401, rpcError(null, -32000, "Unauthorized"));
          return;
        }
        const headerSession = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : null;
        const session = headerSession ? sessions.get(headerSession) : null;

        if (request.method === "GET") {
          // The server→client stream. We never push messages, but the client
          // expects the stream to open and stay alive.
          if (!session) {
            respondJson(response, 404, rpcError(null, -32001, "Unknown or missing MCP session id."));
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          response.write(": open\n\n");
          session.streams.add(response);
          const heartbeat = setInterval(() => {
            if (!response.destroyed) response.write(": ping\n\n");
          }, 25_000);
          request.on("close", () => {
            clearInterval(heartbeat);
            session.streams.delete(response);
          });
          return;
        }

        if (request.method === "DELETE") {
          if (headerSession && session) {
            for (const stream of session.streams) stream.end();
            sessions.delete(headerSession);
          }
          respondJson(response, 200, { ok: true });
          return;
        }

        if (request.method !== "POST") {
          respondJson(response, 405, rpcError(null, -32000, "Method not allowed."));
          return;
        }

        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let message;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          respondJson(response, 400, rpcError(null, -32700, "Parse error"));
          return;
        }
        if (Array.isArray(message)) {
          respondJson(response, 400, rpcError(null, -32600, "Batch requests are not supported."));
          return;
        }

        // Notifications (no id) are acknowledged without a body.
        if (message.id === undefined || message.id === null) {
          response.writeHead(202).end();
          return;
        }

        if (message.method === "initialize") {
          const sessionId = randomUUID();
          sessions.set(sessionId, { streams: new Set() });
          const outcome = await handleRequest(message);
          respondResult(request, response, { jsonrpc: "2.0", id: message.id, ...outcome }, sessionId);
          return;
        }

        if (!session) {
          respondJson(response, 404, rpcError(message.id, -32001, "Unknown or missing MCP session id."));
          return;
        }
        const outcome = await handleRequest(message);
        respondResult(request, response, { jsonrpc: "2.0", id: message.id, ...outcome });
      } catch (error) {
        log(`mcp endpoint error: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) respondJson(response, 500, rpcError(null, -32000, "Internal error"));
      }
    })();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => {
      for (const [, session] of sessions) for (const stream of session.streams) stream.end();
      sessions.clear();
      server.close();
    }
  };
};
