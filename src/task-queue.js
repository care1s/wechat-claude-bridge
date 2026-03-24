/**
 * 任务队列管理器
 * 支持自动处理复杂任务
 * @author carels
 */
import { config } from './config.js';
import { getClaudeClient } from './claude-client.js';
import { sendTextMessage } from './weixin-api.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');

// 确保目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 初始化任务文件
if (!existsSync(TASKS_FILE)) {
  writeFileSync(TASKS_FILE, '[]');
}

// 正在处理的任务锁
const processingTasks = new Set();

/**
 * 生成任务ID
 */
function generateTaskId() {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
}

/**
 * 添加任务到队列
 */
export async function addTask({ userId, text, contextToken, accountId, baseUrl, token }) {
  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));

  const task = {
    id: generateTaskId(),
    userId,
    text,
    contextToken,
    accountId,
    baseUrl,
    token,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  tasks.push(task);
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));

  console.log(`[任务队列] 新任务已创建: ${task.id}`);
  return task;
}

/**
 * 更新任务状态
 */
function updateTask(taskId, updates) {
  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    Object.assign(task, updates, { updatedAt: Date.now() });
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  }
  return task;
}

/**
 * 获取待处理任务
 */
function getPendingTasks() {
  if (!existsSync(TASKS_FILE)) return [];
  const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  return tasks.filter(t => t.status === 'pending');
}

/**
 * 处理单个任务
 */
async function processTask(task) {
  if (processingTasks.has(task.id)) {
    console.log(`[任务处理] 任务 ${task.id} 正在处理中，跳过`);
    return;
  }

  processingTasks.add(task.id);
  console.log(`[任务处理] 开始处理任务: ${task.id}`);

  try {
    // 更新状态为处理中
    updateTask(task.id, { status: 'processing' });

    // 调用 AI 处理任务
    const claude = getClaudeClient();
    const response = await claude.ask(task.text, []);

    const result = response.content;
    console.log(`[任务处理] 任务 ${task.id} 处理完成，结果长度: ${result.length}`);

    // 发送结果给用户
    await sendTaskResult(task, result);

    // 更新状态为完成
    updateTask(task.id, {
      status: 'done',
      result: result.substring(0, 500),
      completedAt: Date.now(),
    });

    console.log(`[任务处理] 任务 ${task.id} 已完成，结果已发送给用户`);

  } catch (err) {
    console.error(`[任务处理] 任务 ${task.id} 处理失败:`, err.message);

    // 发送失败通知
    await sendTextMessage(
      task.baseUrl || config.weixinBaseUrl,
      task.token || config.weixinBotToken,
      task.userId,
      `❌ 任务处理失败: ${err.message}\n请重试或联系管理员。`,
      task.contextToken
    );

    updateTask(task.id, {
      status: 'failed',
      error: err.message,
    });
  } finally {
    processingTasks.delete(task.id);
  }
}

/**
 * 发送任务结果给用户
 */
async function sendTaskResult(task, result) {
  const baseUrl = task.baseUrl || config.weixinBaseUrl;
  const token = task.token || config.weixinBotToken;

  // 构建消息
  let message = `✅ 任务完成！\n\n`;
  message += `📝 任务内容：${task.text.substring(0, 50)}${task.text.length > 50 ? '...' : ''}\n\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 如果结果太长，分段发送
  const MAX_LENGTH = 4000;
  const chunks = [];

  // 先添加任务头部
  let currentMessage = message;

  if (result.length <= MAX_LENGTH - currentMessage.length) {
    // 结果较短，一次性发送
    currentMessage += result;
    chunks.push(currentMessage);
  } else {
    // 结果较长，分段发送
    chunks.push(currentMessage + result.substring(0, MAX_LENGTH - currentMessage.length));

    let remaining = result.substring(MAX_LENGTH - currentMessage.length);
    while (remaining.length > 0) {
      const chunk = remaining.substring(0, MAX_LENGTH);
      chunks.push(chunk);
      remaining = remaining.substring(MAX_LENGTH);
    }
  }

  // 发送所有分段
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prefix = i === 0 ? '' : `（续${i}/${chunks.length - 1}）\n`;
    await sendTextMessage(baseUrl, token, task.userId, prefix + chunk, task.contextToken);

    // 添加小延迟，避免消息顺序错乱
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`[任务处理] 已发送 ${chunks.length} 条消息给用户`);
}

/**
 * 处理任务队列
 * 后台持续处理待处理任务
 */
export async function processTaskQueue() {
  const pendingTasks = getPendingTasks();

  if (pendingTasks.length === 0) {
    console.log('[任务队列] 没有待处理任务');
    return;
  }

  console.log(`[任务队列] 发现 ${pendingTasks.length} 个待处理任务`);

  // 并发处理所有待处理任务（限制并发数）
  const CONCURRENCY = 3;
  const running = [];

  for (const task of pendingTasks) {
    const promise = processTask(task).catch(err => {
      console.error(`[任务队列] 处理任务 ${task.id} 时出错:`, err.message);
    });

    running.push(promise);

    // 限制并发数
    if (running.length >= CONCURRENCY) {
      await Promise.race(running);
      running.splice(running.findIndex(p => p === promise), 1);
    }
  }

  // 等待所有任务完成
  await Promise.all(running);
}

/**
 * 启动后台任务处理器
 * 持续监控并处理任务
 */
export function startTaskProcessor(interval = 5000) {
  console.log('[任务队列] 启动后台任务处理器');

  const process = async () => {
    try {
      await processTaskQueue();
    } catch (err) {
      console.error('[任务队列] 处理出错:', err.message);
    }
  };

  // 立即执行一次
  process();

  // 定时执行
  return setInterval(process, interval);
}
