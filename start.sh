#!/bin/bash
# ============================================================================
# Midnight Fetcher Bot - Start Services
# ============================================================================
# Starts hash server and Next.js in background
# Usage: ./start.sh [workers]
#   workers: Number of CPU threads (default: auto-detect, max: 32)
# Examples:
#   ./start.sh        # Auto-detect CPU cores
#   ./start.sh 16     # Use 16 workers
#   WORKERS=24 ./start.sh  # Use 24 workers via env var
# ============================================================================

set -e

cd "$(dirname "$0")"

# Auto-detect CPU cores, allow override via argument or env var
WORKERS=${1:-${WORKERS:-$(nproc)}}
# Cap at 32 to avoid excessive memory usage
if [ "$WORKERS" -gt 32 ]; then
    WORKERS=32
fi

echo ""
echo "================================================================================"
echo "                    Starting Midnight Fetcher Bot"
echo "================================================================================"
echo ""
echo "Using $WORKERS worker threads (detected $(nproc) CPU cores)"
echo ""

# ============================================================================
# Check if services are already running
# ============================================================================
if pgrep -f "hash-server" > /dev/null; then
    echo "⚠️  Hash server is already running"
    echo "   Use './stop.sh' first if you want to restart"
    echo ""
else
    # Start hash server
    echo "[1/2] Starting hash server..."

    # Check if binary exists
    if [ ! -f "hashengine/target/release/hash-server" ]; then
        echo "❌ ERROR: Hash server binary not found!"
        echo "   Run './setup.sh' first to build the project"
        exit 1
    fi

    # Set environment variables
    export RUST_LOG=hash_server=info,actix_web=warn
    export HOST=127.0.0.1
    export PORT=9001
    export WORKERS=$WORKERS

    # Start in background
    nohup ./hashengine/target/release/hash-server > logs/hash-server.log 2>&1 &
    HASH_PID=$!
    echo "   ✓ Hash server started (PID: $HASH_PID)"

    # Wait for hash server to be ready
    echo "   Waiting for hash server to initialize..."
    sleep 3

    MAX_RETRIES=10
    RETRY_COUNT=0
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if curl -s http://127.0.0.1:9001/health > /dev/null 2>&1; then
            echo "   ✓ Hash server is ready!"
            break
        fi
        sleep 2
        RETRY_COUNT=$((RETRY_COUNT + 1))
    done

    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        echo "   ❌ Hash server failed to start. Check logs/hash-server.log"
        exit 1
    fi
    echo ""
fi

# ============================================================================
# Start Next.js
# ============================================================================
if pgrep -f "next start" > /dev/null; then
    echo "⚠️  Next.js server is already running"
    echo ""
else
    echo "[2/2] Starting Next.js server..."

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        echo "❌ ERROR: Dependencies not installed!"
        echo "   Run './setup.sh' first to install dependencies"
        exit 1
    fi

    # Start Next.js in background
    nohup npm start > logs/nextjs.log 2>&1 &
    NEXTJS_PID=$!
    echo "   ✓ Next.js server started (PID: $NEXTJS_PID)"

    # Wait for Next.js to be ready
    echo "   Waiting for Next.js to initialize..."
    sleep 8

    # Check if it's responding
    if curl -s http://localhost:3001 > /dev/null 2>&1; then
        echo "   ✓ Next.js server is ready!"
    else
        echo "   ⚠️  Next.js may still be starting. Check logs/nextjs.log if issues persist."
    fi
    echo ""
fi

# ============================================================================
# Summary
# ============================================================================
echo "================================================================================"
echo "                    Services Started Successfully!"
echo "================================================================================"
echo ""
echo "📊 Web Dashboard:  http://localhost:3001"
echo "🔧 Hash Service:   http://127.0.0.1:9001/health"
echo ""
echo "💡 Useful commands:"
echo "   ./status.sh  - Check service status"
echo "   ./logs.sh    - View live logs"
echo "   ./stop.sh    - Stop all services"
echo ""
echo "📁 Data location:  ~/Documents/MidnightFetcherBot/"
echo "================================================================================"
echo ""
