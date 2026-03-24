/**
 * 消息处理器
 * 处理微信消息并调用 Claude
 * 支持智能模式：简单对话即时回复，复杂任务后台处理
 * @author carels
 */
import { config } from './config.js';
import { getClaudeClient } from './claude-client.js';
import { sessionStore } from './session-store.js';
import { sendTextMessage, sendTyping, getConfig, MessageItemType } from './weixin-api.js';
import { addTask, processTaskQueue } from './task-queue.js';

// 特殊命令
const COMMANDS = {
  '/reset': '清空会话历史',
  '/help': '显示帮助信息',
  '/status': '查看服务状态',
};

// 消息日志回调（用于 API 服务器）
let messageLogger = null;
export function setMessageLogger(logger) {
  messageLogger = logger;
}

/**
 * 提取消息文本内容
 */
function extractText(itemList) {
  if (!itemList || !Array.isArray(itemList)) return '';

  for (const item of itemList) {
    // 文本消息
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }

    // 语音转文字
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }

  return '';
}

/**
 * 检查用户权限
 */
function isUserAllowed(userId) {
  console.log(`[调试] 检查用户权限: ${userId}, 白名单: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(',') : '无限制'}`);
  if (config.allowedUsers.length === 0) return true;
  const allowed = config.allowedUsers.includes(userId);
  console.log(`[调试] 用户 ${userId} ${allowed ? '允许' : '拒绝'}`);
  return allowed;
}

/**
 * 处理特殊命令
 */
async function handleCommand(cmd, userId, accountId, contextToken) {
  const claude = getClaudeClient();

  switch (cmd.trim()) {
    case '/reset':
      sessionStore.clearSession(accountId, userId);
      return '✓ 会话历史已清空，开始新的对话。';

    case '/help':
      return `可用命令：
${Object.entries(COMMANDS).map(([k, v]) => `${k} - ${v}`).join('\n')}`;

    case '/status':
      const stats = sessionStore.getStats();
      return `服务状态：
- 活跃会话: ${stats.activeSessions}
- 已缓存 Token: ${stats.tokens}
- 当前账号: ${accountId}`;

    default:
      return null;
  }
}

/**
 * 发送"正在输入"状态
 */
async function indicateTyping(baseUrl, token, userId, contextToken) {
  try {
    const cfg = await getConfig(baseUrl, token, userId, contextToken);
    if (cfg.typing_ticket) {
      await sendTyping(baseUrl, token, userId, cfg.typing_ticket, 1);
    }
  } catch (e) {
    // 非关键功能，忽略错误
  }
}

/**
 * 使用 AI 判断消息类型
 * @returns {Promise<{type: 'simple'|'complex', reason: string}>}
 */
async function classifyMessage(text) {
  const claude = getClaudeClient();

  const prompt = `请分析以下用户消息，判断这是"简单对话"还是"复杂任务"。

判断标准：
- 简单对话：日常聊天、问答、问候、简单解释、观点交流（可在30秒内回复）
- 复杂任务：写代码、生成文件、数据分析、需要多步骤处理、耗时操作

用户消息："""${text}"""

请只返回 JSON 格式，不要其他内容：
{
  "type": "simple" 或 "complex",
  "reason": "判断理由（一句话）"
}`;

  try {
    const response = await claude.ask(prompt, []);
    const result = JSON.parse(response.content.replace(/```json\n?|\n?```/g, '').trim());
    console.log(`[智能分类] 消息类型: ${result.type}, 理由: ${result.reason}`);
    return result;
  } catch (e) {
    console.log('[智能分类] 解析失败，默认为简单对话');
    return { type: 'simple', reason: '默认判断' };
  }
}

/**
 * 处理单条消息 - 智能模式
 */
