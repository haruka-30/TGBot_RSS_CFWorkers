/**
 * TGBot RSS - Cloudflare Workers 单文件版本
 * 支持直接上传到 Cloudflare 仪表板部署
 *
 * 必需环境变量 (在 Cloudflare Dashboard 绑定):
 * - BOT_TOKEN: Telegram Bot API Token
 * - ADMIN_ID: 管理员 Telegram User ID (设置为 0 表示所有人可用)
 *
 * 必需 KV 绑定:
 * - KV: Cloudflare KV Namespace
 *
 * 部署后访问 https://your-worker-url/setup 注册 Webhook
 */

// ====================================================================
// Telegram Bot API
// ====================================================================
class TelegramBot {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async request(method, params = {}) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    const result = await response.json();
    if (!result.ok) {
      console.error(`Telegram API error [${method}]:`, result.description);
    }
    return result;
  }

  setWebhook(url) {
    return this.request('setWebhook', { url });
  }

  sendMessage(chatId, text, options = {}) {
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || undefined,
      disable_web_page_preview: options.disablePreview || false,
      reply_markup: options.replyMarkup || undefined
    });
  }

  sendHTML(chatId, text, options = {}) {
    return this.sendMessage(chatId, text, { ...options, parseMode: 'HTML' });
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.request('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parseMode || undefined,
      disable_web_page_preview: options.disablePreview || false,
      reply_markup: options.replyMarkup || undefined
    });
  }

  editHTML(chatId, messageId, text, options = {}) {
    return this.editMessageText(chatId, messageId, text, { ...options, parseMode: 'HTML' });
  }

  sendPhoto(chatId, photoUrl, caption, options = {}) {
    return this.request('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: options.parseMode || 'HTML',
      reply_markup: options.replyMarkup || undefined
    });
  }

  answerCallbackQuery(callbackQueryId, text = '') {
    return this.request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    });
  }
}

// ====================================================================
// KV 存储层 (替代 SQLite)
// ====================================================================
class Storage {
  constructor(kv) {
    this.kv = kv;
  }

  // 订阅管理
  async getSubscriptions() {
    return (await this.kv.get('subscriptions', 'json')) || [];
  }

  async saveSubscriptions(subs) {
    await this.kv.put('subscriptions', JSON.stringify(subs));
  }

  async addSubscription(url, name, channel, userId) {
    const subs = await this.getSubscriptions();
    const existing = subs.find(s => s.url === url || s.name === name);
    if (existing) {
      if (existing.users.includes(userId)) throw new Error('你已经订阅了这个RSS源');
      existing.users.push(userId);
    } else {
      subs.push({ url, name, users: [userId], channel: parseInt(channel) || 0 });
    }
    await this.saveSubscriptions(subs);
    if (!(await this.getFeedData(name))) {
      await this.saveFeedData(name, { lastUpdateTime: new Date().toISOString(), latestTitle: '' });
    }
  }

  async removeSubscription(name, userId) {
    const subs = await this.getSubscriptions();
    const index = subs.findIndex(s => s.name === name);
    if (index === -1) throw new Error('订阅不存在');
    const sub = subs[index];
    sub.users = sub.users.filter(id => id !== userId);
    if (sub.users.length === 0) {
      subs.splice(index, 1);
      await this.kv.delete(`feed_data:${name}`);
    }
    await this.saveSubscriptions(subs);
  }

  async getSubscriptionsForUser(userId) {
    return (await this.getSubscriptions()).filter(s => s.users.includes(userId));
  }

  // 关键词管理
  async getKeywords(userId) {
    return (await this.kv.get(`user_keywords:${userId}`, 'json')) || [];
  }

  async saveKeywords(userId, keywords) {
    await this.kv.put(`user_keywords:${userId}`, JSON.stringify(keywords));
  }

  async addKeywords(userId, newKeywords) {
    const existing = await this.getKeywords(userId);
    const set = new Set(existing);
    let added = 0;
    for (const kw of newKeywords) {
      const t = kw.trim();
      if (t && !set.has(t)) { set.add(t); added++; }
    }
    if (added === 0) return { addedCount: 0, total: existing.length, keywords: existing };
    const final = [...set].sort();
    await this.saveKeywords(userId, final);
    return { addedCount: added, total: final.length, keywords: final };
  }

  async removeKeyword(userId, keyword) {
    const keywords = await this.getKeywords(userId);
    const next = keywords.filter(k => k !== keyword);
    if (next.length === keywords.length) throw new Error(`关键词 "${keyword}" 不存在`);
    await this.saveKeywords(userId, next);
    return next;
  }

  // Feed 数据
  getFeedData(rssName) {
    return this.kv.get(`feed_data:${rssName}`, 'json');
  }

  saveFeedData(rssName, data) {
    return this.kv.put(`feed_data:${rssName}`, JSON.stringify(data));
  }

  // 用户状态 (5分钟过期)
  getUserState(userId) {
    return this.kv.get(`user_state:${userId}`, 'json');
  }

  setUserState(userId, state) {
    return this.kv.put(`user_state:${userId}`, JSON.stringify(state), { expirationTtl: 300 });
  }

  clearUserState(userId) {
    return this.kv.delete(`user_state:${userId}`);
  }

  // 邮件配置
  getSmtpConfig() {
    return this.kv.get('smtp_config', 'json');
  }

  saveSmtpConfig(config) {
    return this.kv.put('smtp_config', JSON.stringify(config));
  }

