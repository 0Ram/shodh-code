#!/usr/bin/env bash
set -e

echo "=== Shodh a Code: Functional Evaluation ==="
npm run prisma:seed
npm run test:all
echo "=== Functional Evaluation Complete ==="
