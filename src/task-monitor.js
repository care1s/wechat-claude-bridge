/**
 * 实时任务处理器
 * 持续监控任务队列，有新任务立即处理
 * @author carels
 */
import { config, loadSavedToken } from './config.js';
import { sendTextMessage } from './weixin-api.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');

let lastTaskCount = 0;

// 初始化
const hasToken = loadSavedToken();
if (!hasToken) {
  console.error('❌ 请先运行: npm run login');
  process.exit(1);
}

console.log('╔════════════════════════════════════════╗');
console.log('║     实时任务处理器                     ║');
console.log('║     (自动监控并处理任务)               ║');
console.log('╚════════════════════════════════════════╝\n');
console.log('⏳ 持续监控中，有新任务会自动显示...\n');
console.log('按 Ctrl+C 退出\n');

// 持续监控
setInterval(async () => {
  if (!existsSync(TASKS_FILE)) return;

  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  const pendingTasks = tasks.filter(t => t.status === 'pending');

  if (pendingTasks.length > lastTaskCount) {
    // 有新任务！
    const newTask = pendingTasks[pendingTasks.length - 1];
    console.log('\n' + '='.repeat(50));
    console.log('🔔 收到新任务！');
    console.log('='.repeat(50));
    console.log(`任务ID: ${newTask.id}`);
    console.log(`用户: ${newTask.userId}`);
    console.log(`命令: ${newTask.text}`);
    console.log('='.repeat(50));
    console.log('\n💡 处理完成后运行:');
    console.log(`   node cli.js task-done ${newTask.id} "结果描述"`);
    console.log('\n或者运行自动处理:');
    console.log(`   node task-auto.js ${newTask.id}`);
    console.log('');
  }

  lastTaskCount = pendingTasks.length;
}, 1000); // 每秒检查一次

// 保持进程运行
process.stdin.resume();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n👋 停止监控');
  process.exit(0);
});