  async getEmailRecipients() {
    return (await this.kv.get('email_recipients', 'json')) || [];
  }

  saveEmailRecipients(recipients) {
    return this.kv.put('email_recipients', JSON.stringify(recipients));
  }

  async addEmailRecipient(email) {
    const recipients = await this.getEmailRecipients();
    if (recipients.includes(email)) throw new Error('该邮箱已存在');
    recipients.push(email);
    await this.saveEmailRecipients(recipients);
  }

  async removeEmailRecipient(email) {
    const recipients = await this.getEmailRecipients();
    const next = recipients.filter(r => r !== email);
    if (next.length === recipients.length) throw new Error('该邮箱不存在');
    await this.saveEmailRecipients(next);
    return next;
  }

  async getAllUserKeywords() {
    const subs = await this.getSubscriptions();
    const userIds = new Set();
    for (const sub of subs) for (const uid of sub.users) userIds.add(uid);

    const result = {};
    for (const uid of userIds) {
      const kws = await this.getKeywords(uid);
      if (kws.length > 0) result[uid] = kws;
    }
    return result;
  }
}

// ====================================================================
// 邮件推送
// ====================================================================
class EmailSender {
  constructor(storage) { this.storage = storage; }

  async sendEmail(subject, htmlContent, textContent) {
    const config = await this.storage.getSmtpConfig();
    if (!config || !config.enabled) return { success: false, error: '邮件推送未配置或未启用' };

    const recipients = await this.storage.getEmailRecipients();
    if (recipients.length === 0) return { success: false, error: '没有邮件接收人' };

    try {
      if (config.mode === 'mailchannels') return await this.sendViaMailChannels(config, recipients, subject, htmlContent, textContent);
      if (config.mode === 'resend') return await this.sendViaResend(config, recipients, subject, htmlContent);
      if (config.mode === 'sendgrid') return await this.sendViaSendGrid(config, recipients, subject, htmlContent, textContent);
      if (config.mode === 'custom') return await this.sendViaCustomAPI(config, recipients, subject, htmlContent, textContent);
      return { success: false, error: '未知的邮件发送模式' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async sendViaMailChannels(config, recipients, subject, htmlContent, textContent) {
    const payload = {
      personalizations: [{ to: recipients.map(email => ({ email })) }],
      from: { email: config.fromEmail, name: config.fromName || 'TGBot RSS' },
      subject,
      content: [
        { type: 'text/plain', value: textContent },
        { type: 'text/html', value: htmlContent }
      ]
    };
    const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.status === 202 || r.status === 200) return { success: true };
    return { success: false, error: `MailChannels: ${r.status} - ${await r.text()}` };
  }

  async sendViaResend(config, recipients, subject, htmlContent) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${config.fromName || 'TGBot RSS'} <${config.fromEmail}>`,
        to: recipients,
        subject,
        html: htmlContent
      })
    });
    const data = await r.json();
    if (r.ok) return { success: true };
    return { success: false, error: data.message || JSON.stringify(data) };
  }

  async sendViaSendGrid(config, recipients, subject, htmlContent, textContent) {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: recipients.map(email => ({ email })) }],
        from: { email: config.fromEmail, name: config.fromName || 'TGBot RSS' },
        subject,
        content: [
          { type: 'text/plain', value: textContent },
          { type: 'text/html', value: htmlContent }
        ]
      })
    });
    if (r.status === 202 || r.status === 200) return { success: true };
    return { success: false, error: `SendGrid: ${r.status} - ${await r.text()}` };
  }

  async sendViaCustomAPI(config, recipients, subject, htmlContent, textContent) {
    const headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {})
    };
    const r = await fetch(config.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: config.fromEmail,
        fromName: config.fromName || 'TGBot RSS',
        to: recipients,
        subject,
        html: htmlContent,
        text: textContent
      })
    });
    if (r.ok) return { success: true };
    return { success: false, error: `API: ${r.status} - ${await r.text()}` };
  }

  testEmail() {
    return this.sendEmail(
      '🧪 TGBot RSS 邮件推送测试',
      '<h2>✅ 邮件推送配置成功！</h2><p>这是一封测试邮件。</p>',
      '✅ 邮件推送配置成功！'
    );
  }

  sendRSSUpdate(rssName, messages, matchedKeywords) {
    if (messages.length === 0) return;
    const subject = `📰 RSS 更新: ${rssName}`;
    let html = `<h2>📰 ${rssName} 有新内容</h2><p>匹配关键词: ${matchedKeywords.join(', ')}</p><hr>`;
    let text = `📰 ${rssName}\n匹配关键词: ${matchedKeywords.join(', ')}\n\n`;
    for (const msg of messages) {
      html += `<div style="margin-bottom:20px;padding:10px;border-left:3px solid #0088cc;">
        <h3><a href="${msg.link}">${msg.title}</a></h3>
        <p style="color:#666;font-size:12px;">🕒 ${msg.pubDate}</p>
        <p>${msg.description || ''}</p></div>`;
      text += `📌 ${msg.title}\n🕒 ${msg.pubDate}\n🔗 ${msg.link}\n\n`;
    }
    return this.sendEmail(subject, html, text);
  }
}

// ====================================================================
// RSS 解析与检查
// ====================================================================

/**
 * 备用 User-Agent 列表 (按优先级排序)
 * 部分站点 (如 NodeSeek / 奶昔论坛 / IDCFlare / NodeLoc) 对非浏览器 UA 直接返回 403,
 * 因此优先使用真实浏览器 UA, 失败后回退到主流 RSS 阅读器 UA.
 */
const FETCH_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (compatible; Feedly/1.0; +http://www.feedly.com/fetcher.html)',
  'Mozilla/5.0 (compatible; Inoreader/1.0; +https://www.inoreader.com)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
];

/**
 * 通用 RSS 抓取, 带浏览器请求头与多 UA 回退,
 * 用于绕过部分论坛/Cloudflare 站点对非浏览器请求的 403 拦截.
 */
async function fetchFeed(url) {
  let lastStatus = 0;
  let lastError = '';
  let referer = '';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.host}/`;
  } catch (_) { /* ignore */ }

  for (const ua of FETCH_USER_AGENTS) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.8, text/xml;q=0.8, text/html;q=0.7, */*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          ...(referer ? { 'Referer': referer } : {})
        },
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      lastStatus = response.status;
      if (response.ok) {
        return { ok: true, status: response.status, text: await response.text() };
      }
      // 仅对反爬常见状态码继续重试
      if (![403, 401, 429, 451, 503, 520, 521, 522, 523].includes(response.status)) {
        return { ok: false, status: response.status, text: '', error: `HTTP ${response.status}` };
      }
      lastError = `HTTP ${response.status}`;
    } catch (e) {
      lastError = e.message || String(e);
    }
  }
  return { ok: false, status: lastStatus, text: '', error: lastError || '请求失败' };
}

class RSSChecker {
  constructor(kv, bot) {
    this.storage = new Storage(kv);
    this.bot = bot;
    this.emailSender = new EmailSender(this.storage);
  }

  async checkAll() {
    const subs = await this.storage.getSubscriptions();
    if (subs.length === 0) return;
    const userKeywords = await this.storage.getAllUserKeywords();
    const batch = 5;
    for (let i = 0; i < subs.length; i += batch) {
      await Promise.allSettled(subs.slice(i, i + batch).map(sub => this.processSubscription(sub, userKeywords)));
    }
  }

  async processSubscription(sub, userKeywords) {
    try {
      const messages = await this.fetchRSS(sub);
      if (!messages || messages.length === 0) return;
      for (const msg of messages) {
        for (const userId of sub.users) {
          const keywords = userKeywords[userId];
          if (!keywords || keywords.length === 0) continue;
          const matched = this.matchKeywords(msg, keywords, sub.name);
          if (matched.length > 0) await this.pushMessage(userId, sub, msg, matched);
        }
      }
    } catch (e) {
      console.error(`处理订阅 ${sub.name} 失败:`, e.message);
    }
  }

  async fetchRSS(sub) {
    const result = await fetchFeed(sub.url);
    if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`);
    const text = result.text;
    const items = this.parseRSS(text);
    if (items.length === 0) return null;

    const feedData = await this.storage.getFeedData(sub.name);
    const lastTime = feedData ? new Date(feedData.lastUpdateTime) : new Date(0);
    const newItems = [];
    let latestTime = lastTime;

    for (const item of items) {
      const pubDate = new Date(item.pubDate);
      if (pubDate > latestTime) latestTime = pubDate;
      if (pubDate > lastTime) newItems.push(item);
    }
    if (latestTime > lastTime) {
      await this.storage.saveFeedData(sub.name, {
        lastUpdateTime: latestTime.toISOString(),
        latestTitle: items[0]?.title || ''
      });
    }
    return newItems;
  }

  parseRSS(xml) {
    const items = [];
    const rssItems = this.extractTags(xml, 'item');
    if (rssItems.length > 0) {
      for (const x of rssItems) {
        items.push({
          title: this.tagContent(x, 'title'),
          description: this.tagContent(x, 'description') || this.tagContent(x, 'content:encoded'),
          link: this.tagContent(x, 'link') || this.attr(x, 'link', 'href'),
          pubDate: this.tagContent(x, 'pubDate') || this.tagContent(x, 'dc:date') || new Date().toISOString()
        });
      }
      return items;
    }
    const entries = this.extractTags(xml, 'entry');
    for (const x of entries) {
      items.push({
        title: this.tagContent(x, 'title'),
        description: this.tagContent(x, 'summary') || this.tagContent(x, 'content'),
        link: this.attr(x, 'link', 'href') || this.tagContent(x, 'link'),
        pubDate: this.tagContent(x, 'published') || this.tagContent(x, 'updated') || new Date().toISOString()
      });
    }
    return items;
  }

  extractTags(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[0]);
    return out;
  }

  tagContent(xml, tag) {
    const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
    let m = cdata.exec(xml);
    if (m) return m[1].trim();
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    m = re.exec(xml);
    return m ? m[1].trim() : '';
  }

  attr(xml, tag, name) {
    const re = new RegExp(`<${tag}[^>]*${name}=["']([^"']+)["']`, 'i');
    const m = re.exec(xml);
    return m ? m[1] : '';
  }

  matchKeywords(msg, keywords, rssName) {
    const title = (msg.title || '').toLowerCase();
    const desc = (msg.description || '').toLowerCase();
    const all = title + ' ' + desc;
    const matched = [];
    const blocked = [];

    for (let kw of keywords) {
      kw = kw.trim();
      if (!kw) continue;
      const isBlock = kw.startsWith('-');
      if (isBlock) kw = kw.substring(1);

      let target = title;
      if (kw.startsWith('#t')) { target = title; kw = kw.substring(2); }
      else if (kw.startsWith('#c')) { target = desc; kw = kw.substring(2); }
      else if (kw.startsWith('#a')) { target = all; kw = kw.substring(2); }
      kw = kw.trim();

      let actual = kw;
      if (kw.includes('+')) {
        const parts = kw.split('+');
        if (parts.length === 2) {
          actual = parts[0].trim();
          if (parts[1].trim().toLowerCase() !== rssName.toLowerCase()) continue;
        }
      }

      const lower = actual.toLowerCase();
      let hit = false;
      if (lower.includes('*')) {
        try {
          hit = new RegExp(lower.replace(/\*/g, '.*')).test(target);
        } catch {
          hit = target.includes(lower.replace(/\*/g, ''));
        }
      } else {
        hit = target.includes(lower);
      }

      if (hit) {
        if (isBlock) blocked.push(actual);
        else matched.push(actual);
      }
    }
    return blocked.length > 0 ? [] : matched;
  }

  async pushMessage(userId, sub, msg, matchedKeywords) {
    const date = new Date(msg.pubDate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const tags = matchedKeywords.map(k => `<code>${k}</code>`).join(' ');

    if (sub.channel === 1) {
      const img = this.extractImageURL(msg.description || '');
      const clean = this.cleanHTML(msg.description || '');
      const html = `👋 ${sub.name}: ${tags}\n🕒 ${date}\n${clean}`;
      try {
        if (img) await this.bot.sendPhoto(userId, img, html);
        else await this.bot.sendHTML(userId, html);
      } catch {
        await this.bot.sendHTML(userId, html);
      }
    } else {
      const html = `📌 ${this.escapeHTML(msg.title)}\n🔖 关键词: ${tags}\n🕒 ${date}\n🔗 ${msg.link}`;
      await this.bot.sendHTML(userId, html);
    }

    try { await this.emailSender.sendRSSUpdate(sub.name, [msg], matchedKeywords); }
    catch (e) { console.error('邮件推送失败:', e.message); }
  }

  extractImageURL(html) {
    const m1 = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m1) return m1[1];
    const m2 = html.match(/https?:\/\/[^\s"']+\.(jpg|jpeg|png|gif|webp)/i);
    return m2 ? m2[0] : '';
  }

  cleanHTML(html) {
    if (!html) return '';
    html = html.replace(/<img[^>]*>/gi, '');
    html = html.replace(/<br\s*\/?>/gi, '\n');
    html = html.replace(/<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '<a href="$1">$2</a>');
    html = html.replace(/<(?!\/?(?:b|i|u|s|code|pre|a)\b)[^>]+>/gi, '');
    html = html.replace(/\n{3,}/g, '\n\n');
    if (html.length > 3000) html = html.substring(0, 3000) + '...';
    return html.trim();
  }

  escapeHTML(t) {
    return (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

// ====================================================================
// UI 键盘
// ====================================================================
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📝 添加关键词', callback_data: 'add_keyword' }, { text: '📋 查看关键词', callback_data: 'view_keywords' }],
      [{ text: '🗑️ 删除关键词', callback_data: 'delete_keyword' }],
      [{ text: '➕ 添加订阅', callback_data: 'add_subscription' }, { text: '📰 查看订阅', callback_data: 'view_subscriptions' }],
      [{ text: '🗑️ 删除订阅', callback_data: 'delete_subscription' }, { text: '📧 邮件推送', callback_data: 'email_menu' }],
      [{ text: 'ℹ️ 关于/帮助', callback_data: 'help' }]
    ]
  };
}

function backButton() {
  return { inline_keyboard: [[{ text: '🔙 返回主菜单', callback_data: 'back_to_menu' }]] };
}

function deleteKeyboard(items, prefix) {
  const rows = [];
  for (let i = 0; i < items.length; i += 3) {
    rows.push(items.slice(i, i + 3).map(item => ({ text: `❌ ${item}`, callback_data: `${prefix}_${item}` })));
  }
  rows.push([{ text: '🔙 返回主菜单', callback_data: 'back_to_menu' }]);
  return { inline_keyboard: rows };
}

async function editMessage(bot, userId, messageId, text, replyMarkup) {
  if (messageId) await bot.editMessageText(userId, messageId, text, { replyMarkup });
  else await bot.sendMessage(userId, text, { replyMarkup });
}

// ====================================================================
// 命令处理
// ====================================================================
async function handleCommand(bot, message, env) {
  const userId = message.from.id;
  const command = message.text.split('@')[0].substring(1).split(' ')[0];
  const storage = new Storage(env.KV);

  switch (command) {
    case 'start':
      await storage.clearUserState(userId);
      await showMainMenu(bot, userId, message.from.first_name, 0);
      break;
    case 'help':
      await showHelp(bot, userId, 0);
      break;
    default:
      await bot.sendMessage(userId, `未知命令: ${command}\n请使用 /start 查看菜单或 /help 获取帮助`);
  }
}

// ====================================================================
// 回调处理
// ====================================================================
async function handleCallback(bot, callbackQuery, env) {
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;
  const from = callbackQuery.from.first_name || '';
  const storage = new Storage(env.KV);

  const inputActions = ['add_keyword', 'add_subscription', 'set_email_mode',
    'set_smtp_from', 'set_api_key', 'set_api_url', 'set_from_name', 'add_email'];
  if (!inputActions.includes(data)) {
    await storage.clearUserState(userId);
  }

  switch (data) {
    case 'back_to_menu':
      await showMainMenu(bot, userId, from, messageId); break;

    case 'add_keyword':
      await storage.setUserState(userId, { action: 'add_keyword', messageId });
      await editMessage(bot, userId, messageId,
        '请输入要添加的关键词，多个关键词可用逗号或空格分隔：\n\n' +
        '💡 技巧：\n• * 可匹配任意字符\n• -关键词 表示屏蔽\n• #t关键词 只匹配标题\n' +
        '• #c关键词 只匹配描述\n• #a关键词 匹配标题和描述\n• 关键词+RSS名称 指定RSS源\n• 全推送可用 * 号',
        backButton());
      break;

    case 'view_keywords': await viewKeywords(bot, storage, userId, messageId); break;
    case 'delete_keyword': await showDeleteKeywords(bot, storage, userId, messageId); break;

    case 'add_subscription':
      await storage.setUserState(userId, { action: 'add_subscription', messageId });
      await editMessage(bot, userId, messageId,
        '✏️ 添加新订阅：\n\n请按以下格式输入：\nURL 名称 频道模式(0或1)\n\n' +
        '📝 示例：\n常规订阅：https://example.com/feed 科技新闻 0\n频道订阅：https://example.com/feed TG资讯 1',
        backButton());
      break;

    case 'view_subscriptions': await viewSubscriptions(bot, storage, userId, messageId); break;
    case 'delete_subscription': await showDeleteSubscriptions(bot, storage, userId, messageId); break;

    case 'email_menu': await showEmailMenu(bot, storage, userId, messageId); break;
    case 'email_config': await showEmailConfig(bot, storage, userId, messageId); break;

    case 'set_email_mode':
      await storage.setUserState(userId, { action: 'set_email_mode', messageId });
      await editMessage(bot, userId, messageId,
        '📧 选择邮件发送模式：\n\n1️⃣ mailchannels - Cloudflare 免费邮件 (需域名DNS)\n' +
        '2️⃣ resend - Resend API (推荐)\n3️⃣ sendgrid - SendGrid API\n4️⃣ custom - 自定义 API\n\n' +
        '请输入模式名称 (如: resend):',
        backButton());
      break;

    case 'set_smtp_from':
      await storage.setUserState(userId, { action: 'set_smtp_from', messageId });
      await editMessage(bot, userId, messageId, '📧 请输入发件人邮箱地址：\n\n例如: noreply@yourdomain.com', backButton());
      break;

    case 'set_from_name':
      await storage.setUserState(userId, { action: 'set_from_name', messageId });
      await editMessage(bot, userId, messageId, '✏️ 请输入发件人名称：\n\n例如: TGBot RSS', backButton());
      break;

    case 'set_api_key':
      await storage.setUserState(userId, { action: 'set_api_key', messageId });
      await editMessage(bot, userId, messageId, '🔑 请输入 API Key (Resend/SendGrid)：', backButton());
      break;

    case 'set_api_url':
      await storage.setUserState(userId, { action: 'set_api_url', messageId });
      await editMessage(bot, userId, messageId, '🔗 请输入自定义 API URL (仅 custom 模式)：', backButton());
      break;

    case 'email_enable': await toggleEmail(bot, storage, userId, messageId, true); break;
    case 'email_disable': await toggleEmail(bot, storage, userId, messageId, false); break;
    case 'email_test': await testEmail(bot, storage, userId, messageId); break;
    case 'email_recipients': await showEmailRecipients(bot, storage, userId, messageId); break;

    case 'add_email':
      await storage.setUserState(userId, { action: 'add_email', messageId });
      await editMessage(bot, userId, messageId, '📬 请输入要添加的收件人邮箱：\n\n例如: user@example.com', backButton());
      break;

    case 'help': await showHelp(bot, userId, messageId); break;

    default:
      if (data.startsWith('del_kw_')) await deleteKeyword(bot, storage, userId, messageId, data.substring(7));
      else if (data.startsWith('del_sub_')) await deleteSubscription(bot, storage, userId, messageId, data.substring(8));
      else if (data.startsWith('del_email_')) await deleteEmailRecipient(bot, storage, userId, messageId, data.substring(10));
  }
}

// ====================================================================
// 用户输入处理
// ====================================================================
async function handleMessage(bot, message, env) {
  const userId = message.from.id;
  const text = (message.text || '').trim();
  if (!text) return;

  const storage = new Storage(env.KV);
  const state = await storage.getUserState(userId);
  if (!state) {
    await bot.sendMessage(userId, '请使用 /start 查看功能菜单');
    return;
  }

  switch (state.action) {
    case 'add_keyword': {
      const keywords = text.replace(/，/g, ',').split(/[,\s]+/).filter(k => k.trim());
      if (keywords.length === 0) { await bot.sendMessage(userId, '❌ 请输入有效的关键词'); return; }
      const result = await storage.addKeywords(userId, keywords);
      await storage.clearUserState(userId);
      const list = result.keywords.map((kw, i) => `${i + 1}.${kw}`).join('  ');
      await bot.sendMessage(userId,
        `✅ 成功添加 ${result.addedCount} 个关键词\n当前共有 ${result.total} 个关键词\n\n📋 关键词列表：\n${list}`,
        { replyMarkup: backButton() });
      break;
    }

    case 'add_subscription': {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await bot.sendMessage(userId, '❌ 格式错误！请按格式输入：\nURL 名称 频道模式(0或1)\n例如：https://example.com/feed 科技新闻 0');
        return;
      }
      const [url, name, channel] = [parts[0], parts[1], parts[2]];
      try {
        const u = new URL(url);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
      } catch {
        await bot.sendMessage(userId, '❌ 无效的URL格式，请使用http或https开头的完整URL');
        return;
      }
      try {
        const r = await fetchFeed(url);
        if (!r.ok) { await bot.sendMessage(userId, `❌ RSS源请求失败: ${r.error || ('HTTP ' + r.status)}`); return; }
        const c = r.text;
        if (!c.includes('<rss') && !c.includes('<feed') && !c.includes('<?xml') && !c.includes('<channel')) {
          await bot.sendMessage(userId, '❌ 未检测到有效的RSS/Atom格式'); return;
        }
      } catch (e) {
        await bot.sendMessage(userId, `❌ RSS源验证失败: ${e.message}`); return;
      }
      try {
        await storage.addSubscription(url, name, channel, userId);
        await storage.clearUserState(userId);
        await bot.sendMessage(userId, `✅ 成功添加订阅：\n📰 ${name}\n🔗 ${url}`, { replyMarkup: backButton() });
      } catch (e) {
        await bot.sendMessage(userId, `❌ ${e.message}`);
      }
      break;
    }

    case 'set_email_mode': {
      const valid = ['mailchannels', 'resend', 'sendgrid', 'custom'];
      const mode = text.toLowerCase();
      if (!valid.includes(mode)) { await bot.sendMessage(userId, `❌ 无效模式，请输入: ${valid.join(', ')}`); return; }
      const config = (await storage.getSmtpConfig()) || {};
      config.mode = mode;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ 邮件模式已设置为: ${mode}`, { replyMarkup: backButton() });
      break;
    }

    case 'set_smtp_from': {
      if (!text.includes('@')) { await bot.sendMessage(userId, '❌ 请输入有效的邮箱地址'); return; }
      const config = (await storage.getSmtpConfig()) || {};
      config.fromEmail = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ 发件人邮箱已设置为: ${text}`, { replyMarkup: backButton() });
      break;
    }

    case 'set_from_name': {
      const config = (await storage.getSmtpConfig()) || {};
      config.fromName = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ 发件人名称已设置为: ${text}`, { replyMarkup: backButton() });
      break;
    }

    case 'set_api_key': {
      const config = (await storage.getSmtpConfig()) || {};
      config.apiKey = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, '✅ API Key 已设置', { replyMarkup: backButton() });
      break;
    }

    case 'set_api_url': {
      try { new URL(text); } catch { await bot.sendMessage(userId, '❌ 请输入有效的URL'); return; }
      const config = (await storage.getSmtpConfig()) || {};
      config.apiUrl = text;
      await storage.saveSmtpConfig(config);
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, `✅ API URL 已设置`, { replyMarkup: backButton() });
      break;
    }

    case 'add_email': {
      if (!text.includes('@') || !text.includes('.')) { await bot.sendMessage(userId, '❌ 请输入有效的邮箱地址'); return; }
      try {
        await storage.addEmailRecipient(text.toLowerCase());
        await storage.clearUserState(userId);
        await bot.sendMessage(userId, `✅ 收件人已添加: ${text}`, { replyMarkup: backButton() });
      } catch (e) {
        await bot.sendMessage(userId, `❌ ${e.message}`);
      }
      break;
    }

    default:
      await storage.clearUserState(userId);
      await bot.sendMessage(userId, '请使用 /start 查看功能菜单');
  }
}

// ====================================================================
// UI 显示函数
// ====================================================================
async function showMainMenu(bot, userId, from, messageId) {
  const text =
    `👋 欢迎使用 TGBot RSS 订阅机器人！\n\n` +
    `👤 ${from || '用户'} (<code>${userId}</code>)\n\n` +
    `1️⃣ 订阅管理：增加/删除/查看 RSS 源\n` +
    `2️⃣ 关键词管理：增加/删除/查看 关键词\n` +
    `3️⃣ 📧 邮件推送：配置邮件通知\n\n请选择以下操作：`;
  if (messageId) await bot.editHTML(userId, messageId, text, { replyMarkup: mainMenuKeyboard() });
  else await bot.sendHTML(userId, text, { replyMarkup: mainMenuKeyboard() });
}

async function showHelp(bot, userId, messageId) {
  const text =
    `🤖 RSS订阅机器人 (Cloudflare Workers 版)\n\n📝 <b>使用帮助</b>\n\n` +
    `🔤 <b>关键词基础</b>\n• 支持中英文，可用逗号或空格分隔\n\n` +
    `🎯 <b>高级匹配</b>\n• <code>*</code> 可匹配任意字符\n• <code>-关键词</code> 表示屏蔽\n` +
    `• <code>#t关键词</code> 只匹配标题\n• <code>#c关键词</code> 只匹配描述\n• <code>#a关键词</code> 匹配标题和描述\n\n` +
    `📡 <b>RSS过滤</b>\n• <code>关键词+RSS名称</code> 只匹配指定RSS源\n\n` +
    `📧 <b>邮件推送</b>\n• 支持 MailChannels / Resend / SendGrid / 自定义API\n• 在菜单中配置即可同步推送到邮箱\n\n` +
    `📦 源码: github.com/IonRh/TGBot_RSS`;
  if (messageId) await bot.editHTML(userId, messageId, text, { replyMarkup: backButton(), disablePreview: true });
  else await bot.sendHTML(userId, text, { replyMarkup: backButton(), disablePreview: true });
}

async function viewKeywords(bot, storage, userId, messageId) {
  const keywords = await storage.getKeywords(userId);
  if (keywords.length === 0) {
    await editMessage(bot, userId, messageId, '你还没有添加任何关键词\n\n点击 📝 添加关键词 开始使用', backButton());
    return;
  }
  const list = keywords.sort().map((kw, i) => `${i + 1}.<code>${kw}</code>`).join('  ');
  await bot.editHTML(userId, messageId, `📋 你的关键词列表（共 ${keywords.length} 个）：\n\n${list}`, { replyMarkup: backButton() });
}

async function showDeleteKeywords(bot, storage, userId, messageId) {
  const keywords = await storage.getKeywords(userId);
  if (keywords.length === 0) { await editMessage(bot, userId, messageId, '你还没有添加任何关键词', backButton()); return; }
  await editMessage(bot, userId, messageId, '请选择要删除的关键词：', deleteKeyboard(keywords.sort(), 'del_kw'));
}

async function deleteKeyword(bot, storage, userId, messageId, keyword) {
  try {
    const remaining = await storage.removeKeyword(userId, keyword);
    await editMessage(bot, userId, messageId, `✅ 关键词 "${keyword}" 已删除\n当前剩余 ${remaining.length} 个关键词`, backButton());
  } catch (e) {
    await editMessage(bot, userId, messageId, `❌ ${e.message}`, backButton());
  }
}

async function viewSubscriptions(bot, storage, userId, messageId) {
  const subs = await storage.getSubscriptionsForUser(userId);
  if (subs.length === 0) { await editMessage(bot, userId, messageId, '你还没有添加任何订阅\n\n点击 ➕ 添加订阅 开始使用', backButton()); return; }
  const list = subs.map((s, i) => `订阅${i + 1}.<code>${s.name}</code>\n${s.url}`).join('\n');
  await bot.editHTML(userId, messageId, `📰 你的订阅列表（共 ${subs.length} 个）：\n\n${list}`, { replyMarkup: backButton() });
}

async function showDeleteSubscriptions(bot, storage, userId, messageId) {
  const subs = await storage.getSubscriptionsForUser(userId);
  if (subs.length === 0) { await editMessage(bot, userId, messageId, '你还没有添加任何订阅', backButton()); return; }
  await editMessage(bot, userId, messageId, '请选择要删除的订阅：', deleteKeyboard(subs.map(s => s.name), 'del_sub'));
}

async function deleteSubscription(bot, storage, userId, messageId, name) {
  try {
    await storage.removeSubscription(name, userId);
    await editMessage(bot, userId, messageId, `✅ 订阅 "${name}" 已删除`, backButton());
  } catch (e) {
    await editMessage(bot, userId, messageId, `❌ ${e.message}`, backButton());
  }
}

async function showEmailMenu(bot, storage, userId, messageId) {
  const config = await storage.getSmtpConfig();
  const recipients = await storage.getEmailRecipients();
  let status = '❌ 未配置';
  if (config) {
    status = config.enabled ? '✅ 已启用' : '⏸️ 已暂停';
    status += `\n📤 模式: ${config.mode || '未设置'}\n📧 发件人: ${config.fromEmail || '未设置'}\n👥 收件人: ${recipients.length} 个`;
  }
  const text = `📧 邮件推送管理\n\n状态: ${status}\n\n请选择操作：`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '⚙️ 配置邮件服务', callback_data: 'email_config' }, { text: '👥 收件人管理', callback_data: 'email_recipients' }],
      [{ text: '✅ 启用推送', callback_data: 'email_enable' }, { text: '⏸️ 暂停推送', callback_data: 'email_disable' }],
      [{ text: '🧪 发送测试邮件', callback_data: 'email_test' }],
      [{ text: '🔙 返回主菜单', callback_data: 'back_to_menu' }]
    ]
  };
  await editMessage(bot, userId, messageId, text, keyboard);
}

