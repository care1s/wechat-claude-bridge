/**
 * 全自动 AI 回复机器人
 * 收到微信消息后自动调用 Claude API 回复
 * @author carels
 */
import { config, loadSavedToken, validateConfig } from './config.js';
import { getUpdates, sendTextMessage, getConfig, sendTyping } from './weixin-api.js';
import { sessionStore } from './session-store.js';
import { getClaudeClient } from './claude-client.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 任务队列目录
const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const OUTPUT_DIR = join(DATA_DIR, 'outputs');

// 确保目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 运行状态
let isRunning = true;
let syncBuf = '';
let consecutiveErrors = 0;
const MAX_ERRORS = 5;

/**
 * 添加任务到队列
 */
function addTask(userId, text, contextToken) {
  const tasks = existsSync(TASKS_FILE) ? JSON.parse(readFileSync(TASKS_FILE, 'utf-8')) : [];
  const task = {
    id: Date.now().toString(36),
    userId,
    text,
    contextToken,
    createdAt: Date.now(),
    status: 'waiting', // waiting: 等待Claude处理
  };
  tasks.push(task);
  writeFileSync(TASKS_FILE, JSON.stringify(tasks.slice(-50), null, 2));
  return task;
}

/**
 * 更新任务状态
 */
function updateTask(taskId, status, result = null) {
  if (!existsSync(TASKS_FILE)) return;
  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = status;
    if (result) task.result = result;
    task.updatedAt = Date.now();
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  }
}

/**
 * 保存待回复消息
 */
function savePendingReply(userId, message, contextToken) {
  const pending = existsSync(PENDING_FILE) ? JSON.parse(readFileSync(PENDING_FILE, 'utf-8')) : [];
  pending.push({ userId, message, contextToken, createdAt: Date.now() });
  writeFileSync(PENDING_FILE, JSON.stringify(pending.slice(-20), null, 2));
}

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
 * 处理单条消息 - 混合模式
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

  // ========== CLI 任务模式 ==========
  // 如果以 /cli 开头，自动执行并回复
  if (text.startsWith('/cli ')) {
    const command = text.slice(5).trim();
    console.log(`   🚀 CLI 任务: ${command}`);

    // 发送"处理中"通知
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      `⏳ 任务接收: ${command.substring(0, 30)}${command.length > 30 ? '...' : ''}\n正在生成代码，请稍候...`,
      contextToken
    );

    try {
      // 调用 AI 生成代码
      const claude = getClaudeClient();
      const prompt = `请生成完成以下任务的代码:\n${command}\n\n要求:\n1. 提供完整的可运行代码\n2. 包含必要的注释\n3. 如果是算法，提供测试用例\n4. 说明如何使用\n5. 代码用 markdown 代码块包裹，标明语言`;

      console.log('   🤖 AI 正在生成代码...');
      const response = await claude.ask(prompt, []);

      // 提取代码块
      let result = response.content;
      let savedFiles = [];

      // 匹配所有代码块
      const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
      let match;
      let fileIndex = 0;

      while ((match = codeBlockRegex.exec(response.content)) !== null) {
        const lang = match[1] || 'txt';
        const code = match[2];

        // 根据语言确定扩展名
        const extMap = {
          javascript: 'js', js: 'js',
          typescript: 'ts', ts: 'ts',
          python: 'py', py: 'py',
          java: 'java',
          go: 'go',
          rust: 'rs',
          c: 'c',
          cpp: 'cpp', 'c++': 'cpp',
          html: 'html',
          css: 'css',
          json: 'json',
          yaml: 'yml', yml: 'yml',
          markdown: 'md', md: 'md',
          bash: 'sh', shell: 'sh', sh: 'sh',
          sql: 'sql',
        };

        const ext = extMap[lang.toLowerCase()] || 'txt';
        const fileName = `task_${Date.now()}_${fileIndex || ''}.${ext}`;
        const filePath = join(OUTPUT_DIR, fileName);

        writeFileSync(filePath, code);
        savedFiles.push({ name: fileName, path: filePath, lang });
        fileIndex++;
      }

      // 构建简洁的成功消息（不包含代码内容）
      let successMsg = '';
      if (savedFiles.length > 0) {
        successMsg = `✅ 生成成功！\n\n📁 共保存 ${savedFiles.length} 个文件:\n${savedFiles.map(f => `  • ${f.name}`).join('\n')}\n\n📂 文件位置:\n${OUTPUT_DIR}\n\n💡 在 CLI 中查看代码:\ncat ${savedFiles[0].path}`;
        console.log(`   ✅ 任务完成！已保存 ${savedFiles.length} 个文件`);
      } else {
        successMsg = `✅ 生成成功！（无代码块保存）`;
        console.log(`   ✅ 任务完成！无代码块保存`);
      }

      // 只发送状态信息（不包含代码内容）
      await sendTextMessage(
        config.weixinBaseUrl,
        config.weixinBotToken,
        userId,
        successMsg,
        contextToken
      );

    } catch (err) {
      console.error(`   ❌ 任务失败:`, err.message);
      await sendTextMessage(
        config.weixinBaseUrl,
        config.weixinBotToken,
        userId,
        `❌ 生成失败！\n\n错误信息: ${err.message}\n\n请重试或联系管理员`,
        contextToken
      );
    }
    return;
  }

  // ========== 自动 AI 回复模式 ==========
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
