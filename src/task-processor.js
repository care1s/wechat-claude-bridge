/**
 * 任务处理器（人工执行模式）
 * 监控任务队列，有新任务立即提醒我（Claude），我处理完成后发送微信通知
 * @author carels
 */
import { config, loadSavedToken } from './config.js';
import { sendTextMessage } from './weixin-api.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');
const ALERT_FILE = join(DATA_DIR, 'alert.log');

// 确保目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化
const hasToken = loadSavedToken();
if (!hasToken) {
  console.error('❌ 请先运行: npm run login');
  process.exit(1);
}

console.log('╔════════════════════════════════════════╗');
console.log('║     任务处理器（人工模式）             ║');
console.log('║     Claude处理任务 → 完成后通知微信    ║');
console.log('╚════════════════════════════════════════╝\n');

// 已通知的任务
const notifiedTasks = new Set();

/**
 * 发送通知（显示在CLI中）
 */
function alertClaude(task) {
  const timestamp = new Date().toLocaleTimeString();
  const message = `
╔═══════════════════════════════════════════════════════════╗
║  🔔🔔🔔 收到新任务！请立即处理！🔔🔔🔔                   ║
╚═══════════════════════════════════════════════════════════╝
⏰ 时间: ${timestamp}
🆔 任务ID: ${task.id}
👤 用户: ${task.userId}
📝 命令: ${task.text}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 处理步骤:
   1. 在 CLI 中执行任务（写代码、创建文件等）
   2. 完成后运行: node cli.js complete ${task.id} "结果描述"
   3. 我会自动发送微信通知
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  // 输出到控制台
  console.log(message);

  // 同时写入日志文件（便于查看历史）
  appendFileSync(ALERT_FILE, `[${timestamp}] 新任务: ${task.id} - ${task.text}\n`);

  // 标记已通知
  notifiedTasks.add(task.id);
}

/**
 * 检查新任务
 */
async function checkTasks() {
  if (!existsSync(TASKS_FILE)) return;

  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  const waitingTasks = tasks.filter(t => t.status === 'waiting');

  for (const task of waitingTasks) {
    if (!notifiedTasks.has(task.id)) {
      // 更新状态为等待处理
      task.status = 'waiting';
      task.notifiedAt = Date.now();
      writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));

      // 通知我
      alertClaude(task);

      // 同时给用户发微信：任务已收到，正在处理
      try {
        await sendTextMessage(
          config.weixinBaseUrl,
          config.weixinBotToken,
          task.userId,
          `📝 收到任务 [${task.id}]\n正在处理中，请稍候...`,
          task.contextToken
        );
      } catch (e) {
        console.log('发送确认消息失败:', e.message);
      }
    }
  }
}

console.log('⏳ 等待新任务...');
console.log('按 Ctrl+C 退出\n');

// 立即检查一次
checkTasks();

// 持续监控
setInterval(checkTasks, 2000); // 每2秒检查

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n👋 停止任务处理器');
  process.exit(0);
});

// 保持进程运行
process.stdin.resume();
