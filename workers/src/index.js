/**
 * TGBot RSS - Cloudflare Workers Version
 * 支持 RSS 订阅推送 + 邮件推送功能
 * 
 * 环境变量 (在 Cloudflare Dashboard 绑定):
 * - BOT_TOKEN: Telegram Bot API Token
 * - ADMIN_ID: 管理员 Telegram User ID
 * 
 * KV 绑定:
 * - KV: Cloudflare KV Namespace
 */

import { TelegramBot } from './telegram.js';
import { RSSChecker } from './rss.js';
import { handleCommand, handleCallback, handleMessage } from './handlers.js';

export default {
  // Webhook 处理 Telegram 消息
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 设置 Webhook 的路由
    if (url.pathname === '/setup') {
      return await setupWebhook(env);
    }

    // 处理 Telegram Webhook 更新
    if (url.pathname === `/webhook/${env.BOT_TOKEN}`) {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      try {
        const update = await request.json();
        ctx.waitUntil(processUpdate(update, env));
        return new Response('OK');
      } catch (e) {
        console.error('处理更新失败:', e);
        return new Response('Error', { status: 500 });
      }
    }

    // 手动触发 RSS 检查
    if (url.pathname === '/check') {
      ctx.waitUntil(checkRSS(env));
      return new Response('RSS check triggered');
    }

    return new Response('TGBot RSS Worker is running!', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  // 定时触发器 - 定期检查 RSS
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkRSS(env));
  }
};

// 设置 Telegram Webhook
async function setupWebhook(env) {
  const bot = new TelegramBot(env.BOT_TOKEN);
  // 需要替换为你的 Worker URL
  const workerUrl = `https://tgbot-rss.${env.CF_ACCOUNT_SUBDOMAIN || 'your-subdomain'}.workers.dev`;
  const webhookUrl = `${workerUrl}/webhook/${env.BOT_TOKEN}`;

  const result = await bot.setWebhook(webhookUrl);
  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 处理 Telegram 更新
async function processUpdate(update, env) {
  const bot = new TelegramBot(env.BOT_TOKEN);
  const adminId = parseInt(env.ADMIN_ID) || 0;

  try {
    if (update.message) {
      const message = update.message;
      const userId = message.from.id;

      // 权限检查
      if (adminId !== 0 && userId !== adminId) {
        await bot.sendMessage(userId, '你没有权限使用此命令');
        return;
      }

      if (message.text && message.text.startsWith('/')) {
        await handleCommand(bot, message, env);
      } else {
        await handleMessage(bot, message, env);
      }
    } else if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const userId = callbackQuery.from.id;

      // 权限检查
      if (adminId !== 0 && userId !== adminId) {
        await bot.answerCallbackQuery(callbackQuery.id, '你没有权限');
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id);
      await handleCallback(bot, callbackQuery, env);
    }
  } catch (e) {
    console.error('处理消息失败:', e);
  }
}

// 检查 RSS 更新
async function checkRSS(env) {
  const bot = new TelegramBot(env.BOT_TOKEN);
  const checker = new RSSChecker(env.KV, bot);
  await checker.checkAll(env);
}
