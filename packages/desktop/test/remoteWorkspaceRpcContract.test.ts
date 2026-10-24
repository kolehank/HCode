import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "../src/host/remoteWorkspaceRpcContract.js";

describe("RemoteWorkspaceRpcContract v1", () => {
  it("requires the complete R3 full-forward channel set", () => {
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).toContain("genUiService");
    const contract = Object.fromEntries(
      REMOTE_WORKSPACE_RPC_CHANNELS.map((channel) => [channel, {}]),
    );
    expect(() => assertRemoteWorkspaceRpcContract(contract)).not.toThrow();
    // BYOK fork P1b：oauthService 已从远端契约渠道删除，不再参与完整性校验。
    delete contract.genUiService;
    expect(() => assertRemoteWorkspaceRpcContract(contract)).toThrow(/genUiService/u);
  });
});
