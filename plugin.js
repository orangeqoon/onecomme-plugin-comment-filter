// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

let currentDir = __dirname;
let config = {
  enabled: true,
  matchMode: 'partial', // 'partial' | 'exact'
  caseSensitive: false,
  enableRegex: true,
  protectGifts: true,
  filterUserName: false,
  ngWords: [],
  ngUserNames: [],
  ngUserIds: []
};

// 統計 & 直近の除外履歴
const stats = {
  totalChecked: 0,
  totalFiltered: 0,
  totalPassed: 0,
  startTime: Date.now(),
  recentFiltered: []
};

function log(msg) {
  console.info('[NGフィルター] ' + msg);
}

function loadConfig(dir) {
  const targetDir = dir || currentDir || __dirname;
  const cfgPath = path.join(targetDir, 'config.json');
  const samplePath = path.join(targetDir, 'config.sample.json');

  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      config = { ...config, ...parsed };
      return;
    } catch (e) {
      console.warn('[NGフィルター] config.json の読み込みエラー:', e.message);
    }
  }

  if (fs.existsSync(samplePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
      config = { ...config, ...parsed };
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
      return;
    } catch (_) {}
  }
}

function saveConfig(dir, newConfig) {
  const targetDir = dir || currentDir || __dirname;
  const cfgPath = path.join(targetDir, 'config.json');
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2), 'utf8');
    config = { ...config, ...newConfig };
    regexCache.clear();
    log('設定を保存・更新しました (NGワード数: ' + (config.ngWords?.length || 0) + '件)');
    return true;
  } catch (err) {
    console.error('[NGフィルター] 設定保存エラー:', err.message);
    return false;
  }
}

// 正規表現キャッシュ (コンパイル負荷の軽減)
const regexCache = new Map();

function getCachedRegex(pattern, caseSensitive) {
  const cacheKey = pattern + '::' + (caseSensitive ? '1' : '0');
  if (regexCache.has(cacheKey)) {
    return regexCache.get(cacheKey);
  }

  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    try {
      const lastSlash = pattern.lastIndexOf('/');
      const body = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      const regex = new RegExp(body, flags || (caseSensitive ? '' : 'i'));
      regexCache.set(cacheKey, regex);
      return regex;
    } catch (_) {
      regexCache.set(cacheKey, null);
      return null;
    }
  }

  regexCache.set(cacheKey, null);
  return null;
}

// 単語・正規表現の一致判定
function testPattern(text, pattern, isRegexEnabled, matchMode, caseSensitive) {
  if (!text || !pattern) return false;

  // 1. 正規表現モード（/パターン/フラグ 形式）
  if (isRegexEnabled && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const regex = getCachedRegex(pattern, caseSensitive);
    if (regex) {
      try {
        return regex.test(text);
      } catch (_) {
        // 万が一の実行時エラーはフォールバック
      }
    }
  }

  // 2. 通常文字列マッチ判定
  const target = caseSensitive ? text : text.toLowerCase();
  const search = caseSensitive ? pattern : pattern.toLowerCase();

  if (matchMode === 'exact') {
    return target.trim() === search.trim();
  }
  return target.includes(search);
}

// コメント検査ロジック
function checkComment(commentData) {
  if (!config.enabled) return { matched: false };

  const commentText = String(commentData?.comment || '');
  const userName = String(commentData?.name || '');
  const userId = String(commentData?.userId || '');
  const hasGift = Boolean(commentData?.hasGift || (commentData?.price && Number(commentData.price) > 0));

  // ギフト・投げ銭の保護
  if (config.protectGifts && hasGift) {
    return { matched: false };
  }

  // 1. NGユーザーID検査
  if (Array.isArray(config.ngUserIds) && userId) {
    for (const uid of config.ngUserIds) {
      const u = String(uid).trim();
      if (u && (userId === u || userId.toLowerCase() === u.toLowerCase())) {
        return { matched: true, reason: `NGユーザーID (${u})` };
      }
    }
  }

  // 2. NGユーザー名検査
  if (Array.isArray(config.ngUserNames) && userName) {
    for (const uname of config.ngUserNames) {
      const n = String(uname).trim();
      if (n && (userName === n || (!config.caseSensitive && userName.toLowerCase() === n.toLowerCase()))) {
        return { matched: true, reason: `NGユーザー名 (${n})` };
      }
    }
  }

  // HTMLタグ（わんコメが展開した絵文字 <img> タグ等）を除去したプレーンテキストを作成
  // （例: Kick/Twitch等の絵文字 <img src="https://..."> に対するURLフィルター誤爆を防止）
  const plainText = commentText.replace(/<[^>]*>/g, ' ').trim();

  // 3. NGワード検査（コメント本文およびオプションでユーザー名）
  if (Array.isArray(config.ngWords) && config.ngWords.length > 0) {
    for (const word of config.ngWords) {
      const p = String(word || '').trim();
      if (!p) continue;

      // コメント本文を検査（プレーンテキスト優先）
      const targetText = plainText || commentText;
      if (testPattern(targetText, p, config.enableRegex, config.matchMode, config.caseSensitive)) {
        return { matched: true, reason: `NGワード: ${p}` };
      }

      // ユーザー名も検査対象の場合
      if (config.filterUserName && testPattern(userName, p, config.enableRegex, config.matchMode, config.caseSensitive)) {
        return { matched: true, reason: `名前NGワード: ${p}` };
      }
    }
  }

  return { matched: false };
}

