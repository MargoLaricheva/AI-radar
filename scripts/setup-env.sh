#!/usr/bin/env bash
# Генерация .env из .env.example с секретами (chmod 600)
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env уже существует, пропускаю генерацию"
  exit 0
fi

DB_PASS="$(openssl rand -hex 16)"
SESSION_KEY="$(openssl rand -hex 32)"

cp .env.example .env
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://radar:${DB_PASS}@db:5432/radar|" .env
sed -i "s|^SESSION_KEY=.*|SESSION_KEY=${SESSION_KEY}|" .env

chmod 600 .env
echo ".env создан: BOT_TOKEN и LLM_API_KEY впишите вручную (chmod 600)"
