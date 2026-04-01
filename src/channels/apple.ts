/**
 * Apple Messages (iMessage) channel for NanoClaw.
 *
 * Two-way communication via:
 * - Sending: AppleScript → Messages.app (runs under a second macOS user)
 * - Receiving: Polling ~/Library/Messages/chat.db (SQLite)
 *
 * JID format: imessage:<handle> (e.g. imessage:+15551234567, imessage:user@icloud.com)
 *
 * ## Second macOS user setup
 *
 * Messages.app only supports one Apple ID at a time. To give Voltaire its own
 * iMessage identity, create a second macOS user account:
 *
 * 1. System Settings → Users & Groups → Add User (e.g. "voltaire")
 * 2. Log into that user via Fast User Switching
 * 3. Open Messages.app, sign in with Voltaire's Apple ID
 * 4. Set up NanoClaw launchd plist under that user
 * 5. Switch back to your main account
 *
 * Set these in .env:
 *   IMESSAGE_HANDLE=voltaire@yourdomain.com
 *   IMESSAGE_CHAT_DB=/Users/voltaire/Library/Messages/chat.db
 *   IMESSAGE_USER=voltaire    # macOS username for osascript -u
 *
 * The second user must remain logged in (background session via Fast User
 * Switching). If they're logged out, this channel detects it and alerts
 * through the main group.
 *
 * Requires Full Disk Access for the NanoClaw process to read the other
 * user's chat.db.
 */

import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

import { ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

const JID_PREFIX = 'imessage:';
const POLL_INTERVAL_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_LENGTH = 10000;

// How long chat.db can go without being modified before we consider
// Messages.app stale. 30 minutes is generous — Messages.app writes
// frequently even when idle (read receipts, typing indicators, etc.)
const STALE_DB_THRESHOLD_MS = 30 * 60 * 1000;

interface AppleChannelConfig {
  handle: string; // iMessage handle (email or phone)
  chatDbPath: string; // Path to chat.db (may be under another user)
  macosUser?: string; // macOS username to run AppleScript as (optional)
}

export class AppleMessagesChannel implements Channel {
  name = 'apple';

  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageRowId = 0;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private opts: ChannelOpts;
  private config: AppleChannelConfig;
  private healthy = true;
  private lastHealthAlert = 0; // Timestamp of last alert (avoid spam)

  constructor(opts: ChannelOpts, config: AppleChannelConfig) {
    this.opts = opts;
    this.config = config;
  }

  async connect(): Promise<void> {
    // Check chat.db exists and is readable
    const dbCheck = this.checkChatDb();
    if (dbCheck) {
      throw new Error(dbCheck);
    }

    // Verify Messages.app is running under the target user
    const messagesCheck = await this.checkMessagesApp();
    if (messagesCheck) {
      logger.warn(
        { error: messagesCheck },
        'Apple Messages: Messages.app may not be running — will retry via health checks',
      );
      // Don't throw — allow connection but flag as unhealthy
      this.healthy = false;
    }

    // Get the latest message ROWID so we only process new messages
    try {
      this.lastMessageRowId = await this.getMaxRowId();
    } catch (err) {
      throw new Error(
        `Cannot read Messages database at ${this.config.chatDbPath}. ` +
          'Grant Full Disk Access to this process, and ensure the second ' +
          `macOS user is logged in. Error: ${err}`,
      );
    }

    this.connected = true;
    this.startPolling();
    this.startHealthChecks();
    await this.flushOutgoingQueue();

    logger.info(
      {
        handle: this.config.handle,
        chatDb: this.config.chatDbPath,
        macosUser: this.config.macosUser || '(current)',
        lastRowId: this.lastMessageRowId,
      },
      'Apple Messages channel connected',
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
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
      try {
        await this.sendViaAppleScript(handle, chunk);
      } catch (err) {
        // Detect Messages.app / user session issues
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes('not running') ||
          errMsg.includes('Connection is invalid') ||
          errMsg.includes('execution error')
        ) {
          this.reportUnhealthy(
            `Failed to send iMessage — Messages.app may not be running. ` +
              `Is the "${this.config.macosUser || 'voltaire'}" macOS user logged in? ` +
              `Error: ${errMsg}`,
          );
        }
        throw err;
      }
    }
  }

  async syncGroups(): Promise<void> {
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
            false,
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to sync Apple Messages conversations');
    }
  }

  // ── Health checks ──────────────────────────────────────────────────────

  private startHealthChecks(): void {
    const check = async () => {
      if (!this.connected) return;

      const problems: string[] = [];

      // 1. Check chat.db exists and is accessible
      const dbCheck = this.checkChatDb();
      if (dbCheck) problems.push(dbCheck);

      // 2. Check chat.db is not stale (Messages.app modifies it frequently)
      if (!dbCheck) {
        try {
          const stat = statSync(this.config.chatDbPath);
          const age = Date.now() - stat.mtimeMs;
          if (age > STALE_DB_THRESHOLD_MS) {
            problems.push(
              `Messages database hasn't been modified in ${Math.round(age / 60000)} minutes. ` +
                'Messages.app may have stopped or the user session may have ended.',
            );
          }
        } catch {
          problems.push('Cannot stat Messages database.');
        }
      }

      // 3. Check Messages.app is running
      const messagesCheck = await this.checkMessagesApp();
      if (messagesCheck) problems.push(messagesCheck);

      if (problems.length > 0) {
        this.reportUnhealthy(problems.join('\n'));
      } else if (!this.healthy) {
        // Recovered
        this.healthy = true;
        logger.info('Apple Messages: health recovered');
      }

      this.healthTimer = setTimeout(check, HEALTH_CHECK_INTERVAL_MS);
    };

    this.healthTimer = setTimeout(check, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Check if chat.db exists and is readable.
   * Returns error message string, or null if OK.
   */
  private checkChatDb(): string | null {
    if (!existsSync(this.config.chatDbPath)) {
      const user = this.config.macosUser || 'voltaire';
      return (
        `Messages database not found at ${this.config.chatDbPath}. ` +
        `The "${user}" macOS user account may not be logged in. ` +
        'Log in via Fast User Switching (System Settings → Users & Groups → Login Options), ' +
        'open Messages.app under that user, then switch back to your account. ' +
        'The background session must remain active.'
      );
    }
    return null;
  }

  /**
   * Check if Messages.app is running (for the target user if specified).
   * Returns error message string, or null if OK.
   */
  private async checkMessagesApp(): Promise<string | null> {
    return new Promise((resolve) => {
      // Check if Messages process exists
      const grepUser = this.config.macosUser
        ? `grep -c "Messages.*${this.config.macosUser}"`
        : 'grep -c Messages.app';

      execFile(
        'pgrep',
        ['-f', 'Messages.app'],
        { timeout: 5000 },
        (error, stdout) => {
          if (error || !stdout.trim()) {
            const user = this.config.macosUser || 'voltaire';
            resolve(
              `Messages.app is not running. The "${user}" macOS user ` +
                'must be logged in with Messages.app open. Log in via ' +
                'Fast User Switching, open Messages, then switch back.',
            );
          } else {
            resolve(null);
          }
        },
      );
    });
  }

  /**
   * Report an unhealthy state. Sends alert to main group, rate-limited
   * to avoid spam (max once per 30 minutes).
   */
  private reportUnhealthy(message: string): void {
    if (this.healthy) {
      this.healthy = false;
      logger.warn({ message }, 'Apple Messages channel unhealthy');
    }

    // Rate-limit alerts to once per 30 minutes
    const now = Date.now();
    if (now - this.lastHealthAlert < 30 * 60 * 1000) return;
    this.lastHealthAlert = now;

    // Find main group and send alert
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
    if (mainEntry) {
      const [mainJid] = mainEntry;
      // Don't send via this channel (it's broken) — log for other channels to pick up
      logger.error(
        {
          alert: true,
          channel: 'apple',
          mainJid,
          message: `[Apple Messages] ${message}`,
        },
        'Apple Messages health alert — needs attention',
      );
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────

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

      this.opts.onChatMetadata(jid, timestamp, handle, 'apple', false);

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

  // ── AppleScript / SQLite ───────────────────────────────────────────────

  private async sendViaAppleScript(
    handle: string,
    text: string,
  ): Promise<void> {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${handle}" of targetService
        send "${escaped}" to targetBuddy
      end tell
    `;

    // If running as a different user, use `sudo -u <user> osascript`
    // Otherwise, run osascript directly
    const cmd = this.config.macosUser ? 'sudo' : 'osascript';
    const args = this.config.macosUser
      ? ['-u', this.config.macosUser, 'osascript', '-e', script]
      : ['-e', script];

    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 15000 }, (error, _stdout, stderr) => {
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
      });
    });
  }

  private async runSqlite(
    query: string,
  ): Promise<Array<Record<string, string>>> {
    return new Promise((resolve, reject) => {
      execFile(
        'sqlite3',
        ['-json', '-readonly', this.config.chatDbPath, query],
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
  if (process.platform !== 'darwin') {
    logger.debug('Apple Messages: skipping (not macOS)');
    return null;
  }

  const env = readEnvFile([
    'IMESSAGE_HANDLE',
    'IMESSAGE_CHAT_DB',
    'IMESSAGE_USER',
  ]);

  if (!env.IMESSAGE_HANDLE) {
    logger.warn(
      'Apple Messages: IMESSAGE_HANDLE not set in .env ' +
        '(e.g. +15551234567 or voltaire@yourdomain.com)',
    );
    return null;
  }

  const chatDbPath =
    env.IMESSAGE_CHAT_DB ||
    path.join(homedir(), 'Library', 'Messages', 'chat.db');

  if (!existsSync(chatDbPath)) {
    const user = env.IMESSAGE_USER || 'voltaire';
    logger.warn(
      `Apple Messages: chat.db not found at ${chatDbPath}. ` +
        `Is the "${user}" macOS user logged in with Messages.app open?`,
    );
    return null;
  }

  return new AppleMessagesChannel(opts, {
    handle: env.IMESSAGE_HANDLE,
    chatDbPath,
    macosUser: env.IMESSAGE_USER || undefined,
  });
});
