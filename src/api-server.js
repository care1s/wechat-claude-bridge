/**
 * HTTP API 服务器
 * 为 Claude Code CLI 提供接口与微信服务交互
 * @author carels
 */
import http from 'node:http';
import { config, loadSavedToken } from './config.js';
import { sessionStore } from './session-store.js';
import { sendTextMessage, getConfig } from './weixin-api.js';
import { setMessageLogger } from './message-handler.js';

const PORT = process.env.API_PORT || 3456;

// 确保已登录
const hasToken = loadSavedToken();
if (!hasToken || !config.weixinBotToken) {
  console.error('❌ 未找到登录凭据，请先运行: npm run login');
  process.exit(1);
}

// 简单的日志存储（用于轮询最新消息）
const messageLogs = [];
const MAX_LOGS = 1000;

export function logMessage(direction, userId, content) {
  messageLogs.unshift({
    id: Date.now().toString(36),
    direction, // 'in' | 'out'
    userId,
    content: content?.substring(0, 200),
    timestamp: Date.now(),
  });
  if (messageLogs.length > MAX_LOGS) {
    messageLogs.pop();
  }
}

// 注册日志回调
setMessageLogger(logMessage);

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 解析请求体
  const parseBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });

  try {
    // GET /health - 健康检查
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        weixin: config.weixinAccountId ? 'connected' : 'not_configured',
        sessions: sessionStore.getStats(),
      }));
      return;
    }

    // GET /sessions - 获取会话列表
    if (pathname === '/sessions' && req.method === 'GET') {
      const sessions = [];
      for (const [key, session] of sessionStore.sessions) {
        const [accountId, userId] = key.split(':');
        sessions.push({
          userId,
          accountId,
          messageCount: session.messages.length,
          lastActive: session.lastActive,
          lastActiveText: new Date(session.lastActive).toLocaleString(),
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // GET /history?userId=xxx - 获取消息历史
    if (pathname === '/history' && req.method === 'GET') {
      const userId = url.searchParams.get('userId');
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 userId 参数' }));
        return;
      }

      const history = sessionStore.getHistory(config.weixinAccountId, userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userId, history }));
      return;
    }

    // GET /logs - 获取最近消息日志
    if (pathname === '/logs' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        logs: messageLogs.slice(0, limit),
      }));
      return;
    }

    // POST /send - 发送消息
    if (pathname === '/send' && req.method === 'POST') {
      const body = await parseBody();
      const { userId, message } = body;

      if (!userId || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 userId 或 message 参数' }));
        return;
      }

      try {
        // 获取或刷新 context_token
        let contextToken = sessionStore.getContextToken(config.weixinAccountId, userId);
        try {
          const cfg = await getConfig(config.weixinBaseUrl, config.weixinBotToken, userId, contextToken || '');
          if (cfg.context_token) {
            contextToken = cfg.context_token;
            sessionStore.setContextToken(config.weixinAccountId, userId, contextToken);
          }
        } catch (e) {
          console.log('刷新 token 失败:', e.message);
        }

        // 发送消息
        const result = await sendTextMessage(
          config.weixinBaseUrl,
          config.weixinBotToken,
          userId,
          message,
          contextToken || ''
        );

        logMessage('out', userId, message);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          userId,
          message,
          timestamp: Date.now(),
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /reset - 重置会话
    if (pathname === '/reset' && req.method === 'POST') {
      const body = await parseBody();
      const { userId } = body;

      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 userId 参数' }));
        return;
      }

      sessionStore.clearSession(config.weixinAccountId, userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `已重置用户 ${userId} 的会话` }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '接口不存在' }));

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     微信-Claude HTTP API 服务          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n服务已启动: http://localhost:${PORT}`);
  console.log('\n可用接口:');
  console.log(`  GET  http://localhost:${PORT}/health         - 健康检查`);
  console.log(`  GET  http://localhost:${PORT}/sessions       - 会话列表`);
  console.log(`  GET  http://localhost:${PORT}/history?userId=xxx - 消息历史`);
  console.log(`  GET  http://localhost:${PORT}/logs?limit=20  - 最近消息日志`);
  console.log(`  POST http://localhost:${PORT}/send           - 发送消息`);
  console.log(`  POST http://localhost:${PORT}/reset          - 重置会话`);
  console.log('\n按 Ctrl+C 停止服务\n');
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n👋 正在关闭 API 服务...');
  server.close(() => {
    process.exit(0);
  });
});
