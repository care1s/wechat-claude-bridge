/**
 * 微信-Claude 桥接服务
 * 主程序入口
 * @author carels
 */
import { config, loadSavedToken, validateConfig } from './config.js';
import { getUpdates } from './weixin-api.js';
import { getClaudeClient } from './claude-client.js';
import { sessionStore } from './session-store.js';
import { handleMessage } from './message-handler.js';
import { startTaskProcessor } from './task-queue.js';

// 运行状态
let isRunning = true;
let syncBuf = '';
let consecutiveErrors = 0;
const MAX_ERRORS = 5;
const ERROR_BACKOFF_MS = 30000;

/**
 * 主循环
 */
async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     微信-Claude 桥接服务               ║');
  console.log('║     Weixin-Claude Bridge               ║');
  console.log('╚════════════════════════════════════════╝\n');

  // 1. 加载配置
  try {
    validateConfig();
  } catch (err) {
    console.error('配置错误:', err.message);
    console.error('\n请先复制 .env.example 到 .env 并配置 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  // 2. 加载保存的 token
  const hasToken = loadSavedToken();
  if (!hasToken || !config.weixinBotToken) {
    console.error('未找到登录凭据，请先运行: npm run login');
    process.exit(1);
  }

  console.log('✓ 配置加载成功');
  console.log(`  Claude 模型: ${config.claudeModel}`);
  console.log(`  微信账号: ${config.weixinAccountId}`);
  console.log(`  网关地址: ${config.weixinBaseUrl}`);
  console.log(`  允许用户: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(', ') : '所有用户'}\n`);

  // 3. 初始化 Claude 客户端
  try {
    getClaudeClient();
    console.log('✓ Claude 客户端初始化成功\n');
  } catch (err) {
    console.error('Claude 客户端初始化失败:', err.message);
    process.exit(1);
  }

  // 4. 启动后台任务处理器
  startTaskProcessor(3000); // 每3秒检查一次任务队列
  console.log('✓ 后台任务处理器已启动\n');

  // 5. 启动消息轮询
  console.log('🚀 启动消息轮询服务...\n');
  console.log('按 Ctrl+C 停止服务\n');

  // 处理退出信号
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

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
        consecutiveErrors = 0; // 重置错误计数

        console.log(`[调试] 收到 ${result.msgs.length} 条消息`);

        for (const msg of result.msgs) {
          console.log('[调试] 消息详情:', {
            from: msg.from_user_id,
            type: msg.message_type,
            items: msg.item_list?.map(i => i.type),
          });

          try {
            await handleMessage(
              msg,
              config.weixinBaseUrl,
              config.weixinBotToken,
              config.weixinAccountId
            );
          } catch (err) {
            console.error('处理消息失败:', err.message);
          }
        }
      }

      // 根据服务端建议调整超时
      if (result.timeoutMs) {
        // 服务端建议的超时已用于 getUpdates 调用
      }

    } catch (err) {
      consecutiveErrors++;
      console.error(`\n轮询错误 (${consecutiveErrors}/${MAX_ERRORS}):`, err.message);

      if (consecutiveErrors >= MAX_ERRORS) {
        console.error('\n连续错误次数过多，服务暂停 30 秒...');
        await sleep(ERROR_BACKOFF_MS);
        consecutiveErrors = 0;
      } else {
        await sleep(5000);
      }
    }
  }
}

/**
 * 优雅退出
 */
function gracefulShutdown() {
  console.log('\n\n👋 正在关闭服务...');
  isRunning = false;

  const stats = sessionStore.getStats();
  console.log(`会话统计: ${stats.activeSessions} 个活跃会话`);

  setTimeout(() => {
    console.log('再见！\n');
    process.exit(0);
  }, 1000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 启动
main().catch(err => {
  console.error('服务异常:', err);
  process.exit(1);
});
