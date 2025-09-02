#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const DEFAULT_TIMEOUT = 180000; // 3 minutes in milliseconds
const CHECK_INTERVAL = 2000; // 2 seconds
const STABLE_DURATION = 5000; // 5 seconds

class DatabaseWaiter {
  constructor(options = {}) {
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.checkInterval = options.checkInterval || CHECK_INTERVAL;
    this.stableDuration = options.stableDuration || STABLE_DURATION;
    this.startTime = Date.now();
    this.connectionStableStart = null;
    this.prisma = null;
  }

  async log(message) {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    console.log(`[${elapsed}s] ${message}`);
  }

  async checkTimeout() {
    const elapsed = Date.now() - this.startTime;
    if (elapsed >= this.timeout) {
      throw new Error(`Timeout after ${Math.floor(elapsed / 1000)}s waiting for database`);
    }
  }

  async testConnection() {
    try {
      if (!this.prisma) {
        this.prisma = new PrismaClient();
      }
      
      // Test basic connection
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      if (this.prisma) {
        await this.prisma.$disconnect();
        this.prisma = null;
      }
      throw error;
    }
  }

  async checkPendingMigrations() {
    try {
      // Check if there are pending migrations by trying to query migration status
      // This is a simplified check - in production you might want more sophisticated logic
      const result = await this.prisma.$queryRaw`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_name = '_prisma_migrations'
        ) as migration_table_exists
      `;
      
      if (result[0].migration_table_exists) {
        // Check for failed migrations
        const failedMigrations = await this.prisma.$queryRaw`
          SELECT * FROM _prisma_migrations 
          WHERE finished_at IS NULL AND started_at IS NOT NULL
        `;
        
        if (failedMigrations.length > 0) {
          throw new Error('Found failed migrations. Database migrations may still be running.');
        }
      }
      
      return true;
    } catch (error) {
      if (error.message.includes('relation "_prisma_migrations" does not exist')) {
        throw new Error('Migration table does not exist. Migrations may not have been run yet.');
      }
      throw error;
    }
  }

  async waitForStableConnection() {
    this.log('Checking for valid database connection...');
    
    while (true) {
      await this.checkTimeout();
      
      try {
        await this.testConnection();
        
        if (!this.connectionStableStart) {
          this.connectionStableStart = Date.now();
          this.log('Database connection established, checking stability...');
        }
        
        const stableFor = Date.now() - this.connectionStableStart;
        this.log(`Connection stable for ${Math.floor(stableFor / 1000)}s`);
        
        if (stableFor >= this.stableDuration) {
          this.log('Database connection is stable');
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, this.checkInterval));
        
      } catch (error) {
        this.connectionStableStart = null;
        this.log(`Waiting for database (${error.message})`);
        await new Promise(resolve => setTimeout(resolve, this.checkInterval));
      }
    }
  }

  async waitForMigrations() {
    this.log('Checking for pending migrations...');
    
    while (true) {
      await this.checkTimeout();
      
      try {
        await this.checkPendingMigrations();
        this.log('No pending migrations found');
        break;
      } catch (error) {
        this.log(`Waiting for migrations to complete (${error.message})`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s for migrations
      }
    }
  }

  async runPrismaCodegen() {
    this.log('Running Prisma code generation...');
    try {
      const { stdout, stderr } = await execAsync('pnpm db:codegen');
      if (stdout) this.log(`Codegen stdout: ${stdout.trim()}`);
      if (stderr) this.log(`Codegen stderr: ${stderr.trim()}`);
      this.log('Prisma code generation completed successfully');
    } catch (error) {
      this.log(`Prisma codegen failed: ${error.message}`);
      throw error;
    }
  }

  async cleanup() {
    if (this.prisma) {
      await this.prisma.$disconnect();
    }
  }

  async wait() {
    try {
      await this.waitForStableConnection();
      await this.waitForMigrations();
      await this.runPrismaCodegen();
      this.log('Database is ready and Prisma client generated successfully');
      this.log('NOTE: This init container waits for migrations (run by migration pod) and generates Prisma client per service');
    } finally {
      await this.cleanup();
    }
  }
}

// CLI handling
async function main() {
  const args = process.argv.slice(2);
  
  // Parse basic arguments
  let timeout = DEFAULT_TIMEOUT;
  const timeoutArg = args.find(arg => arg.startsWith('--timeout='));
  if (timeoutArg) {
    timeout = parseInt(timeoutArg.split('=')[1]) * 1000;
  }

  const waiter = new DatabaseWaiter({ timeout });
  
  try {
    await waiter.wait();
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { DatabaseWaiter };