#!/bin/bash
set -e

echo "Waiting for database migrations ..."

# Run the Node.js waiter script
cd /app/packages/db
export NODE_PATH=/app/packages/db/node_modules
node ../../scripts/wait_for_migration.js "$@"

echo "Migration waiter completed successfully"
