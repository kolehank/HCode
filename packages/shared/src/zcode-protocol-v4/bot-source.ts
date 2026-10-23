import { z } from "zod";
import { conversationQuotesSchema } from "../conversationSelection.js";

/** Bot 渠道相关共享 schema。BYOK fork P1c：Bot 渠道运行时已删除，仅保留 V4 协议仍引用的输入来源与投递目标合同。 */

export const channelMentionSchema = z
  .object({
    type: z.literal("channelMention"),
    refId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    channel: z.enum(["feishu", "lark"]),
    targetId: z
      .string()
      .max(128)
      .regex(/^ou_[a-zA-Z0-9_-]+$/u),
    idType: z.literal("open_id"),
    entityType: z.enum(["user", "bot", "unknown"]),
  })
  .strict();
export const channelContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }).strict(),
  channelMentionSchema,
]);
export const channelContentPartsSchema = z.array(channelContentPartSchema).max(200);
export type ChannelContentPart = z.infer<typeof channelContentPartSchema>;

/**
 * 定时任务完成后的 Bot 回推目标。只保留未来仍稳定的会话地址；当前消息 id/context token
 * 属于一次入站交互，不能持久化后复用。该字段由 Host 注入，模型工具参数不直接暴露。
 */
export const zcodeAutomationBotDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string().trim().min(1),
    providerUserId: z.string().trim().min(1),
    chatType: z.enum(["private", "group"]),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().min(1).optional(),
  })
  .strict();

export type ZCodeAutomationBotDeliveryTarget = z.infer<
  typeof zcodeAutomationBotDeliveryTargetSchema
>;

export const botTopicMessageSchema = z
  .object({
    id: z.string().min(1),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    senderId: z.string(),
    senderName: z.string().optional(),
    parentId: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), kind: z.string() }).strict()).optional(),
    senderType: z.enum(["user", "app"]),
    text: z.string(),
    createdAt: z.number(),
    kind: z.string(),
    controlCard: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .strict();
export type BotTopicMessage = z.infer<typeof botTopicMessageSchema>;

export const botTopicContextSchema = z
  .object({
    messages: z.array(botTopicMessageSchema).max(201),
    checkpoint: z.string().min(1),
    hasGap: z.boolean(),
  })
  .strict();
export type BotTopicHistoryBatch = z.infer<typeof botTopicContextSchema>;

export const botIdentitySchema = z
  .object({ name: z.string().min(1), openId: z.string().min(1).optional() })
  .strict();

/** CLI 只接收轻量材料索引；原文留在 Host 归档及文本附件。 */
export const botTopicHistorySourceSchema = z
  .object({
    checkpoint: z.string().min(1).max(256),
    hasGap: z.boolean(),
    messageCount: z.number().int().min(0).max(201),
    resourceMessages: z
      .array(
        z
          .object({
            messageId: z.string().min(1).max(256),
            count: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(201),
  })
  .strict();

export const botTopicInputMessageSchema = z
  .object({
    contentParts: channelContentPartsSchema.optional(),
    messageId: z.string().min(1),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    text: z.string(),
    conversationQuotes: conversationQuotesSchema.optional(),
    attachmentIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict();

/** 可信 Host 注入的输入来源；身份展示不能反向授予执行权限。 */
export const botGroupInputSourceSchema = z
  .object({
    botIdentity: botIdentitySchema.optional(),
    appId: z.string().min(1).optional(),
    contentParts: channelContentPartsSchema.optional(),
    authorizationId: z.string().min(1).optional(),
    botId: z.string().min(1),
    provider: z.enum(["feishu", "lark"]),
    chatId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    rootMessageId: z.string().optional(),
    senderId: z.string().min(1),
    senderName: z.string(),
    mentionedBot: z.boolean().optional(),
    messageId: z.string().min(1),
    messages: z.array(botTopicInputMessageSchema).min(1).max(200).optional(),
    topicContext: botTopicContextSchema.optional(),
    topicHistory: botTopicHistorySourceSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (
      source.messages &&
      (!source.threadId ||
        source.messages.at(-1)?.messageId !== source.messageId ||
        new Set(source.messages.map((message) => message.messageId)).size !==
          source.messages.length)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Topic batch boundary mismatch",
      });
    }

    if (
      source.topicHistory &&
      (!source.threadId || source.topicHistory.checkpoint !== source.messageId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["topicHistory"],
        message: "Topic history scope mismatch",
      });
    }
    if (
      source.topicContext &&
      (!source.threadId ||
        source.topicContext.checkpoint !== source.messageId ||
        source.topicContext.messages.some(
          (m) => m.chatId !== source.chatId || m.threadId !== source.threadId,
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["topicContext"],
        message: "Topic context scope mismatch",
      });
  });
export type BotGroupInputSource = z.infer<typeof botGroupInputSourceSchema>;
