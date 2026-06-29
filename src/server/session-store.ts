// 会话存储 — SQLite (sql.js) 持久化多会话聊天历史
// 表结构：chat_sessions (id, title, messages_json, created_at, updated_at)
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import logger from '../logger';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  duration?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

class SessionStoreClass {
  private db!: Database;
  private SQL!: SqlJsStatic;
  private dbPath: string = '';
  private initialized = false;

  async init(dbDir?: string): Promise<void> {
    if (this.initialized) return;

    this.SQL = await initSqlJs();

    const dir = dbDir || path.join(process.cwd(), 'data');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.dbPath = path.join(dir, 'sessions.db');

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
      logger.info(`[SessionStore] 已加载会话数据库: ${this.dbPath}`);
    } else {
      this.db = new this.SQL.Database();
      logger.info('[SessionStore] 已创建新会话数据库');
    }

    this.createTables();
    this.initialized = true;
  }

  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '新会话',
        messages_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.save();
  }

  private save(): void {
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      logger.warn('[SessionStore] 保存失败', err);
    }
  }

  createSession(title?: string): ChatSession {
    const id = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    const session: ChatSession = {
      id,
      title: title || '新会话',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      'INSERT INTO chat_sessions (id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [id, session.title, JSON.stringify([]), now, now],
    );
    this.save();
    logger.info(`[SessionStore] 创建会话: ${id} (${session.title})`);
    return session;
  }

  listSessions(): SessionSummary[] {
    const results = this.db.exec('SELECT id, title, created_at, updated_at, messages_json FROM chat_sessions ORDER BY updated_at DESC');
    if (results.length === 0) return [];
    const rows = results[0].values;
    return rows.map(row => {
      let msgCount = 0;
      try {
        const msgs = JSON.parse(row[4] as string);
        msgCount = Array.isArray(msgs) ? msgs.length : 0;
      } catch { }
      return {
        id: row[0] as string,
        title: row[1] as string,
        createdAt: row[2] as string,
        updatedAt: row[3] as string,
        messageCount: msgCount,
      };
    });
  }

  getSession(id: string): ChatSession | null {
    const results = this.db.exec('SELECT id, title, messages_json, created_at, updated_at FROM chat_sessions WHERE id = ?', [id]);
    if (results.length === 0 || results[0].values.length === 0) return null;
    const row = results[0].values[0];
    let messages: ChatMessage[] = [];
    try {
      messages = JSON.parse(row[2] as string);
    } catch { }
    return {
      id: row[0] as string,
      title: row[1] as string,
      messages,
      createdAt: row[2] as string,
      updatedAt: row[3] as string,
    };
  }

  updateMessages(id: string, messages: ChatMessage[]): void {
    const now = new Date().toISOString();
    const json = JSON.stringify(messages);
    this.db.run('UPDATE chat_sessions SET messages_json = ?, updated_at = ? WHERE id = ?', [json, now, id]);

    // 自动从首条用户消息生成标题（如果标题还是默认的"新会话"）
    const existing = this.getSession(id);
    if (existing && existing.title === '新会话' && messages.length > 0) {
      const firstUserMsg = messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        const autoTitle = firstUserMsg.content.slice(0, 40).replace(/\n/g, ' ').trim() || '新会话';
        this.db.run('UPDATE chat_sessions SET title = ? WHERE id = ?', [autoTitle, id]);
      }
    }
    this.save();
  }

  renameSession(id: string, title: string): void {
    const now = new Date().toISOString();
    this.db.run('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?', [title, now, id]);
    this.save();
  }

  deleteSession(id: string): void {
    this.db.run('DELETE FROM chat_sessions WHERE id = ?', [id]);
    this.save();
    logger.info(`[SessionStore] 删除会话: ${id}`);
  }
}

// 单例
let _instance: SessionStoreClass | null = null;

export function getSessionStore(): SessionStoreClass {
  if (!_instance) {
    _instance = new SessionStoreClass();
  }
  return _instance;
}

export const sessionStore = getSessionStore();
