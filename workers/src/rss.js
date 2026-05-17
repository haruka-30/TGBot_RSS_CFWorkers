/**
 * RSS 解析和检查模块
 */

import { Storage } from './storage.js';
import { EmailSender } from './email.js';

/**
 * 备用 User-Agent 列表 (按优先级排序)
 * 部分站点 (如 NodeSeek / 奶昔论坛 / IDCFlare / NodeLoc) 对非浏览器 UA 直接返回 403,
 * 因此优先使用真实浏览器 UA, 失败后回退到主流 RSS 阅读器 UA.
 */
const FETCH_USER_AGENTS = [
  // 真实 Chrome (Windows)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // 真实 Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  // Feedly
  'Mozilla/5.0 (compatible; Feedly/1.0; +http://www.feedly.com/fetcher.html)',
  // Inoreader
  'Mozilla/5.0 (compatible; Inoreader/1.0; +https://www.inoreader.com)',
  // Googlebot (部分站点会单独放行)
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
];

/**
 * 通用 RSS 抓取函数, 带浏览器请求头和多 UA 回退.
 * 可被订阅校验和定时检查共用.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number, text: string, error?: string}>}
 */
export async function fetchFeed(url) {
  let lastStatus = 0;
  let lastError = '';

  // 尝试根据 URL 推断 Referer (部分论坛会校验 Referer)
  let referer = '';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.host}/`;
  } catch (_) { /* ignore */ }

  for (let i = 0; i < FETCH_USER_AGENTS.length; i++) {
    const ua = FETCH_USER_AGENTS[i];
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
        // 禁用 Cloudflare 边缘缓存, 避免命中之前的 403 响应
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      lastStatus = response.status;

      if (response.ok) {
        const text = await response.text();
        return { ok: true, status: response.status, text };
      }

      // 仅对反爬常见的状态码继续尝试下一个 UA
      // 其它 4xx (如 404) 直接返回, 避免无意义重试
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

export class RSSChecker {
  constructor(kv, bot) {
    this.storage = new Storage(kv);
    this.bot = bot;
    this.emailSender = new EmailSender(this.storage);
  }

  /**
   * 检查所有 RSS 订阅
   */
  async checkAll(env) {
    console.log('开始检查 RSS 订阅...');

    const subscriptions = await this.storage.getSubscriptions();
    if (subscriptions.length === 0) {
      console.log('没有 RSS 订阅');
      return;
    }

    const userKeywords = await this.storage.getAllUserKeywords();

    // 并发检查所有订阅 (限制并发数)
    const batchSize = 5;
    for (let i = 0; i < subscriptions.length; i += batchSize) {
      const batch = subscriptions.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map(sub => this.processSubscription(sub, userKeywords))
      );
    }

    console.log('RSS 检查完成');
  }

  /**
   * 处理单个订阅
   */
  async processSubscription(sub, userKeywords) {
    try {
      const messages = await this.fetchRSS(sub);
      if (!messages || messages.length === 0) return;

      for (const msg of messages) {
        for (const userId of sub.users) {
          const keywords = userKeywords[userId];
          if (!keywords || keywords.length === 0) continue;

          const matched = this.matchKeywords(msg, keywords, sub.name);
          if (matched.length > 0) {
            await this.pushMessage(userId, sub, msg, matched);
            await this.storage.recordPush(sub.name);
          }
        }
      }
    } catch (e) {
      console.error(`处理订阅 ${sub.name} 失败:`, e);
    }
  }

  /**
   * 获取 RSS 内容
   */
  async fetchRSS(sub) {
    const result = await fetchFeed(sub.url);
    if (!result.ok) {
      throw new Error(result.error || `HTTP ${result.status}`);
    }

    const text = result.text;
    const items = this.parseRSS(text);

    if (items.length === 0) return null;

    // 获取上次更新时间
    const feedData = await this.storage.getFeedData(sub.name);
    const lastUpdateTime = feedData ? new Date(feedData.lastUpdateTime) : new Date(0);

    // 过滤新内容
    const newItems = [];
    let latestTime = lastUpdateTime;

    for (const item of items) {
      const pubDate = new Date(item.pubDate);
      if (pubDate > latestTime) {
        latestTime = pubDate;
      }
      if (pubDate > lastUpdateTime) {
        newItems.push(item);
      }
    }

    // 更新最后时间
    if (latestTime > lastUpdateTime) {
      await this.storage.saveFeedData(sub.name, {
        lastUpdateTime: latestTime.toISOString(),
        latestTitle: items[0]?.title || ''
      });
    }

    return newItems;
  }

  /**
   * 解析 RSS/Atom XML
   */
  parseRSS(xmlText) {
    const items = [];

    // 尝试解析 RSS 2.0
    const rssItems = this.extractTags(xmlText, 'item');
    if (rssItems.length > 0) {
      for (const itemXml of rssItems) {
        items.push({
          title: this.extractTagContent(itemXml, 'title'),
          description: this.extractTagContent(itemXml, 'description') || this.extractTagContent(itemXml, 'content:encoded'),
          link: this.extractTagContent(itemXml, 'link') || this.extractAttr(itemXml, 'link', 'href'),
          pubDate: this.extractTagContent(itemXml, 'pubDate') || this.extractTagContent(itemXml, 'dc:date') || new Date().toISOString()
        });
      }
      return items;
    }

    // 尝试解析 Atom
    const entries = this.extractTags(xmlText, 'entry');
    for (const entryXml of entries) {
      items.push({
        title: this.extractTagContent(entryXml, 'title'),
        description: this.extractTagContent(entryXml, 'summary') || this.extractTagContent(entryXml, 'content'),
        link: this.extractAttr(entryXml, 'link', 'href') || this.extractTagContent(entryXml, 'link'),
        pubDate: this.extractTagContent(entryXml, 'published') || this.extractTagContent(entryXml, 'updated') || new Date().toISOString()
      });
    }

    return items;
  }

  /**
   * 提取 XML 标签内容
   */
  extractTags(xml, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    let match;
    while ((match = regex.exec(xml)) !== null) {
      results.push(match[0]);
    }
    return results;
  }

  extractTagContent(xml, tagName) {
    // 处理 CDATA
    const cdataRegex = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`, 'i');
    let match = cdataRegex.exec(xml);
    if (match) return match[1].trim();

    // 普通标签
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    match = regex.exec(xml);
    if (match) return match[1].trim();

    return '';
  }

  extractAttr(xml, tagName, attrName) {
    const regex = new RegExp(`<${tagName}[^>]*${attrName}=["']([^"']+)["']`, 'i');
    const match = regex.exec(xml);
    return match ? match[1] : '';
  }

  /**
   * 关键词匹配
   */
  matchKeywords(msg, keywords, rssName) {
    const titleContent = (msg.title || '').toLowerCase();
    const descContent = (msg.description || '').toLowerCase();
    const allContent = (titleContent + ' ' + descContent);

    const matchedKeywords = [];
    const blockedKeywords = [];

    for (let keyword of keywords) {
      keyword = keyword.trim();
      if (!keyword) continue;

      // 检查是否是屏蔽关键词
      const isBlock = keyword.startsWith('-');
      if (isBlock) keyword = keyword.substring(1);

      // 检查匹配范围前缀
      let targetContent = titleContent; // 默认匹配标题
      if (keyword.startsWith('#t')) {
        targetContent = titleContent;
        keyword = keyword.substring(2);
      } else if (keyword.startsWith('#c')) {
        targetContent = descContent;
        keyword = keyword.substring(2);
      } else if (keyword.startsWith('#a')) {
        targetContent = allContent;
        keyword = keyword.substring(2);
      }

      keyword = keyword.trim();

      // 检查 RSS 名称过滤
      let actualKeyword = keyword;
      if (keyword.includes('+')) {
        const parts = keyword.split('+');
        if (parts.length === 2) {
          actualKeyword = parts[0].trim();
          const targetRSS = parts[1].trim();
          if (targetRSS.toLowerCase() !== rssName.toLowerCase()) {
            continue;
          }
        }
      }

      const lowerKeyword = actualKeyword.toLowerCase();

      // 通配符匹配
      let matched = false;
      if (lowerKeyword.includes('*')) {
        const pattern = lowerKeyword.replace(/\*/g, '.*');
        try {
          const regex = new RegExp(pattern);
          matched = regex.test(targetContent);
        } catch (e) {
          matched = targetContent.includes(lowerKeyword.replace(/\*/g, ''));
        }
      } else {
        matched = targetContent.includes(lowerKeyword);
      }

      if (matched) {
        if (isBlock) {
          blockedKeywords.push(actualKeyword);
        } else {
          matchedKeywords.push(actualKeyword);
        }
      }
    }

    // 如果命中屏蔽词，返回空
    if (blockedKeywords.length > 0) return [];

    return matchedKeywords;
  }

  /**
   * 推送消息
   */
  async pushMessage(userId, sub, msg, matchedKeywords) {
    const formattedDate = new Date(msg.pubDate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const keywordTags = matchedKeywords.map(kw => `<code>${kw}</code>`).join(' ');

    let htmlMessage;
    if (sub.channel === 1) {
      const imageURL = this.extractImageURL(msg.description || '');
      const cleanDesc = this.cleanHTML(msg.description || '');
      htmlMessage = `👋 ${sub.name}: ${keywordTags}\n🕒 ${formattedDate}\n${cleanDesc}`;

      if (imageURL) {
        try {
          await this.bot.sendPhoto(userId, imageURL, htmlMessage);
        } catch (e) {
          await this.bot.sendHTML(userId, htmlMessage);
        }
      } else {
        await this.bot.sendHTML(userId, htmlMessage);
      }
    } else {
      htmlMessage = `📌 ${this.escapeHTML(msg.title)}\n🔖 关键词: ${keywordTags}\n🕒 ${formattedDate}\n🔗 ${msg.link}`;
      await this.bot.sendHTML(userId, htmlMessage);
    }

    // 同时发送邮件推送
    try {
      await this.emailSender.sendRSSUpdate(sub.name, [msg], matchedKeywords);
    } catch (e) {
      console.error('邮件推送失败:', e);
    }
  }

  /**
   * 提取图片 URL
   */
  extractImageURL(html) {
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];

    const urlMatch = html.match(/https?:\/\/[^\s"']+\.(jpg|jpeg|png|gif|webp)/i);
    if (urlMatch) return urlMatch[0];

    return '';
  }

  /**
   * 清理 HTML 内容
   */
  cleanHTML(html) {
    if (!html) return '';

    // 移除 img 标签
    html = html.replace(/<img[^>]*>/gi, '');
    // 替换 br 为换行
    html = html.replace(/<br\s*\/?>/gi, '\n');

    // 保留 Telegram 支持的标签
    const allowedTags = ['b', 'i', 'u', 's', 'code', 'pre'];
    // 保留 a 标签
    const aTagRegex = /<a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    html = html.replace(aTagRegex, '<a href="$1">$2</a>');

    // 移除不支持的标签 (保留内容)
    html = html.replace(/<(?!\/?(?:b|i|u|s|code|pre|a)\b)[^>]+>/gi, '');

    // 移除连续换行
    html = html.replace(/\n{3,}/g, '\n\n');

    // 限制长度
    if (html.length > 3000) {
      html = html.substring(0, 3000) + '...';
    }

    return html.trim();
  }

  /**
   * HTML 转义
   */
  escapeHTML(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