const plugin = {
  name: 'NGワード完全非表示プラグイン (Comment NG Filter)',
  uid: 'com.orangeqoon.comment-ng-filter',
  version: '1.0.3',
  author: 'orangeqoon',
  url: 'http://localhost:11180/plugins/com.orangeqoon.comment-ng-filter/index.html',
  permissions: ['filter.comment'],
  defaultState: {},

  init({ dir }) {
    currentDir = dir;
    regexCache.clear();
    loadConfig(dir);
    log(`初期化完了 v1.0.3 (有効状態: ${config.enabled ? 'ON' : 'OFF'}, NGワード登録数: ${config.ngWords?.length || 0}件)`);
  },

  /**
   * わんコメ コメントフィルターフック
   * @param {Object} comment わんコメ コメントオブジェクト
   * @param {Object} service 配信枠サービスオブジェクト
   * @param {Object|null} userData ユーザーデータ
   * @returns {Promise<Object|false>} falseを返すと完全非表示（破棄）
   */
  async filterComment(comment, service, userData) {
    stats.totalChecked++;

    const checkResult = checkComment(comment.data);

    if (checkResult.matched) {
      stats.totalFiltered++;

      const commentText = comment.data?.comment || '';
      const userName = comment.data?.name || '名無し';
      const serviceName = service?.name || service?.id || '不明枠';
      const preview = commentText.length > 40 ? commentText.substring(0, 40) + '...' : commentText;

      const record = {
        id: Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        time: new Date().toLocaleTimeString(),
        reason: checkResult.reason,
        userName,
        commentPreview: preview,
        serviceName
      };

      stats.recentFiltered.unshift(record);
      if (stats.recentFiltered.length > 50) {
        stats.recentFiltered.pop();
      }

      log(`コメントを除外しました: 「${preview}」 (投稿者: ${userName}, 理由: ${checkResult.reason})`);

      // ★ false を返却することで、わんコメ本体・OBS・読み上げから完全に抹消
      return false;
    }

    stats.totalPassed++;
    return comment;
  },

  /**
   * Web管理パネル APIハンドラー (/api/plugins/com.orangeqoon.comment-ng-filter)
   */
  async request(req) {
    const targetDir = currentDir || __dirname;

    if (req.method === 'GET') {
      return {
        code: 200,
        body: {
          success: true,
          config,
          stats
        }
      };
    }

    if (req.method === 'POST') {
      try {
        let body = req.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch (_) {
            body = null;
          }
        }

        if (!body || typeof body !== 'object') {
          return {
            code: 400,
            body: { success: false, error: 'リクエストボディが不正です' }
          };
        }

        const newConfig = { ...config };

        if (body.enabled !== undefined) newConfig.enabled = Boolean(body.enabled);
        if (body.matchMode !== undefined) {
          newConfig.matchMode = body.matchMode === 'exact' ? 'exact' : 'partial';
        }
        if (body.caseSensitive !== undefined) newConfig.caseSensitive = Boolean(body.caseSensitive);
        if (body.enableRegex !== undefined) newConfig.enableRegex = Boolean(body.enableRegex);
        if (body.protectGifts !== undefined) newConfig.protectGifts = Boolean(body.protectGifts);
        if (body.filterUserName !== undefined) newConfig.filterUserName = Boolean(body.filterUserName);

        if (Array.isArray(body.ngWords)) {
          newConfig.ngWords = body.ngWords.map(w => String(w).trim()).filter(Boolean);
        }
        if (Array.isArray(body.ngUserNames)) {
          newConfig.ngUserNames = body.ngUserNames.map(n => String(n).trim()).filter(Boolean);
        }
        if (Array.isArray(body.ngUserIds)) {
          newConfig.ngUserIds = body.ngUserIds.map(u => String(u).trim()).filter(Boolean);
        }

        regexCache.clear();
        const saved = saveConfig(targetDir, newConfig);
        if (!saved) throw new Error('config.json の書き込みに失敗しました');

        return {
          code: 200,
          body: {
            success: true,
            config,
            stats
          }
        };
      } catch (err) {
        return {
          code: 400,
          body: { success: false, error: err.message }
        };
      }
    }

    return { code: 405, body: { error: 'Method Not Allowed' } };
  }
};

module.exports = plugin;
