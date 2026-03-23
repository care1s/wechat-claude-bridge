/**
 * 全自动 AI 回复机器人
 * 收到微信消息后自动调用 Claude API 回复
 * @author carels
 */
import { config, loadSavedToken, validateConfig } from './config.js';
import { getUpdates, sendTextMessage, getConfig, sendTyping } from './weixin-api.js';
import { sessionStore } from './session-store.js';
import { getClaudeClient } from './claude-client.js';

// 运行状态
let isRunning = true;
let syncBuf = '';
let consecutiveErrors = 0;
const MAX_ERRORS = 5;

/**
 * 提取消息文本
 */
function extractText(itemList) {
  if (!itemList || !Array.isArray(itemList)) return '';
  for (const item of itemList) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text;
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
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
 * 分割长消息（微信限制约4000字）
 */
function splitMessage(text, maxLength = 4000) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = '';
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

/**
 * 处理单条消息 - 自动 AI 回复
 */
async function handleMessage(msg) {
  // 只处理用户消息
  if (msg.message_type !== 1) return;

  const userId = msg.from_user_id;
  const contextToken = msg.context_token;

  // 更新 context token
  if (contextToken) {
    sessionStore.setContextToken(config.weixinAccountId, userId, contextToken);
  }

  // 提取文本
  const text = extractText(msg.item_list);
  if (!text) return;

  console.log(`\n💬 [${new Date().toLocaleTimeString()}] 收到消息`);
  console.log(`   来自: ${userId}`);
  console.log(`   内容: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);

  // 特殊命令处理
  if (text === '/exit' || text === '/quit') {
    console.log('👋 收到退出命令');
    isRunning = false;
    return;
  }

  if (text === '/reset') {
    sessionStore.clearSession(config.weixinAccountId, userId);
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      '✓ 会话历史已清空',
      contextToken
    );
    console.log('   ✓ 已重置会话');
    return;
  }

  if (text === '/status') {
    const stats = sessionStore.getStats();
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      `服务状态：\n- 活跃会话: ${stats.activeSessions}\n- 已缓存 Token: ${stats.tokens}`,
      contextToken
    );
    console.log('   ✓ 已发送状态');
    return;
  }

  // 获取历史对话
  const history = sessionStore.getHistory(config.weixinAccountId, userId);

  // 发送"正在输入"状态
  try {
    await indicateTyping(config.weixinBaseUrl, config.weixinBotToken, userId, contextToken);
  } catch (e) {}

  // 调用 Claude API
  console.log('   🤖 正在思考...');
  try {
    const claude = getClaudeClient();
    const response = await claude.ask(text, history);

    // 保存对话历史
    sessionStore.addMessage(config.weixinAccountId, userId, 'user', text);
    sessionStore.addMessage(config.weixinAccountId, userId, 'assistant', response.content);

    // 分段发送回复
    const chunks = splitMessage(response.content, 4000);
    for (const chunk of chunks) {
      await sendTextMessage(
        config.weixinBaseUrl,
        config.weixinBotToken,
        userId,
        chunk,
        contextToken
      );
    }

    console.log(`   ✅ 已回复 (${response.content.length} 字, ${chunks.length} 条)`);

  } catch (err) {
    console.error('   ❌ AI 回复失败:', err.message);
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      '抱歉，处理消息时出现错误，请稍后重试。',
      contextToken
    );
  }
}

/**
 * 主循环
 */
async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     全自动 AI 微信机器人               ║');
  console.log('║     (自动回复模式)                     ║');
  console.log('╚════════════════════════════════════════╝\n');

  // 验证配置
  try {
    validateConfig();
  } catch (err) {
    console.error('❌ 配置错误:', err.message);
    process.exit(1);
  }

  // 加载 token
  const hasToken = loadSavedToken();
  if (!hasToken || !config.weixinBotToken) {
    console.error('❌ 未找到登录凭据，请先运行: npm run login');
    process.exit(1);
  }

  // 初始化 Claude 客户端
  try {
    getClaudeClient();
  } catch (err) {
    console.error('❌ Claude 客户端初始化失败:', err.message);
    process.exit(1);
  }

  console.log('✓ 配置加载成功');
  console.log(`  Claude 模型: ${config.claudeModel}`);
  console.log(`  微信账号: ${config.weixinAccountId}`);
  console.log(`  系统提示: ${config.systemPrompt.substring(0, 50)}...`);
  console.log('\n🚀 启动自动回复服务...');
  console.log('✓ 收到消息后将自动调用 AI 回复');
  console.log('✓ 按 Ctrl+C 或发送 /exit 退出\n');

  // 处理退出信号
  process.on('SIGINT', () => {
    console.log('\n\n👋 正在关闭服务...');
    isRunning = false;
    process.exit(0);
  });

  // 主循环
  while (isRunning) {
    try {
      const result = await getUpdates(
        config.weixinBaseUrl,
        config.weixinBotToken,
        syncBuf,
        35000
      );

      // 更新同步游标
      if (result.syncBuf) {
        syncBuf = result.syncBuf;
      }

      // 处理消息
      if (result.msgs && result.msgs.length > 0) {
        consecutiveErrors = 0;

        for (const msg of result.msgs) {
          await handleMessage(msg);
        }
      }

    } catch (err) {
      consecutiveErrors++;
      console.error(`\n⚠️ 轮询错误 (${consecutiveErrors}/${MAX_ERRORS}):`, err.message);

      if (consecutiveErrors >= MAX_ERRORS) {
        console.error('\n连续错误次数过多，暂停 30 秒...');
        await sleep(30000);
        consecutiveErrors = 0;
      } else {
        await sleep(5000);
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('服务异常:', err);
  process.exit(1);
});
