import { describe, expect, it, vi } from "vitest";
import type { DynamicWorkflowMode, WindowHostAttachmentScope } from "@zcode/shared";
import { ServiceCollection, IZCodeAgentService } from "@zcode/services";
import type {
  ServerRemoteConnection,
  ServerRemoteDuplexConnectionOptions,
} from "../src/host/serverRemoteConnection.js";
import { connectDesktopSourceServer } from "../src/host/connectDesktopSourceServer.js";

function setup() {
  const sync = vi.fn(async (): Promise<void> => undefined);
  const agent = { syncDynamicWorkflowUserMode: sync } as unknown as IZCodeAgentService;
  const logicalA = new ServiceCollection().register(IZCodeAgentService, agent);
  const scopes = new Map([[ "a", logicalA ]]);
  const dispose = vi.fn();
  const connection = {
    services: { zcodeAgentService: agent },
    dispose,
  } as unknown as ServerRemoteConnection;
  const connectServer = vi.fn(async (_options: ServerRemoteDuplexConnectionOptions) => connection);
  const dependencies = {
    connectServer,
    resolveServices: (scope: WindowHostAttachmentScope) => {
      if (scope.kind !== "remote") throw new Error("Expected remote");
      return scopes.get(scope.remoteSessionId)!;
    },
    readDynamicWorkflowMode: vi.fn(
      async (): Promise<DynamicWorkflowMode | undefined> => "alwaysOn",
    ),
    onModeSyncError: vi.fn(),
  };
  const options = { ingressToken: "test", createConnection: vi.fn() };
  return { sync, dispose, dependencies, options };
}

describe("Desktop Source physical connection capabilities", () => {
  it("publishes the connection only after the Desktop mode reaches the Source", async () => {
    const state = setup();
    let finish: () => void = () => undefined;
    state.sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let published = false;
    const pending = connectDesktopSourceServer(state.options, state.dependencies).then(
      (connection) => {
        published = true;
        return connection;
      },
    );
    await vi.waitFor(() => expect(state.sync).toHaveBeenCalledWith({ mode: "alwaysOn" }));
    expect(published).toBe(false);
    finish();
    (await pending).dispose();
  });

  it("keeps old Sources usable when they do not support mode sync", async () => {
    const state = setup();
    state.sync.mockRejectedValue(new Error("Unknown method"));
    const connection = await connectDesktopSourceServer(state.options, state.dependencies);
    expect(state.dependencies.onModeSyncError).toHaveBeenCalledOnce();
    connection.dispose();
  });
});
