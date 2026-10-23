import type { TraceContext } from "../tracing/tracer.js";

/** 仅用于当前任务已经接收的话题附件，身份由可信输入解析，不能由模型指定。 */
export interface TopicResourcePort {
  read(
    request: {
      taskId: string;
      inputId: string;
      authorizationId: string;
      messageId: string;
      resourceIndex: number;
    },
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<{ ref: string; fileName: string; mime: string; bytes: number }>;
}