async function showEmailConfig(bot, storage, userId, messageId) {
  const config = (await storage.getSmtpConfig()) || {};
  const text =
    `⚙️ 邮件服务配置\n\n当前配置：\n` +
    `• 模式: ${config.mode || '未设置'}\n` +
    `• 发件人: ${config.fromEmail || '未设置'}\n` +
    `• 发件人名称: ${config.fromName || 'TGBot RSS'}\n` +
    `• API Key: ${config.apiKey ? '已设置 ✅' : '未设置 ❌'}\n` +
    `• API URL: ${config.apiUrl || '(默认)'}\n\n请选择要配置的项目：`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '📡 设置模式', callback_data: 'set_email_mode' }, { text: '📧 设置发件人', callback_data: 'set_smtp_from' }],
      [{ text: '✏️ 发件人名称', callback_data: 'set_from_name' }, { text: '🔑 设置API Key', callback_data: 'set_api_key' }],
      [{ text: '🔗 设置API URL', callback_data: 'set_api_url' }],
      [{ text: '🔙 返回邮件菜单', callback_data: 'email_menu' }]
    ]
  };
  await editMessage(bot, userId, messageId, text, keyboard);
}

async function showEmailRecipients(bot, storage, userId, messageId) {
  const recipients = await storage.getEmailRecipients();
  let text = `👥 收件人列表 (${recipients.length} 个)：\n\n`;
  text += recipients.length === 0 ? '暂无收件人，请添加' : recipients.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const rows = [];
  if (recipients.length > 0) {
    const btns = recipients.map(r => ({ text: `❌ ${r}`, callback_data: `del_email_${r}` }));
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  }
  rows.push([{ text: '➕ 添加收件人', callback_data: 'add_email' }]);
  rows.push([{ text: '🔙 返回邮件菜单', callback_data: 'email_menu' }]);
  await editMessage(bot, userId, messageId, text, { inline_keyboard: rows });
}

