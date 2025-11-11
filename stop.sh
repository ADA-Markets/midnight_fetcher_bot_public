#!/bin/bash
# ============================================================================
# Midnight Fetcher Bot - Stop Services
# ============================================================================
# Stops hash server and Next.js
# Usage: ./stop.sh
# ============================================================================

echo ""
echo "================================================================================"
echo "                    Stopping Midnight Fetcher Bot"
echo "================================================================================"
echo ""

STOPPED_ANY=false

# Stop Next.js
if pgrep -f "next start" > /dev/null; then
    echo "Stopping Next.js server..."
    pkill -f "next start"
    sleep 2

    # Force kill if still running
    if pgrep -f "next start" > /dev/null; then
        echo "  Force killing Next.js..."
        pkill -9 -f "next start"
    fi
    echo "  ✓ Next.js stopped"
    STOPPED_ANY=true
else
    echo "Next.js is not running"
fi

# Stop hash server
if pgrep -f "hash-server" > /dev/null; then
    echo "Stopping hash server..."
    pkill -f "hash-server"
    sleep 2

    # Force kill if still running
    if pgrep -f "hash-server" > /dev/null; then
        echo "  Force killing hash server..."
        pkill -9 -f "hash-server"
    fi
    echo "  ✓ Hash server stopped"
    STOPPED_ANY=true
else
    echo "Hash server is not running"
fi

# Clean up any suspended background jobs in current shell
jobs -p 2>/dev/null | xargs kill 2>/dev/null || true

echo ""
if [ "$STOPPED_ANY" = true ]; then
    echo "✓ All services stopped successfully"
else
    echo "ℹ️  No services were running"
fi
echo ""