export async function handleMessage(msg, baseUrl, token, accountId) {
  console.log(`[调试] 处理消息: type=${msg.message_type}, from=${msg.from_user_id}`);

  // 只处理用户消息
  if (msg.message_type !== 1) {
    console.log(`[调试] 忽略非用户消息, message_type=${msg.message_type}`);
    return;
  }

  const userId = msg.from_user_id;
  const contextToken = msg.context_token;

  // 更新 context token
  if (contextToken) {
    sessionStore.setContextToken(accountId, userId, contextToken);
  }

  // 检查权限
  if (!isUserAllowed(userId)) {
    console.log(`[拒绝] 未授权用户: ${userId}`);
    return;
  }

  // 提取文本
  const text = extractText(msg.item_list);
  if (!text) {
    console.log(`[忽略] 无法提取文本内容`);
    return;
  }

  console.log(`[消息] ${userId}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

  // 记录到 API 日志
  if (messageLogger) {
    messageLogger('in', userId, text);
  }

  // 检查是否命令
  const cmdResponse = await handleCommand(text, userId, accountId, contextToken);
  if (cmdResponse) {
    await sendTextMessage(baseUrl, token, userId, cmdResponse, contextToken);
    return;
  }

  // 智能判断消息类型
  const classification = await classifyMessage(text);

  if (classification.type === 'complex') {
    // 复杂任务：创建任务队列，后台处理
    console.log(`[智能处理] 识别为复杂任务，创建后台任务`);

    // 通知用户任务已创建
    await sendTextMessage(
      baseUrl,
      token,
      userId,
      `⏳ 收到复杂任务，正在后台处理...\n任务内容：${text.substring(0, 50)}${text.length > 50 ? '...' : ''}\n\n完成后会通知您。`,
      contextToken
    );

    // 创建任务
    const task = await addTask({
      userId,
      text,
      contextToken,
      accountId,
      baseUrl,
      token,
    });

    console.log(`[智能处理] 任务已创建: ${task.id}`);

    // 启动后台处理（不等待完成）
    processTaskQueue().catch(err => {
      console.error('[任务处理] 后台处理出错:', err.message);
    });

  } else {
    // 简单对话：即时回复
    console.log(`[智能处理] 识别为简单对话，即时回复`);

    // 发送"正在输入"状态
    try {
      await indicateTyping(baseUrl, token, userId, contextToken);
    } catch (e) {
      console.log('[调试] indicateTyping 失败（非关键）:', e.message);
    }

    try {
      // 获取当前会话的历史
      const history = sessionStore.getHistory(accountId, userId);

      // 调用 Claude
      console.log('[调试] 正在调用 Claude API...');
      const claude = getClaudeClient();
      const response = await claude.ask(text, history);
      console.log('[调试] Claude 返回:', response.content?.substring(0, 50) + '...');

      // 保存对话历史
      sessionStore.addMessage(accountId, userId, 'user', text);
      sessionStore.addMessage(accountId, userId, 'assistant', response.content);

      // 发送回复
      const reply = response.content;
      const chunks = splitMessage(reply, 4000);

      for (const chunk of chunks) {
        await sendTextMessage(baseUrl, token, userId, chunk, contextToken);
      }

      console.log(`[回复] 已发送 ${chunks.length} 条消息，共 ${reply.length} 字`);

    } catch (err) {
      console.error('Claude API 错误:', err.message);
      await sendTextMessage(
        baseUrl,
        token,
        userId,
        '抱歉，处理消息时出现错误，请稍后重试。',
        contextToken
      );
    }
  }
}

/**
 * 分割长消息
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';

  // 按段落分割
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if ((current + para).length > maxLength) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n' : '') + para;
    }
  }

  if (current) chunks.push(current.trim());

  // 如果还有太长的，强制截断
  return chunks.flatMap(chunk => {
    if (chunk.length <= maxLength) return [chunk];
    const subChunks = [];
    for (let i = 0; i < chunk.length; i += maxLength) {
      subChunks.push(chunk.slice(i, i + maxLength));
    }
    return subChunks;
  });
}
