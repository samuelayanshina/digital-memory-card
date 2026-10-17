import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Zero-dependency .env loader so local and VPS deployments pick up .env automatically
// (Skipped during `node --test` so automated unit tests do not send live Telegram pings)
const isTestRunner =
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.execArgv.includes('--test') ||
  process.argv.some((a) => a.includes('.test.')) ||
  process.env.NODE_ENV === 'test';
if (!isTestRunner) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch {
    // Ignore .env read errors
  }
}

const GB = 1024 * 1024 * 1024;

export const STORAGE_PLANS = {
  free: {
    id: 'free',
    name: 'Starter Digital Card',
    badge: 'FREE STARTER',
    quotaBytes: 5 * GB,
    quotaLabel: '5 GB',
    priceNaira: 0,
    priceLabel: 'Free Forever',
    durationDays: 3650,
    features: [
      '5 GB Instant Browser Storage',
      'HTTP 206 Movie & Music Streaming (0B Local Space)',
      'SHA-256 Instant Zero-Data Deduplication',
      'Local Wi-Fi Zero-Data P2P Transfer'
    ]
  },
  student: {
    id: 'student',
    name: 'Student Sachet Card',
    badge: 'STUDENT SACHET',
    quotaBytes: 20 * GB,
    quotaLabel: '20 GB',
    priceNaira: 250,
    priceLabel: '₦250 / month',
    durationDays: 30,
    features: [
      '20 GB High-Speed Digital Memory Card',
      'Full-Screen Native iPhone & Android Streaming',
      'PIN-Locked Private Vault Folder',
      'Zero-Data Instant Upload for Shared Movies'
    ]
  },
  standard: {
    id: 'standard',
    name: 'Everyday 50GB Card',
    badge: 'MOST POPULAR',
    quotaBytes: 50 * GB,
    quotaLabel: '50 GB',
    priceNaira: 500,
    priceLabel: '₦500 / month',
    durationDays: 30,
    features: [
      '50 GB Expandable Digital Memory Card',
      'Mount as Physical Drive in Mac Finder & Windows',
      'PIN-Locked Private Vault + Priority Streaming',
      'Cross-Device Sync (iPhone + Android + Laptop)'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Dev & Creator 150GB Card',
    badge: 'DEV & CREATOR PRO',
    quotaBytes: 150 * GB,
    quotaLabel: '150 GB',
    priceNaira: 1200,
    priceLabel: '₦1,200 / month',
    durationDays: 30,
    features: [
      '150 GB Heavy-Duty Storage (Xcode, Repos, 4K Media)',
      'Direct macOS Finder & Windows Z: Drive WebDAV Mount',
      'Unlimited Local Wi-Fi P2P Device Transfers',
      'Priority Bandwidth & Checksum Verification'
    ]
  }
};

export const APP_CONFIG = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  appSecret: process.env.APP_SECRET || 'cardng-super-secret-hmac-key-2026-nigeria',
  storageRoot: process.env.STORAGE_ROOT || './storage',
  merchant: {
    opay: {
      bankName: 'OPay Digital Services',
      accountNumber: process.env.OPAY_ACCOUNT_NUMBER || '8114587431',
      accountName: process.env.OPAY_ACCOUNT_NAME || 'MAYORKUN SAMUEL AYANSHINA'
    },
    palmpay: {
      bankName: 'PalmPay',
      accountNumber: process.env.PALMPAY_ACCOUNT_NUMBER || '8114587431',
      accountName: process.env.PALMPAY_ACCOUNT_NAME || 'MAYORKUN SAMUEL AYANSHINA'
    }
  },
  adminPin: process.env.ADMIN_PIN || '',
  paystack: {
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    secretKey: process.env.PAYSTACK_SECRET_KEY || ''
  },
  alertWebhookSecret: process.env.ALERT_WEBHOOK_SECRET || '',
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
  }
};
