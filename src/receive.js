/**
 * 全自动 AI 回复机器人
 * 收到微信消息后自动调用 Claude API 回复
 * @author carels
 */
import { config, loadSavedToken, validateConfig } from './config.js';
import { getUpdates, sendTextMessage, getConfig, sendTyping } from './weixin-api.js';
import { sessionStore } from './session-store.js';
import { getClaudeClient } from './claude-client.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
    const cwd = process.cwd();
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      `服务状态：\n- 活跃会话: ${stats.activeSessions}\n- 已缓存 Token: ${stats.tokens}\n- 当前工作目录: ${cwd}`,
      contextToken
    );
    console.log('   ✓ 已发送状态');
    return;
  }

  if (text === '/chat') {
    // 切换到聊天模式
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      '💬 已进入聊天模式\n现在你可以和我正常对话了',
      contextToken
    );
    console.log('   💬 切换到聊天模式');
    return;
  }

  // ========== CLI 任务模式 ==========
  // 所有消息默认都走 CLI 处理，除非是特殊命令
  const isSpecialCommand = text === '/exit' || text === '/quit' || text === '/reset' || text === '/status' || text === '/chat';

  if (!isSpecialCommand) {
    const command = text;
    console.log(`   🚀 CLI 任务: ${command}`);

    // 首先询问 AI 判断用户意图
    console.log('   🤔 正在分析用户意图...');
    const claudeForIntent = getClaudeClient();

    const intentPrompt = `请分析用户的意图，判断以下消息是在询问什么：\n\n用户消息: "${command}"\n\n请从以下选项中选择最符合的意图（只返回数字编号）：\n1. 询问插件列表/有哪些插件/有什么插件\n2. 询问帮助信息\n3. 请求生成代码/写代码/创建代码\n4. 询问系统状态\n5. 其他聊天/对话\n\n只返回数字编号（1-5），不要有任何其他内容。`;

    const intentResponse = await claudeForIntent.ask(intentPrompt, []);
    const intent = intentResponse.content.trim().match(/[1-5]/)?.[0] || '5';
    console.log(`   🎯 用户意图: ${intent}`);

    // 根据意图处理
    if (intent === '1' || intent === '2') {
      // 插件列表查询 - 已有代码，保持原样
      const pluginList = `📋 可用插件列表:

1️⃣ brainstorming (头脑风暴)
   用途: 创意构思、方案探索
   示例: /brainstorm 设计一个社交电商APP

2️⃣ writing-plans (编写计划)
   用途: 制定开发计划、架构设计
   示例: /writing-plans 创建用户系统模块

3️⃣ executing-plans (执行计划)
   用途: 按步骤执行复杂任务
   示例: /executing-plans 实现购物车功能

4️⃣ test-driven-development (测试驱动开发)
   用途: 先写测试再写代码
   示例: /tdd 实现登录验证功能

5️⃣ using-git-worktrees (Git工作区)
   用途: 创建隔离的开发分支
   示例: /worktree 开发新功能分支

6️⃣ requesting-code-review (代码审查)
   用途: 检查代码质量
   示例: /review 检查这段代码

7️⃣ verification-before-completion (完成前验证)
   用途: 验证任务完成度
   示例: /verify 检查功能是否完整

8️⃣ path/cd (切换工作目录)
   用途: 切换工作目录并加载 CLAUDE.md
   示例: /path ~/projects/myapp
   示例: /cd ~/workspace

💡 特殊命令:
/chat - 切换到普通聊天模式
/reset - 清空会话历史
/status - 查看服务状态
/exit - 退出服务

📝 普通代码生成（直接输入）:
帮我创建一个爬虫
帮我写一个快速排序算法

      await sendTextMessage(
        config.weixinBaseUrl,
        config.weixinBotToken,
        userId,
        pluginList,
        contextToken
      );
      console.log('   📋 已发送插件列表');
      return;
    }

    // 意图 4: 系统状态查询
    if (intent === '4') {
      const stats = sessionStore.getStats();
      const cwd = process.cwd();
      await sendTextMessage(
        config.weixinBaseUrl,
        config.weixinBotToken,
        userId,
        `服务状态：\n- 活跃会话: ${stats.activeSessions}\n- 已缓存 Token: ${stats.tokens}\n- 当前工作目录: ${cwd}`,
        contextToken
      );
      console.log('   ✓ 已发送状态');
      return;
    }

    // 意图 5: 普通聊天 - 直接返回AI回复，不走代码生成
    if (intent === '5') {
      const history = sessionStore.getHistory(config.weixinAccountId, userId);
      const claude = getClaudeClient();
      console.log('   💬 进入聊天模式...');
      const response = await claude.ask(text, history);

      // 保存对话历史
      sessionStore.addMessage(config.weixinAccountId, userId, 'user', text);
      sessionStore.addMessage(config.weixinAccountId, userId, 'assistant', response.content);

      // 发送回复
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
      console.log(`   ✅ 已回复 (${response.content.length} 字)`);
      return;
    }

    // 意图 3: 代码生成任务 - 发送"处理中"通知并开始生成
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      userId,
      `⏳ 收到任务: ${text.substring(0, 30)}${text.length > 30 ? '...' : ''}\n正在生成代码，请稍候...`,
      contextToken
    );

    try {
      // 检测是否使用插件命令
      let prompt;
      let usePlugin = false;
      let command = text;

      // 检查是否以 / 开头（插件命令）
      if (command.startsWith('/')) {
        const pluginCmd = command.split(' ')[0].slice(1); // 去掉 /
        const pluginTask = command.split(' ').slice(1).join(' ');

        // 根据插件类型构建不同的提示词
        const pluginPrompts = {
          'brainstorm': `请使用头脑风暴方法，帮助用户探索和构思以下需求:\n${pluginTask}\n\n请提供:\n1. 多种可能的解决方案\n2. 每种方案的优缺点\n3. 推荐的最佳方案及理由`,

          'writing-plans': `请为以下任务制定详细的开发计划:\n${pluginTask}\n\n请包含:\n1. 需求分析\n2. 技术选型\n3. 模块划分\n4. 实施步骤\n5. 注意事项`,

          'executing-plans': `请按照最佳实践，分步骤执行以下任务:\n${pluginTask}\n\n请提供:\n1. 步骤分解\n2. 每个步骤的具体操作\n3. 完整可运行的代码\n4. 测试验证方法`,

          'tdd': `请使用测试驱动开发(TDD)方式完成:\n${pluginTask}\n\n请按TDD流程:\n1. 先编写测试用例\n2. 编写最小实现代码\n3. 重构优化\n4. 提供最终代码和测试`,

          'test-driven-development': `请使用测试驱动开发(TDD)方式完成:\n${pluginTask}\n\n请按TDD流程:\n1. 先编写测试用例\n2. 编写最小实现代码\n3. 重构优化\n4. 提供最终代码和测试`,

          'worktree': `请提供Git工作区操作指南:\n${pluginTask}\n\n请包含:\n1. 创建工作区命令\n2. 切换工作区\n3. 清理工作区\n4. 最佳实践`,

          'using-git-worktrees': `请提供Git工作区操作指南:\n${pluginTask}\n\n请包含:\n1. 创建工作区命令\n2. 切换工作区\n3. 清理工作区\n4. 最佳实践`,

          'review': `请对以下代码进行审查:\n${pluginTask}\n\n请检查:\n1. 代码质量\n2. 潜在问题\n3. 改进建议\n4. 最佳实践`,

          'requesting-code-review': `请对以下代码进行审查:\n${pluginTask}\n\n请检查:\n1. 代码质量\n2. 潜在问题\n3. 改进建议\n4. 最佳实践`,

          'verify': `请验证以下任务的完成度:\n${pluginTask}\n\n请检查:\n1. 功能完整性\n2. 边界情况\n3. 潜在问题\n4. 优化建议`,

          'verification-before-completion': `请验证以下任务的完成度:\n${pluginTask}\n\n请检查:\n1. 功能完整性\n2. 边界情况\n3. 潜在问题\n4. 优化建议`,

          'path': `WORKING_DIR:${pluginTask}`, // 特殊标记，表示切换目录
          'cd': `WORKING_DIR:${pluginTask}`, // 别名
        };

        if (pluginPrompts[pluginCmd]) {
          prompt = pluginPrompts[pluginCmd];
          usePlugin = true;
          console.log(`   🔌 使用插件: ${pluginCmd}`);

          // 特殊处理：切换工作目录
          if (pluginCmd === 'path' || pluginCmd === 'cd') {
            const targetDir = pluginTask.trim();
            const expandedDir = targetDir.replace(/^~/, homedir());
            const fullPath = resolve(expandedDir);

            // 检查目录是否存在
            if (!existsSync(fullPath)) {
              await sendTextMessage(
                config.weixinBaseUrl,
                config.weixinBotToken,
                userId,
                `❌ 目录不存在: ${fullPath}\n\n请先创建目录:\nmkdir -p ${fullPath}`,
                contextToken
              );
              return;
            }

            // 切换到目标目录
            process.chdir(fullPath);
            console.log(`   📂 已切换到目录: ${fullPath}`);

            // 检查 claude.md 文件
            const claudeMdPath = join(fullPath, 'CLAUDE.md');
            let claudeMdContent = '';
            let hasClaudeMd = false;

            if (existsSync(claudeMdPath)) {
              hasClaudeMd = true;
              claudeMdContent = readFileSync(claudeMdPath, 'utf-8');
              console.log(`   📄 发现 CLAUDE.md 文件`);
            }

            // 构建回复消息
            let replyMsg = `✅ 已切换到工作目录:\n${fullPath}\n\n📂 当前目录内容:\n`;

            // 列出目录中的文件
            const files = readdirSync(fullPath).slice(0, 20);
            files.forEach(f => {
              const stat = statSync(join(fullPath, f));
              const type = stat.isDirectory() ? '📁' : '📄';
              replyMsg += `  ${type} ${f}\n`;
            });

            if (hasClaudeMd) {
              replyMsg += `\n📄 发现 CLAUDE.md，已加载上下文:\n${claudeMdContent.substring(0, 500)}${claudeMdContent.length > 500 ? '...' : ''}`;
            } else {
              replyMsg += `\n💡 提示: 此目录没有 CLAUDE.md 文件\n可以创建 CLAUDE.md 来记录项目上下文`;
            }

            await sendTextMessage(
              config.weixinBaseUrl,
              config.weixinBotToken,
              userId,
              replyMsg,
              contextToken
            );
            return;
          }
        } else {
          // 未知插件，使用默认方式
          prompt = `请生成完成以下任务的代码:\n${command}\n\n要求:\n1. 提供完整的可运行代码\n2. 包含必要的注释\n3. 如果是算法，提供测试用例\n4. 说明如何使用\n5. 代码用 markdown 代码块包裹，标明语言`;
        }
      } else {
        // 普通代码生成
        prompt = `请生成完成以下任务的代码:\n${command}\n\n要求:\n1. 提供完整的可运行代码\n2. 包含必要的注释\n3. 如果是算法，提供测试用例\n4. 说明如何使用\n5. 代码用 markdown 代码块包裹，标明语言`;
      }

      // 调用 AI
      const claude = getClaudeClient();

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

      // 判断是否有代码块
      if (savedFiles.length > 0) {
        // 有代码块：只返回文件名列表
        const successMsg = `✅ 代码生成成功！\n\n📁 已保存 ${savedFiles.length} 个文件:\n${savedFiles.map(f => `  • ${f.name}`).join('\n')}\n\n💡 查看代码:\ncat ${savedFiles[0].path}`;
        await sendTextMessage(
          config.weixinBaseUrl,
          config.weixinBotToken,
          userId,
          successMsg,
          contextToken
        );
        console.log(`   ✅ 任务完成！已保存 ${savedFiles.length} 个文件`);
      } else {
        // 无代码块：返回原AI回复内容
        const chunks = splitMessage(result, 4000);
        for (const chunk of chunks) {
          await sendTextMessage(
            config.weixinBaseUrl,
            config.weixinBotToken,
            userId,
            chunk,
            contextToken
          );
        }
        console.log(`   ✅ 任务完成！已回复内容`);
      }

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
