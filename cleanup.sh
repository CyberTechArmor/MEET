#!/bin/bash

# MEET - Cleanup Script
# Removes all MEET containers, images, volumes, and configuration
# Run this to prepare for a fresh install

set -e

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'
DIM='\033[2m'

# ASCII Banner
print_banner() {
    echo -e "${RED}"
    cat << "EOF"

    ███╗   ███╗███████╗███████╗████████╗
    ████╗ ████║██╔════╝██╔════╝╚══██╔══╝
    ██╔████╔██║█████╗  █████╗     ██║
    ██║╚██╔╝██║██╔══╝  ██╔══╝     ██║
    ██║ ╚═╝ ██║███████╗███████╗   ██║
    ╚═╝     ╚═╝╚══════╝╚══════╝   ╚═╝

    Cleanup Script
    ─────────────────────────────────────

EOF
    echo -e "${NC}"
}

# Check if Docker is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Docker is not installed. Nothing to clean up.${NC}"
        exit 0
    fi

    if ! docker info &> /dev/null; then
        echo -e "${RED}Docker daemon is not running.${NC}"
        exit 1
    fi
}

# Stop and remove containers
cleanup_containers() {
    echo -e "${BOLD}Stopping containers...${NC}"

    # Stop containers from both compose files
    if [ -f docker-compose.yml ]; then
        docker compose down --remove-orphans 2>/dev/null || true
    fi

    if [ -f docker-compose.proxy.yml ]; then
        docker compose -f docker-compose.proxy.yml down --remove-orphans 2>/dev/null || true
    fi

    # Find and stop any remaining MEET containers
    local containers=$(docker ps -a --filter "name=meet" --format "{{.ID}}" 2>/dev/null)
    if [ -n "$containers" ]; then
        echo -e "${DIM}Removing MEET containers...${NC}"
        echo "$containers" | xargs -r docker rm -f 2>/dev/null || true
    fi

    echo -e "${GREEN}✓${NC} Containers removed"
}

# Remove Docker images
cleanup_images() {
    echo -e "${BOLD}Removing images...${NC}"

    # Remove MEET-specific images
    local images=$(docker images --filter "reference=*meet*" --format "{{.ID}}" 2>/dev/null)
    if [ -n "$images" ]; then
        echo -e "${DIM}Removing MEET images...${NC}"
        echo "$images" | xargs -r docker rmi -f 2>/dev/null || true
    fi

    # Also remove by name patterns
    docker rmi meet-meet-frontend meet-meet-api 2>/dev/null || true
    docker rmi meet-frontend meet-api 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Images removed"
}

# Remove Docker volumes
cleanup_volumes() {
    echo -e "${BOLD}Removing volumes...${NC}"

    # Remove named volumes from compose
    docker volume rm meet_caddy_data meet_caddy_config 2>/dev/null || true

    # Remove any dangling volumes (optional, with confirmation)
    local dangling=$(docker volume ls -qf dangling=true 2>/dev/null)
    if [ -n "$dangling" ]; then
        echo -e "${YELLOW}Found dangling volumes. Remove them? [y/N]:${NC} "
        read -r remove_dangling
        if [[ "$remove_dangling" =~ ^[Yy]$ ]]; then
            echo "$dangling" | xargs -r docker volume rm 2>/dev/null || true
            echo -e "${GREEN}✓${NC} Dangling volumes removed"
        fi
    fi

    echo -e "${GREEN}✓${NC} Volumes cleaned up"
}

# Remove Docker networks
cleanup_networks() {
    echo -e "${BOLD}Removing networks...${NC}"

    # Remove MEET networks
    docker network rm meet-network meet_meet-network 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Networks removed"
}

# Clean Docker build cache
cleanup_build_cache() {
    echo -e "${BOLD}Cleaning build cache...${NC}"

    echo -e "${YELLOW}Remove Docker build cache? This will speed up fresh builds but uses disk space. [y/N]:${NC} "
    read -r clean_cache
    if [[ "$clean_cache" =~ ^[Yy]$ ]]; then
        docker builder prune -f 2>/dev/null || true
        echo -e "${GREEN}✓${NC} Build cache cleaned"
    else
        echo -e "${DIM}Skipped${NC}"
    fi
}

