import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const KEYCHAIN_SERVICE = 'nanoclaw';

/**
 * Read a single value from macOS Keychain.
 * Returns the value or empty string if not found / not on macOS.
 */
function readKeychain(account: string): string {
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Parse the .env file and return values for the requested keys.
 * Falls back to macOS Keychain for any keys not found in .env.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  // Phase 1: read from .env file
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!wanted.has(key)) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) result[key] = value;
    }
  } catch {
    logger.debug('.env file not found, trying keychain');
  }

  // Phase 2: keychain fallback for any missing keys
  for (const key of keys) {
    if (result[key]) continue;
    const value = readKeychain(key);
    if (value) {
      result[key] = value;
      logger.debug({ key }, 'Loaded from keychain');
    }
  }

  return result;
}
