#!/bin/bash

# MEET Diagnostic Script
# Run this to troubleshoot 502 Bad Gateway and other issues

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  MEET Diagnostic Tool${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check if we're in the right directory
if [ ! -f "docker-compose.proxy.yml" ]; then
    echo -e "${RED}Error: Run this script from the MEET directory${NC}"
    exit 1
fi

# Check .env file
echo -e "${BOLD}1. Checking .env configuration...${NC}"
if [ -f ".env" ]; then
    echo -e "${GREEN}✓${NC} .env file exists"
    echo ""
    cat .env
    echo ""
else
    echo -e "${RED}✗${NC} .env file missing!"
    echo "  Run ./install.sh to create it"
    exit 1
fi

# Check container status
echo -e "${BOLD}2. Checking container status...${NC}"
echo ""
docker compose -f docker-compose.proxy.yml ps -a
echo ""

# Check if livekit is running
LIVEKIT_STATUS=$(docker compose -f docker-compose.proxy.yml ps livekit --format "{{.Status}}" 2>/dev/null || echo "not found")
if [[ "$LIVEKIT_STATUS" == *"Up"* ]]; then
    echo -e "${GREEN}✓${NC} LiveKit container is running"
else
    echo -e "${RED}✗${NC} LiveKit container is NOT running or unhealthy"
    echo -e "  Status: $LIVEKIT_STATUS"
fi

# Check LiveKit logs
echo ""
echo -e "${BOLD}3. LiveKit container logs (last 30 lines):${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker compose -f docker-compose.proxy.yml logs --tail=30 livekit 2>&1 || echo "Could not get logs"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check Caddy logs
echo -e "${BOLD}4. Caddy container logs (last 20 lines):${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
docker compose -f docker-compose.proxy.yml logs --tail=20 caddy 2>&1 || echo "Could not get logs"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Test internal connectivity from Caddy to LiveKit
echo -e "${BOLD}5. Testing internal connectivity (Caddy → LiveKit):${NC}"
CONNECTIVITY_TEST=$(docker compose -f docker-compose.proxy.yml exec -T caddy wget -q --spider --timeout=5 http://livekit:7880/ 2>&1 && echo "success" || echo "failed")
if [ "$CONNECTIVITY_TEST" = "success" ]; then
    echo -e "${GREEN}✓${NC} Caddy can reach LiveKit internally"
else
    echo -e "${RED}✗${NC} Caddy CANNOT reach LiveKit internally"
    echo "  This is why you're getting 502 Bad Gateway"
    echo ""
    echo "  Trying alternative test..."
    docker compose -f docker-compose.proxy.yml exec -T caddy sh -c "nc -zv livekit 7880 2>&1" || echo "  nc not available, trying curl..."
    docker compose -f docker-compose.proxy.yml exec -T caddy sh -c "curl -s --connect-timeout 5 http://livekit:7880/ 2>&1" || echo "  curl failed too"
fi
echo ""

# Check network
echo -e "${BOLD}6. Docker network inspection:${NC}"
NETWORK_NAME=$(docker compose -f docker-compose.proxy.yml config --format json 2>/dev/null | grep -o '"meet-network"' | head -1 || echo "meet_meet-network")
docker network inspect meet_meet-network 2>/dev/null | grep -A2 '"Name":' | head -20 || \
docker network inspect meet-network 2>/dev/null | grep -A2 '"Name":' | head -20 || \
echo "Could not inspect network"
echo ""

# Check ports
echo -e "${BOLD}7. Port bindings:${NC}"
echo "  LiveKit ports:"
docker compose -f docker-compose.proxy.yml port livekit 7880 2>/dev/null || echo "    Port 7880 not mapped"
echo ""

# Server's public IP
echo -e "${BOLD}8. Server's public IP:${NC}"
PUBLIC_IP=$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s --connect-timeout 5 icanhazip.com 2>/dev/null || echo "Could not detect")
echo "  Detected: $PUBLIC_IP"
echo ""

# Summary
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Diagnostic Summary${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ "$LIVEKIT_STATUS" != *"Up"* ]]; then
    echo -e "${RED}Problem: LiveKit container is not running${NC}"
    echo ""
    echo "  Try these fixes:"
    echo "  1. Restart all containers:"
    echo "     docker compose -f docker-compose.proxy.yml down"
    echo "     docker compose -f docker-compose.proxy.yml up -d"
    echo ""
    echo "  2. If it keeps crashing, check for port conflicts:"
    echo "     sudo lsof -i :7880"
    echo "     sudo lsof -i :7881"
    echo ""
    echo "  3. Rebuild from scratch:"
    echo "     docker compose -f docker-compose.proxy.yml down -v"
    echo "     docker compose -f docker-compose.proxy.yml up -d --build --no-cache"
elif [ "$CONNECTIVITY_TEST" != "success" ]; then
    echo -e "${RED}Problem: LiveKit is running but Caddy can't reach it${NC}"
    echo ""
    echo "  Try these fixes:"
    echo "  1. Restart just Caddy:"
    echo "     docker compose -f docker-compose.proxy.yml restart caddy"
    echo ""
    echo "  2. Recreate the network:"
    echo "     docker compose -f docker-compose.proxy.yml down"
    echo "     docker network prune -f"
    echo "     docker compose -f docker-compose.proxy.yml up -d"
else
    echo -e "${GREEN}All checks passed! LiveKit should be accessible.${NC}"
    echo ""
    echo "  If you're still having issues, check:"
    echo "  - Browser console for specific errors"
    echo "  - Firewall rules (ports 443, 7881, 50000-50100/udp)"
fi
echo ""
