/* BYOK A2：token 明文的本进程缓存（spec「token 明文的本进程缓存」节）。
 * 磁盘只存 hash/前缀；明文只在内存保留，供设置页与手机快捷弹窗在本次运行内重复展示。
 * 独立成纯状态机便于单测：缓存错配会让二维码显示已失效的旧链接，必须有回归覆盖。 */
export type ActiveAccessTokenMode = "open" | "cloudflare-access" | "token";

export class ActiveAccessToken {
  #token: string | null = null;
  #tokenHash = "";

  /** 本进程生成了新明文（IPC applyUpdate 或内嵌 HTTP PUT 回传）。 */
  noteGenerated(token: string, tokenHash: string): void {
    this.#token = token;
    this.#tokenHash = tokenHash;
  }

  /**
   * 磁盘配置重新载入后对齐缓存：
   * - 切离 token 档 → 丢弃（明文不再有展示意义）；
   * - tokenHash 变化（外部改写磁盘/重新生成）→ 丢弃，不能把旧明文配到新 hash 上；
   * - hash 未变 → 保留（只改基址/端口/开关后的重建不应让用户重新生成）。
   */
  noteConfigLoaded(mode: ActiveAccessTokenMode, tokenHash: string): void {
    if (mode !== "token" || tokenHash !== this.#tokenHash) {
      this.#token = null;
      this.#tokenHash = "";
    }
  }

  get(): string | null {
    return this.#token;
  }
}
