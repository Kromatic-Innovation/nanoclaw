/**
 * Apple Messages (iMessage) channel for NanoClaw.
 *
 * Two-way communication via:
 * - Sending: AppleScript → Messages.app
 * - Receiving: Polling ~/Library/Messages/chat.db (SQLite)
 *
 * JID format: imessage:<handle> (e.g. imessage:+15551234567, imessage:user@icloud.com)
 *
 * Requires macOS with Messages.app configured and Full Disk Access for the
 * NanoClaw process (to read chat.db).
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

import { ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

const JID_PREFIX = 'imessage:';
const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds
const CHAT_DB = path.join(homedir(), 'Library', 'Messages', 'chat.db');
const MAX_MESSAGE_LENGTH = 10000; // iMessage has no hard limit but be reasonable

export class AppleMessagesChannel implements Channel {
  name = 'apple';

  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageRowId = 0; // Track last processed message ROWID
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private opts: ChannelOpts;
  private serviceHandle: string; // The iMessage handle for this account

  constructor(opts: ChannelOpts, serviceHandle: string) {
    this.opts = opts;
    this.serviceHandle = serviceHandle;
  }

  async connect(): Promise<void> {
    if (!existsSync(CHAT_DB)) {
      throw new Error(
        `Messages database not found at ${CHAT_DB}. Is Messages.app configured?`,
      );
    }

    // Get the latest message ROWID so we only process new messages
    try {
      this.lastMessageRowId = await this.getMaxRowId();
    } catch (err) {
      throw new Error(
        `Cannot read Messages database. Grant Full Disk Access to this process. Error: ${err}`,
      );
    }

    this.connected = true;
    this.startPolling();
    await this.flushOutgoingQueue();

    logger.info(
      { handle: this.serviceHandle, lastRowId: this.lastMessageRowId },
      'Apple Messages channel connected',
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      return;
    }

    const handle = jid.replace(JID_PREFIX, '');

    // Split large messages
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }

    for (const chunk of chunks) {
      await this.sendViaAppleScript(handle, chunk);
    }
  }

  async syncGroups(): Promise<void> {
    // Discover recent conversations from chat.db
    try {
      const chats = await this.runSqlite(`
        SELECT DISTINCT
          h.id AS handle,
          COALESCE(c.display_name, h.id) AS name
        FROM chat_handle_join chj
        JOIN handle h ON h.ROWID = chj.handle_id
        JOIN chat c ON c.ROWID = chj.chat_id
        WHERE h.service = 'iMessage'
        ORDER BY c.ROWID DESC
        LIMIT 50
      `);

      for (const row of chats) {
        if (row.handle) {
          const jid = `${JID_PREFIX}${row.handle}`;
          updateChatName(jid, row.name || row.handle);
          this.opts.onChatMetadata(
            jid,
            new Date().toISOString(),
            row.name || row.handle,
            'apple',
            false, // iMessage chats are treated as 1:1
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to sync Apple Messages conversations');
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private startPolling(): void {
    const poll = async () => {
      if (!this.connected) return;

      try {
        await this.pollNewMessages();
      } catch (err) {
        logger.error({ err }, 'Error polling Apple Messages');
      }

      this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  private async pollNewMessages(): Promise<void> {
    // Query for messages newer than our last known ROWID
    const messages = await this.runSqlite(`
      SELECT
        m.ROWID,
        m.guid,
        m.text,
        m.is_from_me,
        m.date / 1000000000 + 978307200 AS unix_timestamp,
        h.id AS sender_handle
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ${this.lastMessageRowId}
        AND m.text IS NOT NULL
        AND m.text != ''
        AND m.associated_message_type = 0
      ORDER BY m.ROWID ASC
      LIMIT 50
    `);

    for (const msg of messages) {
      const rowId = parseInt(msg.ROWID, 10);
      if (rowId > this.lastMessageRowId) {
        this.lastMessageRowId = rowId;
      }

      // Skip our own outgoing messages
      if (msg.is_from_me === '1') continue;

      const handle = msg.sender_handle || 'unknown';
      const jid = `${JID_PREFIX}${handle}`;
      const timestamp = new Date(
        parseInt(msg.unix_timestamp, 10) * 1000,
      ).toISOString();

      // Report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, handle, 'apple', false);

      // Deliver message
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) continue;

      this.opts.onMessage(jid, {
        id: msg.guid || `imsg-${msg.ROWID}`,
        chat_jid: jid,
        sender: handle,
        sender_name: handle,
        content: msg.text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    }
  }

  private async getMaxRowId(): Promise<number> {
    const rows = await this.runSqlite(
      'SELECT MAX(ROWID) AS max_id FROM message',
    );
    return parseInt(rows[0]?.max_id || '0', 10);
  }

  private async sendViaAppleScript(
    handle: string,
    text: string,
  ): Promise<void> {
    // Escape for AppleScript string (backslash and double quote)
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${handle}" of targetService
        send "${escaped}" to targetBuddy
      end tell
    `;

    return new Promise((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', script],
        { timeout: 15000 },
        (error, _stdout, stderr) => {
          if (error) {
            logger.error(
              { handle, error: stderr || error.message },
              'AppleScript send failed',
            );
            reject(
              new Error(`Failed to send iMessage: ${stderr || error.message}`),
            );
            return;
          }
          resolve();
        },
      );
    });
  }

  private async runSqlite(
    query: string,
  ): Promise<Array<Record<string, string>>> {
    return new Promise((resolve, reject) => {
      execFile(
        'sqlite3',
        ['-json', '-readonly', CHAT_DB, query],
        { timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`sqlite3 error: ${stderr || error.message}`));
            return;
          }
          const trimmed = stdout.trim();
          if (!trimmed) {
            resolve([]);
            return;
          }
          try {
            resolve(JSON.parse(trimmed));
          } catch {
            resolve([]);
          }
        },
      );
    });
  }

  private async flushOutgoingQueue(): Promise<void> {
    while (this.outgoingQueue.length > 0) {
      const { jid, text } = this.outgoingQueue.shift()!;
      try {
        await this.sendMessage(jid, text);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to flush queued Apple message');
      }
    }
  }
}

// ── Self-registration ──────────────────────────────────────────────────

registerChannel('apple', (opts: ChannelOpts) => {
  // Only available on macOS
  if (process.platform !== 'darwin') {
    logger.debug('Apple Messages: skipping (not macOS)');
    return null;
  }

  // Check for iMessage handle in .env
  const env = readEnvFile(['IMESSAGE_HANDLE']);
  if (!env.IMESSAGE_HANDLE) {
    logger.warn(
      'Apple Messages: IMESSAGE_HANDLE not set in .env (e.g. +15551234567 or user@icloud.com)',
    );
    return null;
  }

  if (!existsSync(CHAT_DB)) {
    logger.warn(`Apple Messages: chat.db not found at ${CHAT_DB}`);
    return null;
  }

  return new AppleMessagesChannel(opts, env.IMESSAGE_HANDLE);
});
