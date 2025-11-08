#!/bin/bash
# "============================================================================"
# "Midnight Fetcher Bot - Quick Start (After Initial Setup)"
# "============================================================================"
# "This script starts the hash server and Next.js dev server"
# "Run setup.sh first if this is your first time!"
# "============================================================================"

set -e  # Exit on error

# Check if hash server binary exists
if [ ! -x "hashengine/target/release/hash-server" ]; then
    echo ""
    echo "============================================================================"
    echo "ERROR: Hash server not built yet!"
    echo "Please run setup.cmd first to build everything."
    echo "============================================================================"
    echo ""
    exit 1
fi

# Check it it's already running
if pgrep -f "hash-server"
then
    echo ""
    echo "============================================================================"
    echo "ERROR: Hash server already running on PID $(pgrep -f 'hash-server')!"
    echo "============================================================================"
    echo ""
    exit 1
fi

# Check it it's already running
if pgrep -f "npm start"
then
    echo ""
    echo "============================================================================"
    echo "ERROR: Next.js server already running on PID $(pgrep -f 'npm start')!"
    echo "============================================================================"
    echo ""
    exit 1
fi

# Start hash server in background
echo "Starting hash server on port 9001..."
export RUST_LOG=hash_server=info,actix_web=warn
export HOST=127.0.0.1
export PORT=9001
export WORKERS=12

nohup ./hashengine/target/release/hash-server > logs/hash-server.log 2>&1 &
HASH_SERVER_PID=$!
echo "  - Hash server started (PID: $HASH_SERVER_PID)"
echo ""

# Check if hash server is responding
MAX_RETRIES=10
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://$HOST:$PORT/health > /dev/null 2>&1; then
        echo "  - Hash server is ready!"
        break
    fi
    echo "  - Waiting for hash server..."
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "ERROR: Hash server failed to start. Check logs/hash-server.log"
    exit 1
fi
echo ""

# Start NextJS production server
echo "Starting Next.js production server..."
npm start &
NEXTJS_PID=$!
echo "  - Next.js server starting (PID: $NEXTJS_PID)..."
echo ""

# Wait for Next.js to be ready
echo "Waiting for Next.js to initialize..."
sleep 5
echo "  - Next.js server is ready!"
echo ""

echo ""
echo "================================================================================"
echo "Both services are running!"
echo "Hash Server PID: $HASH_SERVER_PID"
echo "Next.js PID: $NEXTJS_PID"
echo "================================================================================"