async function toggleEmail(bot, storage, userId, messageId, enabled) {
  const config = (await storage.getSmtpConfig()) || {};
  config.enabled = enabled;
  await storage.saveSmtpConfig(config);
  await showEmailMenu(bot, storage, userId, messageId);
}

async function testEmail(bot, storage, userId, messageId) {
  const result = await new EmailSender(storage).testEmail();
  if (result.success) await editMessage(bot, userId, messageId, '✅ 测试邮件发送成功！请检查收件箱。', backButton());
  else await editMessage(bot, userId, messageId, `❌ 测试邮件发送失败：\n${result.error}`, backButton());
}

async function deleteEmailRecipient(bot, storage, userId, messageId, email) {
  try {
    await storage.removeEmailRecipient(email);
    await showEmailRecipients(bot, storage, userId, messageId);
  } catch (e) {
    await editMessage(bot, userId, messageId, `❌ ${e.message}`, backButton());
  }
}

// ====================================================================
// 主入口 - Worker Handlers
// ====================================================================

// 处理 Telegram Update
async function processUpdate(update, env) {
  const bot = new TelegramBot(env.BOT_TOKEN);
  const adminId = parseInt(env.ADMIN_ID) || 0;

  try {
    if (update.message) {
      const msg = update.message;
      if (adminId !== 0 && msg.from.id !== adminId) {
        await bot.sendMessage(msg.from.id, '你没有权限使用此机器人');
        return;
      }
      if (msg.text && msg.text.startsWith('/')) await handleCommand(bot, msg, env);
      else await handleMessage(bot, msg, env);
    } else if (update.callback_query) {
      const cb = update.callback_query;
      if (adminId !== 0 && cb.from.id !== adminId) {
        await bot.answerCallbackQuery(cb.id, '你没有权限');
        return;
      }
      await bot.answerCallbackQuery(cb.id);
      await handleCallback(bot, cb, env);
    }
  } catch (e) {
    console.error('处理更新失败:', e);
  }
}

