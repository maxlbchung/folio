import { parseMessage, type AppToBrokerMessage, type BrokerToAppMessage } from "./protocol";

export type AgentConnectionState = "disconnected" | "connecting" | "connected";

export interface AgentClientHandlers {
  onStateChange: (state: AgentConnectionState) => void;
  onMessage: (message: BrokerToAppMessage) => void;
}

/** Transport the ui-smoke suite injects instead of a real broker (mirrors the
 * `__TAURI_INTERNALS__` native mock pattern). */
export interface AgentMockTransport {
  connect: (receive: (data: string) => void, closed: () => void) => {
    send: (data: string) => void;
    close: () => void;
  };
}

declare global {
  interface Window {
    __inktileAgentMock?: AgentMockTransport;
  }
}

interface ActiveTransport {
  send: (data: string) => void;
  close: () => void;
}

/**
 * Connects the app to the agent broker. Zero setup: in the desktop shell a
 * `agent_start` command spawns agent/broker.mjs on demand and bridges its
 * stdio to the webview as events, so there is nothing to launch, no port, and
 * no token to pair. `connect()` throws a user-readable message when the agent
 * cannot run here (browser build, missing Node, missing agent files).
 */
export class AgentClient {
  private transport: ActiveTransport | null = null;
  private handlers: AgentClientHandlers;

  constructor(handlers: AgentClientHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.transport !== null;
  }

  async connect(): Promise<void> {
    if (this.transport) return;
    this.handlers.onStateChange("connecting");

    const receive = (data: string) => {
      const message = parseMessage<BrokerToAppMessage>(data);
      if (message) this.handlers.onMessage(message);
    };

    try {
      if (window.__inktileAgentMock) {
        const mock = window.__inktileAgentMock.connect(receive, () => this.dropped());
        this.transport = mock;
      } else if (window.__TAURI_INTERNALS__) {
        this.transport = await this.connectTauri(receive);
      } else {
        throw new Error("The agent runs in the Inktile desktop app; this browser build cannot start it.");
      }
    } catch (error) {
      this.handlers.onStateChange("disconnected");
      throw error instanceof Error ? error : new Error(String(error));
    }

    this.handlers.onStateChange("connected");
    // Ask for backend availability so the panel can annotate the picker.
    this.send({ type: "probe" });
  }

  private async connectTauri(receive: (data: string) => void): Promise<ActiveTransport> {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event")
    ]);

    let active = true;
    const unlisteners: Array<() => void> = [];
    const detach = () => {
      active = false;
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
    };

    unlisteners.push(await listen<string>("agent-broker-message", (event) => {
      if (active) receive(event.payload);
    }));
    unlisteners.push(await listen("agent-broker-exit", () => {
      if (!active) return;
      detach();
      this.dropped();
    }));

    try {
      await invoke("agent_start");
    } catch (error) {
      detach();
      throw new Error(typeof error === "string" ? error : "The agent broker could not be started.");
    }

    return {
      send: (data) => {
        void invoke("agent_send", { line: data }).catch(() => {
          if (!active) return;
          detach();
          this.dropped();
        });
      },
      close: detach
    };
  }

  private dropped() {
    if (!this.transport) return;
    this.transport = null;
    this.handlers.onStateChange("disconnected");
  }

  disconnect() {
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    if (transport) this.handlers.onStateChange("disconnected");
  }

  send(message: AppToBrokerMessage): boolean {
    if (!this.transport) return false;
    try {
      this.transport.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
}
