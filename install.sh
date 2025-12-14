#!/bin/bash

# MEET - Video Conferencing Platform Installer
# https://github.com/CyberTechArmor/MEET

set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# ASCII Banner
print_banner() {
    echo -e "${CYAN}"
    cat << "EOF"

    ███╗   ███╗███████╗███████╗████████╗
    ████╗ ████║██╔════╝██╔════╝╚══██╔══╝
    ██╔████╔██║█████╗  █████╗     ██║
    ██║╚██╔╝██║██╔══╝  ██╔══╝     ██║
    ██║ ╚═╝ ██║███████╗███████╗   ██║
    ╚═╝     ╚═╝╚══════╝╚══════╝   ╚═╝

    Video Conferencing Platform
    ─────────────────────────────────────

EOF
    echo -e "${NC}"
}

# Check dependencies
check_dependencies() {
    echo -e "${BOLD}Checking dependencies...${NC}"

    if ! command -v docker &> /dev/null; then
        echo -e "${RED}✗ Docker is not installed${NC}"
        echo "  Please install Docker: https://docs.docker.com/get-docker/"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Docker found"

    if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
        echo -e "${RED}✗ Docker Compose is not installed${NC}"
        echo "  Please install Docker Compose: https://docs.docker.com/compose/install/"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Docker Compose found"

    echo ""
}

# Demo mode installation
install_demo() {
    echo -e "${BOLD}Starting MEET in Demo Mode...${NC}"
    echo ""

    # Check if containers are already running
    if docker compose ps 2>/dev/null | grep -q "meet"; then
        echo -e "${YELLOW}! MEET containers already exist${NC}"
        read -p "  Stop and rebuild? [y/N]: " rebuild
        if [[ "$rebuild" =~ ^[Yy]$ ]]; then
            docker compose down --remove-orphans
        else
            echo ""
            echo -e "${GREEN}✓ MEET is already running!${NC}"
            echo -e "  ${BOLD}→ Open ${CYAN}http://localhost:3000${NC}"
            exit 0
        fi
    fi

    echo "Building and starting containers..."
    echo ""

    # Build and start
    if docker compose up -d --build; then
        echo ""
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "${GREEN}  ✓ MEET is running!${NC}"
        echo ""
        echo -e "  ${BOLD}Open your browser:${NC}"
        echo -e "    → ${CYAN}http://localhost:3000${NC}"
        echo ""
        echo -e "  ${BOLD}Quick start:${NC}"
        echo -e "    1. Enter your name"
        echo -e "    2. Create or join a room"
        echo -e "    3. Share the room code with others"
        echo ""
        echo -e "  ${BOLD}Commands:${NC}"
        echo -e "    Stop:    ${YELLOW}docker compose down${NC}"
        echo -e "    Logs:    ${YELLOW}docker compose logs -f${NC}"
        echo -e "    Restart: ${YELLOW}docker compose restart${NC}"
        echo ""
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    else
        echo ""
        echo -e "${RED}✗ Failed to start MEET${NC}"
        echo "  Check logs with: docker compose logs"
        exit 1
    fi
}

# Production mode placeholder
install_production() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${BOLD}  Production Mode${NC}"
    echo ""
    echo "  Production mode includes:"
    echo "    • SSL/TLS with automatic certificates"
    echo "    • Custom domain configuration"
    echo "    • PostgreSQL for room/user persistence"
    echo "    • Redis for session management"
    echo "    • TURN server for NAT traversal"
    echo "    • User authentication (OAuth/email)"
    echo "    • Admin dashboard"
    echo ""
    echo -e "${YELLOW}  Coming soon! Use Demo mode for now.${NC}"
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    exit 0
}

# Main
main() {
    print_banner
    check_dependencies

    echo -e "${BOLD}Select installation mode:${NC}"
    echo ""
    echo -e "  ${CYAN}[1]${NC} Demo Mode"
    echo "      Quick start for local development and testing"
    echo "      No external accounts or API keys required"
    echo ""
    echo -e "  ${CYAN}[2]${NC} Production Mode"
    echo "      Full deployment with SSL, persistence, auth"
    echo -e "      ${YELLOW}(Coming soon)${NC}"
    echo ""
    read -p "Enter choice [1]: " choice
    choice=${choice:-1}

    echo ""

    case "$choice" in
        1)
            install_demo
            ;;
        2)
            install_production
            ;;
        *)
            echo -e "${RED}Invalid choice. Exiting.${NC}"
            exit 1
            ;;
    esac
}

main "$@"
