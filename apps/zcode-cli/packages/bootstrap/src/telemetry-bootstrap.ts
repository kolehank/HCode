/**
 * BYOK fork P0：原实现经 @zcode/telemetry（OTLP）准备进程级遥测环境并回填
 * ZCODE_TELEMETRY_DEVICE_MID。该包已整体移除，这里保留导出形状为直通 no-op：
 * 返回原 env，不做任何捕获/注入，零出网。
 */

export async function prepareZCodeTelemetryEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  void env;
  return env;
}

/**
 * 与 prepareZCodeTelemetryEnv 对称地关闭当前进程持有的 Telemetry Owner。
 * no-op：无 Owner 可关。
 */
export async function shutdownZCodeTelemetry(): Promise<void> {}
