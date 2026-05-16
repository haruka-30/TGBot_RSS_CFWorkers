/**
 * KV 存储层 - 替代 SQLite
 * 
 * KV 键结构:
 * - subscriptions: JSON 数组，所有订阅列表
 * - user_keywords:{userId}: JSON 数组，用户关键词
 * - feed_data:{rssName}: JSON 对象，RSS 源最后更新信息
 * - user_state:{userId}: JSON 对象，用户交互状态
 * - smtp_config: JSON 对象，SMTP 邮件配置
 * - email_recipients: JSON 数组，邮件接收人列表
 * - push_stats: JSON 对象，推送统计
 */

export class Storage {
  constructor(kv) {
    this.kv = kv;
  }

  // ========== 订阅管理 ==========

  async getSubscriptions() {
    const data = await this.kv.get('subscriptions', 'json');
    return data || [];
  }

  async saveSubscriptions(subscriptions) {
    await this.kv.put('subscriptions', JSON.stringify(subscriptions));
  }

  async addSubscription(url, name, channel, userId) {
    const subs = await this.getSubscriptions();

    // 检查是否已存在
    const existing = subs.find(s => s.url === url || s.name === name);
    if (existing) {
      if (existing.users.includes(userId)) {
        throw new Error('你已经订阅了这个RSS源');
      }
      existing.users.push(userId);
    } else {
      subs.push({
        url,
        name,
        users: [userId],
        channel: parseInt(channel) || 0
      });
    }

    await this.saveSubscriptions(subs);

    // 初始化 feed_data
    const feedData = await this.getFeedData(name);
    if (!feedData) {
      await this.saveFeedData(name, {
        lastUpdateTime: new Date().toISOString(),
        latestTitle: ''
      });
    }
  }

  async removeSubscription(name, userId) {
    const subs = await this.getSubscriptions();
    const index = subs.findIndex(s => s.name === name);

    if (index === -1) {
      throw new Error('订阅不存在');
    }

    const sub = subs[index];
    sub.users = sub.users.filter(id => id !== userId);

    if (sub.users.length === 0) {
      subs.splice(index, 1);
      await this.kv.delete(`feed_data:${name}`);
    }

    await this.saveSubscriptions(subs);
  }

  async getSubscriptionsForUser(userId) {
    const subs = await this.getSubscriptions();
    return subs.filter(s => s.users.includes(userId));
  }

  // ========== 关键词管理 ==========

  async getKeywords(userId) {
    const data = await this.kv.get(`user_keywords:${userId}`, 'json');
    return data || [];
  }

  async saveKeywords(userId, keywords) {
    await this.kv.put(`user_keywords:${userId}`, JSON.stringify(keywords));
  }

  async addKeywords(userId, newKeywords) {
    const existing = await this.getKeywords(userId);
    const keywordSet = new Set(existing);

    let addedCount = 0;
    for (const kw of newKeywords) {
      const trimmed = kw.trim();
      if (trimmed && !keywordSet.has(trimmed)) {
        keywordSet.add(trimmed);
        addedCount++;
      }
    }

    if (addedCount === 0) {
      return { addedCount: 0, total: existing.length, keywords: existing };
    }

    const finalKeywords = [...keywordSet].sort();
    await this.saveKeywords(userId, finalKeywords);
    return { addedCount, total: finalKeywords.length, keywords: finalKeywords };
  }

  async removeKeyword(userId, keyword) {
    const keywords = await this.getKeywords(userId);
    const newKeywords = keywords.filter(k => k !== keyword);

    if (newKeywords.length === keywords.length) {
      throw new Error(`关键词 "${keyword}" 不存在`);
    }

    await this.saveKeywords(userId, newKeywords);
    return newKeywords;
  }

  // ========== Feed 数据 ==========

  async getFeedData(rssName) {
    return await this.kv.get(`feed_data:${rssName}`, 'json');
  }

  async saveFeedData(rssName, data) {
    await this.kv.put(`feed_data:${rssName}`, JSON.stringify(data));
  }

  // ========== 用户状态 ==========

  async getUserState(userId) {
    return await this.kv.get(`user_state:${userId}`, 'json');
  }

  async setUserState(userId, state) {
    // 状态 5 分钟后过期
    await this.kv.put(`user_state:${userId}`, JSON.stringify(state), {
      expirationTtl: 300
    });
  }

  async clearUserState(userId) {
    await this.kv.delete(`user_state:${userId}`);
  }

  // ========== SMTP 邮件配置 ==========

  async getSmtpConfig() {
    return await this.kv.get('smtp_config', 'json');
  }

  async saveSmtpConfig(config) {
    await this.kv.put('smtp_config', JSON.stringify(config));
  }

  async getEmailRecipients() {
    const data = await this.kv.get('email_recipients', 'json');
    return data || [];
  }

  async saveEmailRecipients(recipients) {
    await this.kv.put('email_recipients', JSON.stringify(recipients));
  }

  async addEmailRecipient(email) {
    const recipients = await this.getEmailRecipients();
    if (recipients.includes(email)) {
      throw new Error('该邮箱已存在');
    }
    recipients.push(email);
    await this.saveEmailRecipients(recipients);
  }

  async removeEmailRecipient(email) {
    const recipients = await this.getEmailRecipients();
    const newRecipients = recipients.filter(r => r !== email);
    if (newRecipients.length === recipients.length) {
      throw new Error('该邮箱不存在');
    }
    await this.saveEmailRecipients(newRecipients);
    return newRecipients;
  }

  // ========== 推送统计 ==========

  async getPushStats() {
    const data = await this.kv.get('push_stats', 'json');
    const today = new Date().toISOString().split('T')[0];

    if (!data || data.date !== today) {
      return { date: today, total: 0, byRss: {} };
    }
    return data;
  }

  async recordPush(rssName) {
    const stats = await this.getPushStats();
    stats.total++;
    stats.byRss[rssName] = (stats.byRss[rssName] || 0) + 1;
    await this.kv.put('push_stats', JSON.stringify(stats));
  }

  // ========== 获取所有用户关键词 (用于 RSS 检查) ==========

  async getAllUserKeywords() {
    const subs = await this.getSubscriptions();
    const userIds = new Set();
    for (const sub of subs) {
      for (const uid of sub.users) {
        userIds.add(uid);
      }
    }

    const userKeywords = {};
    for (const uid of userIds) {
      const keywords = await this.getKeywords(uid);
      if (keywords.length > 0) {
        userKeywords[uid] = keywords;
      }
    }
    return userKeywords;
  }
}