// 检查 RSS
async function checkRSS(env) {
  const bot = new TelegramBot(env.BOT_TOKEN);
  const checker = new RSSChecker(env.KV, bot);
  await checker.checkAll();
}

// 安装欢迎页 HTML
function welcomePage(env) {
  const hasToken = !!env.BOT_TOKEN;
  const hasAdmin = !!env.ADMIN_ID;
  const hasKV = !!env.KV;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TGBot RSS</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:20px;line-height:1.6}
.ok{color:#22c55e}.err{color:#ef4444}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}
.btn{display:inline-block;background:#0088cc;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;margin-top:10px}
ul{padding-left:20px}</style></head><body>
<h1>🤖 TGBot RSS - Cloudflare Workers</h1>
<h2>📋 配置检查</h2>
<ul>
<li>BOT_TOKEN: ${hasToken ? '<span class="ok">✅ 已配置</span>' : '<span class="err">❌ 未配置</span>'}</li>
<li>ADMIN_ID: ${hasAdmin ? '<span class="ok">✅ 已配置</span>' : '<span class="err">❌ 未配置</span>'}</li>
<li>KV 命名空间: ${hasKV ? '<span class="ok">✅ 已绑定</span>' : '<span class="err">❌ 未绑定</span>'}</li>
</ul>
<h2>🚀 部署步骤</h2>
<ol>
<li>在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings</li>
<li>添加环境变量 <code>BOT_TOKEN</code> (Telegram Bot Token)</li>
<li>添加环境变量 <code>ADMIN_ID</code> (你的 Telegram User ID, 设为 0 表示所有人可用)</li>
<li>绑定 KV 命名空间，变量名为 <code>KV</code></li>
<li>添加 Cron Trigger: <code>* * * * *</code> (每分钟检查RSS)</li>
<li>${hasToken ? '<a class="btn" href="/setup">📍 点击注册 Webhook</a>' : '配置完成后访问 /setup 注册 Webhook'}</li>
</ol>
<p>📦 源码: <a href="https://github.com/IonRh/TGBot_RSS">github.com/IonRh/TGBot_RSS</a></p>
</body></html>`;
}

// Worker 默认导出
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 注册 Webhook
    if (url.pathname === '/setup') {
      if (!env.BOT_TOKEN) return new Response('❌ BOT_TOKEN 未配置', { status: 500 });
      const bot = new TelegramBot(env.BOT_TOKEN);
      const webhookUrl = `${url.origin}/webhook/${env.BOT_TOKEN}`;
      const result = await bot.setWebhook(webhookUrl);
      return new Response(JSON.stringify({
        message: result.ok ? '✅ Webhook 注册成功' : '❌ Webhook 注册失败',
        webhook_url: webhookUrl,
        telegram_response: result
      }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // 接收 Telegram 更新
    if (env.BOT_TOKEN && url.pathname === `/webhook/${env.BOT_TOKEN}`) {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try {
        const update = await request.json();
        ctx.waitUntil(processUpdate(update, env));
        return new Response('OK');
      } catch (e) {
        console.error('Webhook 错误:', e);
        return new Response('Error', { status: 500 });
      }
    }

    // 手动触发 RSS 检查
    if (url.pathname === '/check') {
      ctx.waitUntil(checkRSS(env));
      return new Response('RSS check triggered');
    }

    // 首页 - 配置检查
    return new Response(welcomePage(env), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkRSS(env));
  }
};
