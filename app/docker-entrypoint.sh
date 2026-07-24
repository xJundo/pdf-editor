#!/bin/sh
set -e

node /app/migrate/migrate.mjs
exec node /app/server.js
