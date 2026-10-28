// 与 web/src/env.d.ts 同一模式：side-effect CSS 导入由打包器处理，类型检查需要
// 显式声明（ui 包的 css.d.ts 在其源码内，desktop renderer 经 project reference 只见
// 其 dist 声明，故需自备）。
declare module "*.css";
declare module "@zcode/ui/styles.css";
