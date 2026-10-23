// BYOK fork P1a：clientConfigService（厂商远端配置）删除，插件推荐恒为空列表。
export function useUiPluginRecommendations(enabled: boolean) {
  return {
    recommendations: [] as {
      pluginId: string;
      title?: string;
      description?: string;
      icon?: string;
      surfaceId: string;
    }[],
    loading: false,
  };
}
