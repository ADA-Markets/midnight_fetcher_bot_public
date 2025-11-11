#!/bin/bash
# ============================================================================
# Midnight Fetcher Bot - Status Check
# ============================================================================
# Checks if services are running and healthy
# Usage: ./status.sh
# ============================================================================

echo ""
echo "================================================================================"
echo "                    Midnight Fetcher Bot - Status"
echo "================================================================================"
echo ""

ALL_GOOD=true

# ============================================================================
# Check Hash Server
# ============================================================================
echo "[1/2] Hash Server Status"
echo "─────────────────────────────────────────────────────────────────────────────"

if pgrep -f "hash-server" > /dev/null; then
    HASH_PID=$(pgrep -f "hash-server")
    echo "Status:   ✓ Running (PID: $HASH_PID)"

    # Check if responding
    if curl -s http://127.0.0.1:9001/health > /dev/null 2>&1; then
        echo "Health:   ✓ Responding"

        # Get health details
        HEALTH=$(curl -s http://127.0.0.1:9001/health 2>/dev/null)
        if [ -n "$HEALTH" ]; then
            echo "Details:  $HEALTH"
        fi
    else
        echo "Health:   ❌ Not responding on port 9001"
        ALL_GOOD=false
    fi

    # Show resource usage
    CPU_MEM=$(ps -p $HASH_PID -o %cpu,%mem --no-headers 2>/dev/null)
    if [ -n "$CPU_MEM" ]; then
        echo "Usage:    CPU: $(echo $CPU_MEM | awk '{print $1}')%  |  Memory: $(echo $CPU_MEM | awk '{print $2}')%"
    fi
else
    echo "Status:   ❌ Not running"
    ALL_GOOD=false
fi
echo ""

# ============================================================================
# Check Next.js
# ============================================================================
echo "[2/2] Next.js Server Status"
echo "─────────────────────────────────────────────────────────────────────────────"

if pgrep -f "next start" > /dev/null; then
    NEXTJS_PID=$(pgrep -f "next start")
    echo "Status:   ✓ Running (PID: $NEXTJS_PID)"

    # Check if responding
    if curl -s http://localhost:3001 > /dev/null 2>&1; then
        echo "Health:   ✓ Responding on port 3001"
    else
        echo "Health:   ⚠️  Not responding on port 3001 (may still be starting)"
        ALL_GOOD=false
    fi

    # Show resource usage
    CPU_MEM=$(ps -p $NEXTJS_PID -o %cpu,%mem --no-headers 2>/dev/null)
    if [ -n "$CPU_MEM" ]; then
        echo "Usage:    CPU: $(echo $CPU_MEM | awk '{print $1}')%  |  Memory: $(echo $CPU_MEM | awk '{print $2}')%"
    fi
else
    echo "Status:   ❌ Not running"
    ALL_GOOD=false
fi
echo ""

# ============================================================================
# Port Check
# ============================================================================
echo "Port Status"
echo "─────────────────────────────────────────────────────────────────────────────"
if command -v netstat > /dev/null 2>&1; then
    PORT_9001=$(netstat -tuln 2>/dev/null | grep ":9001 " | wc -l)
    PORT_3001=$(netstat -tuln 2>/dev/null | grep ":3001 " | wc -l)

    if [ "$PORT_9001" -gt 0 ]; then
        echo "Port 9001: ✓ Listening (Hash Server)"
    else
        echo "Port 9001: ❌ Not listening"
    fi

    if [ "$PORT_3001" -gt 0 ]; then
        echo "Port 3001: ✓ Listening (Next.js)"
    else
        echo "Port 3001: ❌ Not listening"
    fi
elif command -v ss > /dev/null 2>&1; then
    PORT_9001=$(ss -tuln 2>/dev/null | grep ":9001 " | wc -l)
    PORT_3001=$(ss -tuln 2>/dev/null | grep ":3001 " | wc -l)

    if [ "$PORT_9001" -gt 0 ]; then
        echo "Port 9001: ✓ Listening (Hash Server)"
    else
        echo "Port 9001: ❌ Not listening"
    fi

    if [ "$PORT_3001" -gt 0 ]; then
        echo "Port 3001: ✓ Listening (Next.js)"
    else
        echo "Port 3001: ❌ Not listening"
    fi
else
    echo "Port check: ⚠️  netstat/ss not available"
fi
echo ""

# ============================================================================
# Wallet Check
# ============================================================================
echo "Wallet Status"
echo "─────────────────────────────────────────────────────────────────────────────"
WALLET_DIR="$HOME/Documents/MidnightFetcherBot/secure"
if [ -f "$WALLET_DIR/wallet-seed.json.enc" ]; then
    echo "Wallet:   ✓ Found at $WALLET_DIR"
else
    echo "Wallet:   ℹ️  No wallet created yet"
    echo "          Create one at http://localhost:3001"
fi
echo ""

# ============================================================================
# Summary
# ============================================================================
echo "================================================================================"
if [ "$ALL_GOOD" = true ]; then
    echo "✓ All services are running and healthy"
    echo ""
    echo "📊 Access dashboard: http://localhost:3001"
else
    echo "⚠️  Some services have issues"
    echo ""
    echo "💡 Try:"
    echo "   ./stop.sh   - Stop all services"
    echo "   ./start.sh  - Start services"
    echo "   ./logs.sh   - Check logs for errors"
fi
echo "================================================================================"
echo ""
