// broker/ports — 纯谓词与类型面，renderer 可安全导入（不得依赖 node:*）。
//
// isCuaPermissionStatusAvailable：成功结果**不带** available 字段（CuaPermissionStatus
// 的 available 是可选 true），不可用结果才显式写 available:false，所以判定只能看 !== false，
// 否则会把成功状态误判成 unavailable。
export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available !== false;
}

// 主动抓屏必须是用户显式意图：只读刷新不带 includeFunctionalProbes（或为 false）时
// 永不运行 screen_capture_probe——这是隐私契约，后台轮询不得偷偷抓屏。
// 预检已判 denied 时没有必要再花一次抓屏；granted/unknown/undefined 才值得探测真值。
export function shouldRunCuaScreenCaptureProbe(state, options) {
  if (options?.includeFunctionalProbes !== true) return false;
  return state !== "denied";
}
