#!/usr/bin/env node

// Zero external dependencies — uses only Node.js built-ins + prisma CLI.
// wait_for_migration.sh runs this from /app/packages/db (cwd).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT = 180000;
const CHECK_INTERVAL = 2000;
const STABLE_DURATION = 5000;

const PRISMA = 'node_modules/.bin/prisma';
const SCHEMA = 'prisma/schema.prisma';

function runPrisma(args, { stdin } = {}) {
  const result = spawnSync(PRISMA, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    input: stdin,
    timeout: 10000,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function checkConnection() {
  const result = runPrisma(['db', 'execute', '--stdin', '--schema', SCHEMA], { stdin: 'SELECT 1;' });
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(output || 'Prisma connection check failed');
  }
}

function checkMigrations() {
  const result = runPrisma(['migrate', 'status', '--schema', SCHEMA]);
  const output = `${result.stdout}${result.stderr}`;

  if (result.status === 0) {
    if (
      output.includes('up to date') ||
      output.includes('No pending migrations') ||
      (output.includes('migrations found in prisma/migrations') && !output.includes('following migration'))
    ) {
      return;
    }

    throw new Error(`Unrecognized prisma migrate status success output: ${output.slice(0, 200)}`);
  }

  if (output.includes('have not yet been applied')) {
    throw new Error('Pending migrations not yet applied');
  }

  if (output.includes('failed migration') || output.includes('was modified after it was applied')) {
    throw new Error(output.slice(0, 200));
  }

  throw new Error(output.slice(0, 200));
}

async function wait({ timeout = DEFAULT_TIMEOUT } = {}) {
  const start = Date.now();
  const elapsed = () => Math.floor((Date.now() - start) / 1000);
  const log = (msg) => console.log(`[${elapsed()}s] ${msg}`);
  const timedOut = () => Date.now() - start >= timeout;

  // 1. Wait for a usable database connection
  log('Waiting for database connectivity...');
  let stableStart = null;
  while (true) {
    if (timedOut()) throw new Error(`Timeout after ${elapsed()}s waiting for database`);
    try {
      checkConnection();
      if (!stableStart) {
        stableStart = Date.now();
        log('Database connection established, checking stability...');
      }
      const stableFor = Date.now() - stableStart;
      if (stableFor >= STABLE_DURATION) {
        log('Database connection is stable');
        break;
      }
    } catch (e) {
      stableStart = null;
      log(`Waiting for database (${e.message})`);
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }

  // 2. Wait for migrations to complete
  log('Checking for pending migrations...');
  while (true) {
    if (timedOut()) throw new Error(`Timeout after ${elapsed()}s waiting for migrations`);
    try {
      checkMigrations();
      log('No pending migrations found');
      break;
    } catch (e) {
      log(`Waiting for migrations (${e.message})`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  log('Database is ready');
}

async function main() {
  const args = process.argv.slice(2);
  const timeoutArg = args.find(a => a.startsWith('--timeout='));
  const timeout = timeoutArg ? parseInt(timeoutArg.split('=')[1]) * 1000 : DEFAULT_TIMEOUT;

  try {
    await wait({ timeout });
    process.exit(0);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
