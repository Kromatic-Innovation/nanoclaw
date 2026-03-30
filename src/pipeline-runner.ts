import fs from 'fs';
import path from 'path';

import {
  Pipeline,
  HttpTriageProvider,
  loadConfig,
  type AlertSink,
  type BudgetStatus,
  type PipelineResult,
  type StorageAdapter,
  type TierMetrics,
  type ClassifiedItem,
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

interface NanoClawTriageProviderConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKeyEnvVar: string;
  baseUrl?: string;
  maxTokens?: number;
  timeout?: number;
}

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

/** Cached provider and config for reuse across pipeline runs. */
let triageProvider: HttpTriageProvider | undefined;
let configLoaded = false;
let budgetConfig:
  | {
      maxDailySpend?: number;
      maxWeeklySpend?: number;
      alerts: { at: string | number }[];
      retentionDays: number;
    }
  | undefined;
let pipelineConfigs: Record<
  string,
  import('tickle-stick').PipelineConfigEntry
> = {};
let telemetryConfig: import('tickle-stick').TelemetryConfig = {
  enabled: true,
  format: 'json',
};

/** Shared metrics pipeline for /budget command. */
let lastPipeline: Pipeline | null = null;

export function initPipelines(): void {
  const candidates = [
    path.join(process.cwd(), 'tickle-stick.yaml'),
    path.join(process.cwd(), 'config', 'tickle-stick.yaml'),
  ];
  const configPath = candidates.find((p) => fs.existsSync(p));

  if (!configPath) {
    logger.info('No tickle-stick.yaml found, pipelines disabled');
    return;
  }

  try {
    const config = loadConfig(configPath);
    pipelineConfigs = config.tickleStick.pipelines;
    telemetryConfig = config.tickleStick.telemetry;
    budgetConfig = config.tickleStick.budget;

    // Override budget from config/private.yaml if it exists
    const privatePath = path.join(process.cwd(), 'config', 'private.yaml');
    if (fs.existsSync(privatePath)) {
      const privateConfig = parseYaml(
        fs.readFileSync(privatePath, 'utf-8'),
      ) as { budget?: { maxDailySpend?: number; maxWeeklySpend?: number } };
      if (privateConfig?.budget && budgetConfig) {
        if (privateConfig.budget.maxDailySpend != null) {
          budgetConfig.maxDailySpend = privateConfig.budget.maxDailySpend;
        }
        if (privateConfig.budget.maxWeeklySpend != null) {
          budgetConfig.maxWeeklySpend = privateConfig.budget.maxWeeklySpend;
        }
        logger.info(
          {
            maxDailySpend: budgetConfig.maxDailySpend,
            maxWeeklySpend: budgetConfig.maxWeeklySpend,
          },
          'Budget overridden from config/private.yaml',
        );
      }
    }

    // Read nanoclaw-specific provider config from the YAML (outside tickle-stick schema)
    const rawYaml = fs.readFileSync(configPath, 'utf-8');
    const fullConfig = parseYaml(rawYaml) as {
      triageProvider?: NanoClawTriageProviderConfig;
    };

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
          'Pipeline Tier 1 provider configured',
        );
      } else {
        logger.warn(
          { envVar: providerCfg.apiKeyEnvVar },
          'Triage provider configured but API key not found, Tier 1 disabled',
        );
      }
    }

    const pipelineNames = Object.keys(pipelineConfigs);
    if (pipelineNames.length > 0) {
      logger.info({ pipelines: pipelineNames }, 'Pipelines loaded');
    } else {
      logger.info('No pipelines defined in tickle-stick.yaml');
    }

    configLoaded = true;

    // Prune old events at startup (best-effort)
    if (budgetConfig) {
      const cutoff = new Date(
        Date.now() - (budgetConfig.retentionDays ?? 30) * 86400000,
      ).toISOString();
      const count = storage.prune(cutoff) as number;
      if (count > 0) logger.info({ count }, 'Pruned old pipeline events');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initialize pipelines');
  }
}

