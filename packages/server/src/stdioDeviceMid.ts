export interface EnsureRemoteServerDeviceMidOptions {
  /** 仅测试注入；BYOK fork 下恒为 no-op。 */
  ensureDeviceMid?: () => Promise<string>;
  log: (...args: unknown[]) => void;
}

/**
 * BYOK fork P0：远端 deviceMid 原服务厂商 X-Device-Mid 请求头（Start Plan 权益查询）。
 * 设备标识与厂商计费链已删除，本函数保留导出形状、恒返回 undefined：远端 server
 * 启动不再生成设备身份文件，也不影响任何本地能力。
 */
export async function ensureRemoteServerDeviceMid(
  _options: EnsureRemoteServerDeviceMidOptions,
): Promise<string | undefined> {
  return undefined;
}
