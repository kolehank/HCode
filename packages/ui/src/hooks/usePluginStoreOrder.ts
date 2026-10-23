import type { PluginStoreOrder } from "@zcode/shared";

// BYOK fork P1a：clientConfigService（厂商远端配置）删除，插件商店排序恒为默认顺序。
export function usePluginStoreOrder(_enabled = true) {
  const refresh = async (_forceRefresh = false) => {};
  return { order: null as PluginStoreOrder | null, refresh };
}
