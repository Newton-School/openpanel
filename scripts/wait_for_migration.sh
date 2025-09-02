#!/bin/bash
set -e

echo "Waiting for database migrations ..."

# Change to app directory
cd /app

# Run the Node.js waiter script
node scripts/wait_for_migration.js "$@"

echo "Migration waiter completed successfully"
