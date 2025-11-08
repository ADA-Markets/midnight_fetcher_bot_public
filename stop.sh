#!/bin/bash
# "============================================================================"
# "Midnight Fetcher Bot - Quick Stop"
# "============================================================================"
# "This script stop the hash server and Next.js dev server"
# "Run setup.sh first if this is your first time!"
# "============================================================================"

set -e  # Exit on error

echo "Stopping services..."
killall -w -e "npm start" 2>/dev/null || true
killall -w -e "hash-server" 2>/dev/null || true
killall -w "next-server" 2>/dev/null || true
echo "Services stopped."