# Remove local configuration files
cleanup_config() {
    echo -e "${BOLD}Removing configuration files...${NC}"

    # Remove .env file (but keep .env.example)
    if [ -f .env ]; then
        echo -e "${YELLOW}Remove .env file? [y/N]:${NC} "
        read -r remove_env
        if [[ "$remove_env" =~ ^[Yy]$ ]]; then
            rm -f .env
            echo -e "${GREEN}✓${NC} .env removed"
        else
            echo -e "${DIM}Skipped${NC}"
        fi
    fi

    # Remove any backup files
    rm -f .env.bak 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Configuration cleaned"
}

# Remove node_modules (if running locally)
cleanup_node_modules() {
    echo -e "${BOLD}Checking for node_modules...${NC}"

    local found=false

    if [ -d frontend/node_modules ]; then
        found=true
    fi

    if [ -d api/node_modules ]; then
        found=true
    fi

    if [ "$found" = true ]; then
        echo -e "${YELLOW}Remove node_modules directories? [y/N]:${NC} "
        read -r remove_node
        if [[ "$remove_node" =~ ^[Yy]$ ]]; then
            rm -rf frontend/node_modules 2>/dev/null || true
            rm -rf api/node_modules 2>/dev/null || true
            echo -e "${GREEN}✓${NC} node_modules removed"
        else
            echo -e "${DIM}Skipped${NC}"
        fi
    else
        echo -e "${DIM}No node_modules found${NC}"
    fi
}

# Full cleanup
full_cleanup() {
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}  WARNING: This will remove ALL MEET data!${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "This will remove:"
    echo "  • All MEET Docker containers"
    echo "  • All MEET Docker images"
    echo "  • All MEET Docker volumes"
    echo "  • All MEET Docker networks"
    echo "  • Configuration files (.env)"
    echo ""
    echo -e "${YELLOW}Are you sure you want to continue? [y/N]:${NC} "
    read -r confirm

    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo ""
        echo -e "${YELLOW}Cleanup cancelled.${NC}"
        exit 0
    fi

    echo ""
    cleanup_containers
    cleanup_images
    cleanup_volumes
    cleanup_networks
    cleanup_config
    cleanup_node_modules
    cleanup_build_cache

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${GREEN}  ✓ Cleanup complete!${NC}"
    echo ""
    echo "  You can now run a fresh install with:"
    echo -e "    ${CYAN}./install.sh${NC}"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Quick cleanup (no prompts, just containers and images)
quick_cleanup() {
    echo -e "${BOLD}Running quick cleanup...${NC}"
    echo ""

    cleanup_containers
    cleanup_images
    cleanup_networks

    # Also clear build cache to prevent stale code issues
    echo -e "${BOLD}Clearing build cache...${NC}"
    docker builder prune -f 2>/dev/null || true
    echo -e "${GREEN}✓${NC} Build cache cleared"

    echo ""
    echo -e "${GREEN}✓ Quick cleanup complete!${NC}"
    echo ""
    echo "  Run ${CYAN}./cleanup.sh${NC} without --quick for full cleanup options."
}

# Show help
show_help() {
    echo "MEET Cleanup Script"
    echo ""
    echo "Usage: ./cleanup.sh [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --quick, -q     Quick cleanup (containers, images, networks only)"
    echo "  --force, -f     Skip confirmation prompts"
    echo "  --help, -h      Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./cleanup.sh           Full interactive cleanup"
    echo "  ./cleanup.sh --quick   Quick cleanup without prompts"
    echo "  ./cleanup.sh --force   Full cleanup without confirmations"
}

# Main
main() {
    print_banner
    check_docker

    case "${1:-}" in
        --quick|-q)
            quick_cleanup
            ;;
        --force|-f)
            # Override read to auto-confirm
            cleanup_containers
            cleanup_images
            cleanup_volumes
            cleanup_networks
            rm -f .env .env.bak 2>/dev/null || true
            rm -rf frontend/node_modules api/node_modules 2>/dev/null || true
            docker builder prune -f 2>/dev/null || true
            echo ""
            echo -e "${GREEN}✓ Force cleanup complete!${NC}"
            ;;
        --help|-h)
            show_help
            ;;
        "")
            full_cleanup
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
