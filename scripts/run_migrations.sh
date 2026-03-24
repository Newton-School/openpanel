#!/bin/bash
set -e

echo "Starting OpenPanel database migrations..."

# Change to app directory
cd /app

echo "Running Prisma database migrations..."
pnpm migrate:deploy

echo "Database migrations completed successfully"
echo "NOTE: Prisma code generation (pnpm db:codegen) will be handled by individual service init containers"