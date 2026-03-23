/**
 * 自动任务执行器
 * 监控任务队列，自动执行代码生成任务，完成后通知微信
 * @author carels
 */
import { config, loadSavedToken } from './config.js';
import { sendTextMessage } from './weixin-api.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');
const OUTPUT_DIR = join(DATA_DIR, 'outputs');

// 确保输出目录存在
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 初始化
const hasToken = loadSavedToken();
if (!hasToken) {
  console.error('❌ 请先运行: npm run login');
  process.exit(1);
}

console.log('╔════════════════════════════════════════╗');
console.log('║     自动任务执行器                     ║');
console.log('║     (接收任务→自动执行→微信通知)       ║');
console.log('╚════════════════════════════════════════╝\n');
console.log('📂 输出目录:', OUTPUT_DIR);
console.log('⏳ 监控中，收到任务会自动执行...\n');

// 已处理的任务ID
const processedTasks = new Set();

/**
 * 更新任务状态
 */
function updateTask(taskId, status, result = null) {
  if (!existsSync(TASKS_FILE)) return null;
  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = status;
    if (result) task.result = result;
    task.updatedAt = Date.now();
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  }
  return task;
}

/**
 * 自动执行任务
 */
async function executeTask(task) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 开始执行任务 [${task.id}]`);
  console.log(`📝 命令: ${task.text}`);
  console.log(`${'='.repeat(50)}\n`);

  // 标记为处理中
  updateTask(task.id, 'processing');

  try {
    // 解析任务类型
    const text = task.text.toLowerCase();
    let result = '';
    let outputFile = '';

    // 根据任务类型执行不同操作
    if (text.includes('快排') || text.includes('排序') || text.includes('quick sort')) {
      result = await generateQuickSort();
      outputFile = 'quickSort.js';
    } else if (text.includes('爬虫') || text.includes('spider') || text.includes('抓取')) {
      result = await generateSpider(task.text);
      outputFile = 'spider.js';
    } else if (text.includes('密码') || text.includes('password') || text.includes('随机')) {
      result = await generatePasswordGenerator();
      outputFile = 'passwordGenerator.js';
    } else if (text.includes('express') || text.includes('api') || text.includes('服务器')) {
      result = await generateExpressServer();
      outputFile = 'server.js';
    } else {
      // 通用代码生成
      result = await generateGenericCode(task.text);
      outputFile = `task_${task.id}.js`;
    }

    // 保存代码到文件
    const fullPath = join(OUTPUT_DIR, outputFile);
    writeFileSync(fullPath, result);

    // 测试代码
    console.log('🧪 测试代码...');
    let testResult = '✓ 代码生成成功';
    try {
      // 简单语法检查
      execSync(`node --check "${fullPath}"`, { encoding: 'utf-8' });
      testResult = '✓ 代码语法正确';
    } catch (e) {
      testResult = '⚠️ 代码可能有语法问题，请检查';
    }

    // 标记完成
    const successMsg = `✅ 任务完成！\n\n文件: ${outputFile}\n路径: ${fullPath}\n\n${testResult}`;
    updateTask(task.id, 'done', successMsg);

    // 发送微信通知
    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      task.userId,
      successMsg,
      task.contextToken
    );

    console.log(`✅ 任务完成，已通知微信`);
    console.log(`📁 文件: ${fullPath}\n`);

  } catch (err) {
    console.error(`❌ 任务失败:`, err.message);
    const errorMsg = `❌ 任务执行失败: ${err.message}`;
    updateTask(task.id, 'failed', errorMsg);

    await sendTextMessage(
      config.weixinBaseUrl,
      config.weixinBotToken,
      task.userId,
      errorMsg,
      task.contextToken
    );
  }
}

/**
 * 生成快排代码
 */
async function generateQuickSort() {
  return `/**
 * 快速排序算法实现
 * 生成时间: ${new Date().toLocaleString()}
 */

function quickSort(arr) {
  if (arr.length <= 1) return arr;

  const pivot = arr[Math.floor(arr.length / 2)];
  const left = arr.filter(x => x < pivot);
  const middle = arr.filter(x => x === pivot);
  const right = arr.filter(x => x > pivot);

  return [...quickSort(left), ...middle, ...quickSort(right)];
}

