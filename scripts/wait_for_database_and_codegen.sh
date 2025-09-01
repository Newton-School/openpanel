#!/bin/bash
set -e

echo "Starting database wait and Prisma codegen process..."

# Change to app directory
cd /app

# Run the Node.js waiter script
node scripts/wait_for_database_and_codegen.js "$@"

echo "Database wait and codegen completed successfully"