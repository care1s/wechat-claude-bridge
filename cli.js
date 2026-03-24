#!/usr/bin/env node
/**
 * 微信 CLI 工具
 * 在 Claude Code 中快速操作微信服务
 * @author carels
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API_PORT = process.env.API_PORT || 3456;
const API_BASE = `http://localhost:${API_PORT}`;

const DATA_DIR = join(homedir(), '.weixin-claude-bridge');
const INBOX_FILE = join(DATA_DIR, 'inbox.json');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');

function curl(method, path, body = null) {
  const cmd = body
    ? `curl -s -X ${method} -H "Content-Type: application/json" -d '${JSON.stringify(body)}' ${API_BASE}${path}`
    : `curl -s -X ${method} ${API_BASE}${path}`;
  try {
    return execSync(cmd, { encoding: 'utf-8' });
  } catch (e) {
    console.error('❌ API 请求失败:', e.message);
    console.error('请确保服务已启动: cd ~/weixin-claude-bridge && npm run api');
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
微信 CLI 工具 - 在 Claude Code 中与微信服务交互

用法: node cli.js <命令> [参数]

命令:
  health                    检查服务健康状态
  sessions                  列出所有会话
  inbox                     查看收件箱（收到的消息）
  reply <消息ID> <内容>      回复指定消息
  tasks                     查看任务队列
  complete <任务ID> [结果]   标记任务完成，自动发送微信通知
  watch                     👀 实时监听模式（自动显示新消息和任务）
  history <用户ID>          查看用户消息历史
  logs [数量]               查看最近消息日志 (默认20条)
  send <用户ID> <消息>      发送消息给用户
  reset <用户ID>            重置用户会话

示例:
  node cli.js health
  node cli.js inbox
  node cli.js reply abc123 "你好！"
  node cli.js send "user@im.wechat" "你好！"
`);
}

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  showHelp();
  process.exit(0);
}

switch (cmd) {
  case 'health': {
    const resp = curl('GET', '/health');
    console.log(resp);
    break;
  }

  case 'sessions': {
    const resp = curl('GET', '/sessions');
    const data = JSON.parse(resp);
    if (data.sessions.length === 0) {
      console.log('暂无活跃会话');
    } else {
      console.log(`活跃会话 (${data.sessions.length}个):\n`);
      data.sessions.forEach(s => {
        console.log(`  用户: ${s.userId}`);
        console.log(`  消息数: ${s.messageCount}`);
        console.log(`  最后活跃: ${s.lastActiveText}`);
        console.log();
      });
    }
    break;
  }

  case 'history': {
    const userId = args[0];
    if (!userId) {
      console.error('❌ 请提供用户ID');
      console.error('用法: node cli.js history <用户ID>');
      process.exit(1);
    }
    const resp = curl('GET', `/history?userId=${encodeURIComponent(userId)}`);
    const data = JSON.parse(resp);
    if (data.error) {
      console.error('❌', data.error);
      process.exit(1);
    }
    console.log(`用户 ${data.userId} 的消息历史:\n`);
    if (data.history.length === 0) {
      console.log('  暂无消息');
    } else {
      data.history.forEach((msg, i) => {
        const role = msg.role === 'user' ? '👤 用户' : '🤖 Claude';
        console.log(`${role}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
      });
    }
    break;
  }

  case 'logs': {
    const limit = parseInt(args[0] || '20');
    const resp = curl('GET', `/logs?limit=${limit}`);
    const data = JSON.parse(resp);
    if (data.logs.length === 0) {
      console.log('暂无消息日志');
    } else {
      console.log(`最近 ${data.logs.length} 条消息:\n`);
      data.logs.forEach(log => {
        const dir = log.direction === 'in' ? '⬅️ 收' : '➡️ 发';
        const time = new Date(log.timestamp).toLocaleTimeString();
        console.log(`${time} ${dir} ${log.userId}: ${log.content}`);
      });
    }
    break;
  }

  case 'send': {
    const userId = args[0];
    const message = args.slice(1).join(' ');
    if (!userId || !message) {
      console.error('❌ 请提供用户ID和消息内容');
      console.error('用法: node cli.js send <用户ID> <消息>');
      process.exit(1);
    }
    const resp = curl('POST', '/send', { userId, message });
    const data = JSON.parse(resp);
    if (data.error) {
      console.error('❌ 发送失败:', data.error);
      process.exit(1);
    }
    console.log('✅ 消息已发送');
    console.log(`  用户: ${data.userId}`);
    console.log(`  内容: ${data.message}`);
    break;
  }

  case 'reset': {
    const userId = args[0];
    if (!userId) {
      console.error('❌ 请提供用户ID');
      console.error('用法: node cli.js reset <用户ID>');
      process.exit(1);
    }
    const resp = curl('POST', '/reset', { userId });
    const data = JSON.parse(resp);
    if (data.error) {
      console.error('❌ 重置失败:', data.error);
      process.exit(1);
    }
    console.log('✅', data.message);
    break;
  }

  case 'inbox': {
    if (!existsSync(INBOX_FILE)) {
      console.log('📭 收件箱为空');
      break;
    }
    const inbox = JSON.parse(readFileSync(INBOX_FILE, 'utf-8'));
    const unread = inbox.filter(m => !m.replied);
    if (inbox.length === 0) {
      console.log('📭 收件箱为空');
    } else {
      console.log(`📬 收件箱 (${unread.length} 条未回复 / ${inbox.length} 条总计):\n`);
      inbox.slice(-20).reverse().forEach(m => {
        const status = m.replied ? '✓' : '◯';
        const time = new Date(m.receivedAt).toLocaleTimeString();
        console.log(`${status} [${m.id}] ${time}`);
        console.log(`   来自: ${m.userId}`);
        console.log(`   内容: "${m.text.substring(0, 50)}${m.text.length > 50 ? '...' : ''}"`);
        console.log();
      });
      if (unread.length > 0) {
        console.log('💡 回复: node cli.js reply <消息ID> "你的回复"');
      }
    }
    break;
  }

  case 'reply': {
    const msgId = args[0];
    const replyText = args.slice(1).join(' ');
    if (!msgId || !replyText) {
      console.error('❌ 请提供消息ID和回复内容');
      console.error('用法: node cli.js reply <消息ID> "你的回复"');
      process.exit(1);
    }
    if (!existsSync(INBOX_FILE)) {
      console.error('❌ 收件箱为空');
      process.exit(1);
    }
    const inbox = JSON.parse(readFileSync(INBOX_FILE, 'utf-8'));
    const msg = inbox.find(m => m.id === msgId);
    if (!msg) {
      console.error('❌ 消息ID不存在:', msgId);
      process.exit(1);
    }
    // 发送回复
    const resp = curl('POST', '/send', { userId: msg.userId, message: replyText });
    const data = JSON.parse(resp);
    if (data.error) {
      console.error('❌ 发送失败:', data.error);
      process.exit(1);
    }
    // 标记为已回复
    msg.replied = true;
    writeFileSync(INBOX_FILE, JSON.stringify(inbox, null, 2));
    console.log('✅ 回复已发送');
    console.log(`   用户: ${msg.userId}`);
    console.log(`   内容: "${replyText}"`);
    break;
  }

  case 'tasks': {
    if (!existsSync(TASKS_FILE)) {
      console.log('📭 任务队列为空');
      break;
    }
    const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
    const waiting = tasks.filter(t => t.status === 'waiting');
    if (tasks.length === 0) {
      console.log('📭 任务队列为空');
    } else {
      console.log(`📋 任务队列 (${waiting.length} 个等待处理 / ${tasks.length} 个总计):\n`);
      tasks.slice(-10).reverse().forEach(t => {
        const status = t.status === 'waiting' ? '⏳' : t.status === 'done' ? '✅' : '🔧';
        const time = new Date(t.createdAt).toLocaleTimeString();
        console.log(`${status} [${t.id}] ${time}`);
        console.log(`   用户: ${t.userId}`);
        console.log(`   命令: ${t.text.substring(0, 60)}${t.text.length > 60 ? '...' : ''}`);
        console.log();
      });
      if (waiting.length > 0) {
        console.log('💡 处理完成后运行: node cli.js complete <任务ID> "结果"');
      }
    }
    break;
  }

  case 'complete': {
    const taskId = args[0];
    const result = args.slice(1).join(' ') || '✅ 任务已完成';
    if (!taskId) {
      console.error('❌ 请提供任务ID');
      console.error('用法: node cli.js complete <任务ID> "结果消息"');
      process.exit(1);
    }
    if (!existsSync(TASKS_FILE)) {
      console.error('❌ 任务队列为空');
      process.exit(1);
    }
    const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error('❌ 任务ID不存在:', taskId);
      process.exit(1);
    }
    // 发送结果到微信
    const resp = curl('POST', '/send', { userId: task.userId, message: result });
    const data = JSON.parse(resp);
    if (data.error) {
      console.error('❌ 发送失败:', data.error);
      process.exit(1);
    }
    // 更新任务状态
    task.status = 'done';
    task.result = result;
    task.completedAt = Date.now();
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    console.log('✅ 任务完成，结果已发送到微信');
    console.log(`   任务: ${task.text.substring(0, 50)}`);
    console.log(`   结果: "${result.substring(0, 100)}"`);
    break;
  }

  case 'task-done': {
    const taskId = args[0];
    const result = args.slice(1).join(' ') || '✅ 任务已完成';
    if (!taskId) {
      console.error('❌ 请提供任务ID');
      console.error('用法: node cli.js task-done <任务ID> "结果消息"');
      process.exit(1);
    }
    if (!existsSync(TASKS_FILE)) {
      console.error('❌ 任务队列为空');
      process.exit(1);
    }
    const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error('❌ 任务ID不存在:', taskId);
      process.exit(1);
    }
    // 发送结果到微信
    const resp = curl('POST', '/send', { userId: task.userId, message: result });
    const data = JSON.parse(resp);
    if (data.error) {
      console.error('❌ 发送失败:', data.error);
      process.exit(1);
    }
    // 更新任务状态
    task.status = 'done';
    task.result = result;
    task.completedAt = Date.now();
    writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    console.log('✅ 任务完成，结果已发送到微信');
    console.log(`   任务: ${task.text.substring(0, 50)}`);
    console.log(`   结果: "${result.substring(0, 100)}"`);
    break;
  }

  case 'watch': {
    console.log('👀 启动实时监听模式，按 Ctrl+C 退出\n');
    let lastInboxLength = 0;
    let lastTasksLength = 0;

    const check = () => {
      // 检查收件箱
      if (existsSync(INBOX_FILE)) {
        const inbox = JSON.parse(readFileSync(INBOX_FILE, 'utf-8'));
        const unread = inbox.filter(m => !m.replied);
        if (inbox.length > lastInboxLength) {
          const newMsgs = inbox.slice(lastInboxLength);
          newMsgs.forEach(m => {
            console.log(`\n📩 新消息 [${m.id}]`);
            console.log(`   来自: ${m.userId}`);
            console.log(`   内容: "${m.text.substring(0, 100)}${m.text.length > 100 ? '...' : ''}"`);
            console.log(`   回复: node cli.js reply ${m.id} "你的回复"`);
          });
          lastInboxLength = inbox.length;
        }
      }

      // 检查任务
      if (existsSync(TASKS_FILE)) {
        const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
        if (tasks.length > lastTasksLength) {
          const newTasks = tasks.slice(lastTasksLength);
          newTasks.forEach(t => {
            console.log(`\n📋 新任务 [${t.id}]`);
            console.log(`   用户: ${t.userId}`);
            console.log(`   内容: "${t.text.substring(0, 100)}${t.text.length > 100 ? '...' : ''}"`);
            console.log(`   完成: node cli.js complete ${t.id} "结果"`);
          });
          lastTasksLength = tasks.length;
        }
      }
    };

    // 立即检查一次
    check();

    // 每秒检查一次
    setInterval(check, 1000);

    // 保持进程运行
    setInterval(() => {}, 1000);
    break;
  }

  default:
    console.error(`❌ 未知命令: ${cmd}`);
    showHelp();
    process.exit(1);
}
