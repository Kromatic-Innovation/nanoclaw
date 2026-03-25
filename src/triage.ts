import fs from 'fs';
import path from 'path';

import { Interceptor, HttpTriageProvider, loadConfig } from 'tickle-stick';
import type {
  AlertSink,
  BudgetStatus,
  InboundMessage,
  StorageAdapter,
  TierResult,
  TierMetrics,
} from 'tickle-stick';

import { parse as parseYaml } from 'yaml';

import { TIMEZONE } from './config.js';
import {
  insertTriageEvent,
  getTriageSpendSince,
  pruneTriageEventsBefore,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

interface NanoClawTriageProviderConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKeyEnvVar: string;
  baseUrl?: string;
  maxTokens?: number;
  timeout?: number;
}

let interceptor: Interceptor | null = null;

/** Alert sink setter — called from index.ts where channels are available. */
let alertSinkFn: AlertSink | undefined;

export function setAlertSink(sink: AlertSink): void {
  alertSinkFn = sink;
}

/** Storage adapter backed by nanoclaw's SQLite. */
const storage: StorageAdapter = {
  writeEvent: (event) => insertTriageEvent(event),
  getSpendSince: (since) => getTriageSpendSince(since),
  prune: (before) => pruneTriageEventsBefore(before),
};

export function initTriage(): void {
  // tickle-stick's loadConfig() searches tickle-stick.yaml and config/tickle-stick.yaml
  const candidates = [
    path.join(process.cwd(), 'tickle-stick.yaml'),
    path.join(process.cwd(), 'config', 'tickle-stick.yaml'),
  ];
  const configPath = candidates.find((p) => fs.existsSync(p));

  if (!configPath) {
    logger.info('No tickle-stick.yaml found, triage disabled');
    return;
  }

  try {
    const config = loadConfig(configPath);

    // Read nanoclaw-specific provider config from the YAML (outside tickle-stick schema)
    const rawYaml = fs.readFileSync(configPath, 'utf-8');
    const fullConfig = parseYaml(rawYaml) as {
      triageProvider?: NanoClawTriageProviderConfig;
    };

    let triageProvider: HttpTriageProvider | undefined;

    if (fullConfig.triageProvider) {
      const providerCfg = fullConfig.triageProvider;
      const env = readEnvFile([providerCfg.apiKeyEnvVar]);
      const apiKey = env[providerCfg.apiKeyEnvVar];

      if (apiKey) {
        triageProvider = new HttpTriageProvider({
          apiKey,
          model: providerCfg.model,
          provider: providerCfg.provider,
          baseUrl: providerCfg.baseUrl,
          maxTokens: providerCfg.maxTokens,
          timeout: providerCfg.timeout,
        });
        logger.info(
          { provider: providerCfg.provider, model: providerCfg.model },
          'Triage Tier 1 provider configured',
        );
      } else {
        logger.warn(
          { envVar: providerCfg.apiKeyEnvVar },
          'Triage provider configured but API key not found in .env, Tier 1 disabled',
        );
      }
    }

    interceptor = new Interceptor({
      config,
      triageProvider,
      storage,
      alertSink: (alert) => alertSinkFn?.(alert),
      timezone: TIMEZONE,
    });

    // Prune old triage events at startup
    interceptor
      .pruneBudgetEvents()
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Pruned old triage events');
      })
      .catch(() => {});

    logger.info('Triage interceptor initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize triage, continuing without it');
  }
}

/** Return current budget status, or null if triage/budget not configured. */
export async function getBudgetStatus(): Promise<BudgetStatus | null> {
  return interceptor?.getBudgetStatus() ?? null;
}

/** Return session-level triage metrics, or null if triage not initialized. */
export function getTriageMetrics(): TierMetrics | null {
  return interceptor?.getMetrics() ?? null;
}

/**
 * Run triage on the last message in the batch.
 * Returns a TierResult if triage handled the message (deflect or human),
 * or null if the message should pass through to the full agent.
 */
export async function triageMessage(
  messages: NewMessage[],
  chatJid: string,
  channelName: string,
): Promise<TierResult | null> {
  if (!interceptor || messages.length === 0) return null;

  const lastMsg = messages[messages.length - 1];

  const inbound: InboundMessage = {
    id: lastMsg.id,
    channel: channelName,
    from: lastMsg.sender,
    body: lastMsg.content,
    timestamp: new Date(lastMsg.timestamp),
    metadata: {
      sender_name: lastMsg.sender_name,
      chat_jid: chatJid,
      is_from_me: lastMsg.is_from_me,
    },
  };

  try {
    const result = await interceptor.process(inbound);

    logger.debug(
      {
        tier: result.tier,
        action: result.action,
        cost: result.costEstimate,
        latencyMs: result.latencyMs,
        budgetExceeded: interceptor.isBudgetExceeded(),
      },
      'Triage result',
    );

    return result;
  } catch (err) {
    logger.error({ err }, 'Triage processing error, falling through to agent');
    return null;
  }
}