/**
 * Run a named pipeline. Called from the task scheduler when a task prompt
 * starts with "pipeline:".
 *
 * @param pipelineName - Name of the pipeline (e.g. "daily-briefing")
 * @param onTier2 - Callback for Tier 2 reasoning (host provides container/model)
 * @param onTier3 - Callback for Tier 3 human escalation (host provides channel)
 */
export async function runPipeline(
  pipelineName: string,
  onTier2?: (items: ClassifiedItem[], prompt: string) => Promise<string>,
  onTier3?: (items: ClassifiedItem[]) => Promise<void>,
  options?: {
    extraTier0Args?: string[];
    onClassified?: (items: ClassifiedItem[]) => void;
  },
): Promise<PipelineResult> {
  let pipelineConfig = pipelineConfigs[pipelineName];
  if (!pipelineConfig) {
    throw new Error(`Pipeline not found: ${pipelineName}`);
  }

  // Inject extra tier0 args (e.g., --repo for pre-filtering)
  if (options?.extraTier0Args?.length && pipelineConfig.tier0) {
    pipelineConfig = {
      ...pipelineConfig,
      tier0: {
        ...pipelineConfig.tier0,
        args: [...pipelineConfig.tier0.args, ...options.extraTier0Args],
      },
    };
  }

  const pipeline = new Pipeline({
    name: pipelineName,
    config: pipelineConfig,
    telemetry: telemetryConfig,
    triageProvider,
    onClassified: options?.onClassified,
    onTier2,
    onTier3,
    storage,
    alertSink: (alert) => alertSinkFn?.(alert),
    budgetConfig,
    timezone: TIMEZONE,
  });

  lastPipeline = pipeline;

  const result = await pipeline.run();

  logger.info(
    {
      pipeline: pipelineName,
      tier0Items: result.tier0Items,
      tier1Classified: result.tier1Classified,
      tier2Escalated: result.tier2Escalated,
      tier3Human: result.tier3Human,
      cost: result.costEstimate,
      latencyMs: result.latencyMs,
    },
    'Pipeline completed',
  );

  return result;
}

/** Check if a pipeline name exists. */
export function hasPipeline(name: string): boolean {
  return name in pipelineConfigs;
}

/** Return raw Tier 2 prompt template with {{items}} placeholder intact. */
export function getPipelinePromptTemplate(pipelineName: string): string | null {
  const config = pipelineConfigs[pipelineName];
  return config?.tier2?.prompt ?? null;
}

/** Return current budget status, or null if budget not configured. */
export async function getBudgetStatus(): Promise<BudgetStatus | null> {
  return lastPipeline?.getBudgetStatus() ?? null;
}

/** Return pipeline metrics, or null if no pipeline has run. */
export function getPipelineMetrics(): TierMetrics | null {
  return lastPipeline?.getMetrics() ?? null;
}

/**
 * Format a PipelineResult into a human-readable report for delivery.
 */
export function formatPipelineReport(result: PipelineResult): string {
  const lines: string[] = [];

  if (result.tier0Items === 0) {
    lines.push(`Pipeline "${result.pipeline}": no new items found.`);
    return lines.join('\n');
  }

  lines.push(`Pipeline "${result.pipeline}": ${result.tier0Items} items found`);

  if (result.routineReport) {
    lines.push('', 'Routine items:', result.routineReport);
  }

  if (result.reasoningReport) {
    lines.push('', result.reasoningReport);
  }

  if (result.humanItems && result.humanItems.length > 0) {
    lines.push(
      '',
      `${result.humanItems.length} item(s) need human attention:`,
      ...result.humanItems.map((item) => `- [${item.source}] ${item.summary}`),
    );
  }

  lines.push(
    '',
    `Cost: $${result.costEstimate.toFixed(4)} | Items: T0=${result.tier0Items} T1=${result.tier1Classified} T2=${result.tier2Escalated} T3=${result.tier3Human}`,
  );

  return lines.join('\n');
}
