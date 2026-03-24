## Had to install these locally

# Install deps (workspace + db package)
pnpm add -w -D jiti
pnpm add -w -D prisma
pnpm add -w -D dotenv-cli
pnpm add -D prisma -F db
pnpm add @prisma/client -F db
pnpm add -D prisma-json-types-generator -F db
