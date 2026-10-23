// PiP session client: connects to the Helper broker with the "presentation"
// role. Presentation authority is gated by the Helper on verified peer
// identity; this client just declares it.
import {
  PermissionBrokerClient,
  resolveBrokerSocketPath,
} from "./vendor/dist-index.js";

const PIP_SESSION_PROTOCOL_VERSION = 2;
const PIP_SESSION_RUNTIME_ID = "zcode-cua-pip-session-v2";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 250;

export function createPipSessionClient(options = {}) {
  const socketPathOption = options.socketPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reconnectAttempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const onDiagnostic = options.onDiagnostic;

  let connected = false;
  let ready = false;
  let closed = false;

  const socketPath = () => socketPathOption ?? resolveBrokerSocketPath();

  const report = (code, message) => {
    try {
      onDiagnostic?.({ code, ...(message ? { message } : {}) });
    } catch {
      // diagnostics must never break the session client
    }
  };

  const newClient = () =>
    new PermissionBrokerClient(socketPath(), {
      timeoutMs,
      peerChecker: options.peerChecker,
      authenticateParams: { role: "presentation" },
    });

  const handshake = async () => {
    const result = await newClient().call("pip_session_handshake", {
      protocolVersion: PIP_SESSION_PROTOCOL_VERSION,
      runtimeId: PIP_SESSION_RUNTIME_ID,
    });
    return result === null || typeof result !== "object"
      ? { ready: false }
      : result;
  };

  return {
    get enabled() {
      return connected && ready && !closed;
    },

    async connect() {
      if (closed) return;
      let lastError;
      for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
        try {
          const result = await handshake();
          ready = result.ready === true;
          connected = true;
          if (!ready) {
            report("pip_session_not_ready", "Helper reported the PiP session runtime as not ready");
          }
          return;
        } catch (error) {
          lastError = error;
          report("pip_session_connect_failed", error instanceof Error ? error.message : undefined);
          if (attempt < reconnectAttempts) {
            await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
          }
        }
      }
      connected = false;
      ready = false;
      if (lastError) throw lastError;
    },

    async send(event) {
      if (closed) return { applied: false, reason: "closed" };
      if (!connected) await this.connect();
      try {
        const result = await newClient().call("pip_session_event", { event });
        if (result !== null && typeof result === "object") {
          return {
            applied: result.applied === true,
            ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
          };
        }
        return { applied: false, reason: "invalid_result" };
      } catch (error) {
        connected = false;
        throw error;
      }
    },

    close() {
      closed = true;
      connected = false;
      ready = false;
    },
  };
}