// 测试
const testData = [64, 34, 25, 12, 22, 11, 90];
console.log('原始:', testData);
console.log('排序:', quickSort(testData));

module.exports = { quickSort };
`;
}

/**
 * 生成爬虫代码
 */
async function generateSpider(taskText) {
  return `/**
 * 网页爬虫
 * 生成时间: ${new Date().toLocaleString()}
 */

const https = require('https');

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractData(html, pattern) {
  const regex = new RegExp(pattern, 'g');
  const matches = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    matches.push(match[1] || match[0]);
  }
  return matches;
}

// 示例：抓取网页标题
async function spider(url) {
  console.log('🕷️  正在抓取:', url);
  try {
    const html = await fetchHTML(url);
    const titleMatch = html.match(/<title>([^<]+)<\\/title>/i);
    console.log('📄 标题:', titleMatch ? titleMatch[1] : '未找到');
    return html;
  } catch (err) {
    console.error('❌ 抓取失败:', err.message);
  }
}

// 使用示例
// spider('https://api.github.com');

module.exports = { fetchHTML, extractData, spider };
`;
}

/**
 * 生成密码生成器
 */
async function generatePasswordGenerator() {
  return `/**
 * 随机密码生成器
 * 生成时间: ${new Date().toLocaleString()}
 */

function generatePassword(length = 16, options = {}) {
  const {
    uppercase = true,
    lowercase = true,
    numbers = true,
    symbols = true
  } = options;

  let chars = '';
  if (lowercase) chars += 'abcdefghijklmnopqrstuvwxyz';
  if (uppercase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (numbers) chars += '0123456789';
  if (symbols) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';

  if (!chars) throw new Error('至少选择一种字符类型');

  let password = '';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);

  for (let i = 0; i < length; i++) {
    password += chars[array[i] % chars.length];
  }

  return password;
}

// 生成多个密码
console.log('🔐 生成的密码:');
for (let i = 0; i < 5; i++) {
  console.log(\`  \${i + 1}. \${generatePassword()}\`);
}

module.exports = { generatePassword };
`;
}

/**
 * 生成 Express 服务器
 */
async function generateExpressServer() {
  return `/**
 * Express API 服务器
 * 生成时间: ${new Date().toLocaleString()}
 */

const express = require('express');
const app = express();

app.use(express.json());

// 内存存储
const users = [];
const posts = [];

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 用户注册
app.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  const user = { id: users.length + 1, name, email, createdAt: new Date() };
  users.push(user);
  res.status(201).json(user);
});

// 获取用户列表
app.get('/api/users', (req, res) => {
  res.json(users);
});

// 创建文章
app.post('/api/posts', (req, res) => {
  const { title, content, userId } = req.body;
  const post = { id: posts.length + 1, title, content, userId, createdAt: new Date() };
  posts.push(post);
  res.status(201).json(post);
});

// 获取文章列表
app.get('/api/posts', (req, res) => {
  res.json(posts);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`🚀 服务器运行在 http://localhost:\${PORT}\`);
});

module.exports = app;
`;
}

/**
 * 通用代码生成
 */
async function generateGenericCode(taskText) {
  return `/**
 * 自动生成的代码
 * 任务: ${taskText}
 * 生成时间: ${new Date().toLocaleString()}
 */

// TODO: 根据任务实现具体功能
// 任务描述: ${taskText}

function main() {
  console.log('📝 任务:', '${taskText}');
  console.log('请根据任务描述实现具体功能');
}

if (require.main === module) {
  main();
}

module.exports = { main };
`;
}

// 启动监控
console.log('⏳ 等待新任务...\n');

setInterval(async () => {
  if (!existsSync(TASKS_FILE)) return;

  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  const pendingTasks = tasks.filter(t => t.status === 'pending');

  for (const task of pendingTasks) {
    if (!processedTasks.has(task.id)) {
      processedTasks.add(task.id);
      await executeTask(task);
    }
  }
}, 1000); // 每秒检查

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n👋 停止执行器');
  process.exit(0);
});

// 保持进程运行
process.stdin.resume();
