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
DIM='\033[2m'

# Detect if we need sudo
SUDO=""
if [ "$EUID" -ne 0 ]; then
    SUDO="sudo"
fi

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

# Detect OS and distribution
detect_os() {
    OS=""
    DISTRO=""
    PKG_MANAGER=""

    case "$(uname -s)" in
        Linux*)
            OS="linux"
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                DISTRO="$ID"
                case "$ID" in
                    ubuntu|debian|linuxmint|pop|elementary|zorin|kali)
                        PKG_MANAGER="apt"
                        ;;
                    fedora)
                        PKG_MANAGER="dnf"
                        ;;
                    centos|rhel|rocky|almalinux|ol)
                        if command -v dnf &> /dev/null; then
                            PKG_MANAGER="dnf"
                        else
                            PKG_MANAGER="yum"
                        fi
                        ;;
                    arch|manjaro|endeavouros)
                        PKG_MANAGER="pacman"
                        ;;
                    opensuse*|sles)
                        PKG_MANAGER="zypper"
                        ;;
                    alpine)
                        PKG_MANAGER="apk"
                        ;;
                    *)
                        # Try to detect package manager
                        if command -v apt &> /dev/null; then
                            PKG_MANAGER="apt"
                        elif command -v dnf &> /dev/null; then
                            PKG_MANAGER="dnf"
                        elif command -v yum &> /dev/null; then
                            PKG_MANAGER="yum"
                        elif command -v pacman &> /dev/null; then
                            PKG_MANAGER="pacman"
                        elif command -v zypper &> /dev/null; then
                            PKG_MANAGER="zypper"
                        elif command -v apk &> /dev/null; then
                            PKG_MANAGER="apk"
                        fi
                        ;;
                esac
            fi
            ;;
        Darwin*)
            OS="macos"
            DISTRO="macos"
            if command -v brew &> /dev/null; then
                PKG_MANAGER="brew"
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            OS="windows"
            DISTRO="windows"
            ;;
        *)
            OS="unknown"
            ;;
    esac

    echo -e "${DIM}Detected: $OS ($DISTRO)${NC}"
}

# Install Docker on various platforms
install_docker() {
    echo -e "${YELLOW}Installing Docker...${NC}"
    echo ""

    case "$PKG_MANAGER" in
        apt)
            # Ubuntu/Debian
            echo -e "${DIM}Updating package index...${NC}"
            $SUDO apt-get update -qq

            echo -e "${DIM}Installing prerequisites...${NC}"
            $SUDO apt-get install -y -qq \
                ca-certificates \
                curl \
                gnupg \
                lsb-release > /dev/null

            echo -e "${DIM}Adding Docker GPG key...${NC}"
            $SUDO install -m 0755 -d /etc/apt/keyrings
            curl -fsSL https://download.docker.com/linux/$DISTRO/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
            $SUDO chmod a+r /etc/apt/keyrings/docker.gpg

            echo -e "${DIM}Adding Docker repository...${NC}"
            echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$DISTRO \
                $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
                $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

            echo -e "${DIM}Installing Docker packages...${NC}"
            $SUDO apt-get update -qq
            $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null
            ;;

        dnf)
            # Fedora/CentOS 8+/RHEL 8+
            echo -e "${DIM}Installing prerequisites...${NC}"
            $SUDO dnf -y install dnf-plugins-core > /dev/null 2>&1

            echo -e "${DIM}Adding Docker repository...${NC}"
            $SUDO dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo 2>/dev/null || \
            $SUDO dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null

            echo -e "${DIM}Installing Docker packages...${NC}"
            $SUDO dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null 2>&1
            ;;

        yum)
            # CentOS 7/RHEL 7
            echo -e "${DIM}Installing prerequisites...${NC}"
            $SUDO yum install -y yum-utils > /dev/null 2>&1

            echo -e "${DIM}Adding Docker repository...${NC}"
            $SUDO yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo > /dev/null 2>&1

            echo -e "${DIM}Installing Docker packages...${NC}"
            $SUDO yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null 2>&1
            ;;

        pacman)
            # Arch Linux
            echo -e "${DIM}Installing Docker...${NC}"
            $SUDO pacman -Sy --noconfirm docker docker-compose > /dev/null 2>&1
            ;;

        zypper)
            # openSUSE
            echo -e "${DIM}Installing Docker...${NC}"
            $SUDO zypper install -y docker docker-compose > /dev/null 2>&1
            ;;

        apk)
            # Alpine
            echo -e "${DIM}Installing Docker...${NC}"
            $SUDO apk add --no-cache docker docker-compose > /dev/null 2>&1
            ;;

        brew)
            # macOS
            echo -e "${DIM}Installing Docker Desktop via Homebrew...${NC}"
            brew install --cask docker
            echo ""
            echo -e "${YELLOW}! Docker Desktop installed${NC}"
            echo -e "  Please open Docker Desktop from Applications and wait for it to start."
            echo -e "  Then run this installer again."
            echo ""
            read -p "Press Enter after Docker Desktop is running..."
            ;;

        *)
            echo -e "${RED}✗ Unsupported package manager${NC}"
            echo ""
            echo "  Please install Docker manually:"
            echo "  https://docs.docker.com/get-docker/"
            echo ""
            exit 1
            ;;
    esac

    # Start and enable Docker service (Linux only)
    if [ "$OS" = "linux" ]; then
        echo -e "${DIM}Starting Docker service...${NC}"
        $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
        $SUDO systemctl enable docker 2>/dev/null || true
    fi

    echo -e "${GREEN}✓${NC} Docker installed successfully"
}

# Install Docker Compose (standalone, if plugin not available)
install_docker_compose() {
    echo -e "${YELLOW}Installing Docker Compose...${NC}"

    # Try to install as plugin first
    case "$PKG_MANAGER" in
        apt)
            $SUDO apt-get install -y -qq docker-compose-plugin > /dev/null 2>&1 && return 0
            ;;
        dnf)
            $SUDO dnf install -y docker-compose-plugin > /dev/null 2>&1 && return 0
            ;;
        yum)
            $SUDO yum install -y docker-compose-plugin > /dev/null 2>&1 && return 0
            ;;
    esac

    # Install standalone docker-compose
    echo -e "${DIM}Installing standalone Docker Compose...${NC}"

    COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$COMPOSE_VERSION" ]; then
        COMPOSE_VERSION="v2.24.0"  # Fallback version
    fi

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) ARCH="x86_64" ;;
        aarch64|arm64) ARCH="aarch64" ;;
        armv7l) ARCH="armv7" ;;
    esac

    $SUDO curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-${ARCH}" -o /usr/local/bin/docker-compose
    $SUDO chmod +x /usr/local/bin/docker-compose

    echo -e "${GREEN}✓${NC} Docker Compose installed successfully"
}

# Install curl if not present
install_curl() {
    echo -e "${YELLOW}Installing curl...${NC}"

    case "$PKG_MANAGER" in
        apt)
            $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl > /dev/null
            ;;
        dnf)
            $SUDO dnf install -y curl > /dev/null 2>&1
            ;;
        yum)
            $SUDO yum install -y curl > /dev/null 2>&1
            ;;
        pacman)
            $SUDO pacman -Sy --noconfirm curl > /dev/null 2>&1
            ;;
        zypper)
            $SUDO zypper install -y curl > /dev/null 2>&1
            ;;
        apk)
            $SUDO apk add --no-cache curl > /dev/null 2>&1
            ;;
        brew)
            brew install curl > /dev/null 2>&1
            ;;
    esac

    echo -e "${GREEN}✓${NC} curl installed"
}

# Install git if not present
install_git() {
    echo -e "${YELLOW}Installing git...${NC}"

    case "$PKG_MANAGER" in
        apt)
            $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git > /dev/null
            ;;
        dnf)
            $SUDO dnf install -y git > /dev/null 2>&1
            ;;
        yum)
            $SUDO yum install -y git > /dev/null 2>&1
            ;;
        pacman)
            $SUDO pacman -Sy --noconfirm git > /dev/null 2>&1
            ;;
        zypper)
            $SUDO zypper install -y git > /dev/null 2>&1
            ;;
        apk)
            $SUDO apk add --no-cache git > /dev/null 2>&1
            ;;
        brew)
            brew install git > /dev/null 2>&1
            ;;
    esac

    echo -e "${GREEN}✓${NC} git installed"
}

# Add current user to docker group
setup_docker_group() {
    if [ "$OS" = "linux" ] && [ "$EUID" -ne 0 ]; then
        if ! groups | grep -q docker; then
            echo -e "${DIM}Adding user to docker group...${NC}"
            $SUDO usermod -aG docker "$USER" 2>/dev/null || true

            echo ""
            echo -e "${YELLOW}! User added to docker group${NC}"
            echo -e "  You may need to log out and back in for this to take effect."
            echo -e "  Alternatively, run: ${CYAN}newgrp docker${NC}"
            echo ""
        fi
    fi
}

# Check and install dependencies
check_and_install_dependencies() {
    echo -e "${BOLD}Checking dependencies...${NC}"
    echo ""

    # Detect OS first
    detect_os
    echo ""

    local NEED_RESTART=false

    # Check curl
    if ! command -v curl &> /dev/null; then
        echo -e "${YELLOW}!${NC} curl not found"
        install_curl
    else
        echo -e "${GREEN}✓${NC} curl found"
    fi

    # Check git (optional but useful)
    if ! command -v git &> /dev/null; then
        echo -e "${YELLOW}!${NC} git not found"
        install_git
    else
        echo -e "${GREEN}✓${NC} git found"
    fi

    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${YELLOW}!${NC} Docker not found"

        if [ "$OS" = "windows" ]; then
            echo ""
            echo -e "${RED}✗ Automatic Docker installation not supported on Windows${NC}"
            echo ""
            echo "  Please install Docker Desktop manually:"
            echo "  https://docs.docker.com/desktop/install/windows-install/"
            echo ""
            exit 1
        fi

        if [ -z "$PKG_MANAGER" ]; then
            echo ""
            echo -e "${RED}✗ Could not detect package manager${NC}"
            echo ""
            echo "  Please install Docker manually:"
            echo "  https://docs.docker.com/get-docker/"
            echo ""
            exit 1
        fi

        read -p "  Install Docker automatically? [Y/n]: " install_docker_choice
        install_docker_choice=${install_docker_choice:-Y}

        if [[ "$install_docker_choice" =~ ^[Yy]$ ]]; then
            install_docker
            NEED_RESTART=true
        else
            echo ""
            echo "  Please install Docker manually:"
            echo "  https://docs.docker.com/get-docker/"
            echo ""
            exit 1
        fi
    else
        echo -e "${GREEN}✓${NC} Docker found ($(docker --version | cut -d' ' -f3 | tr -d ','))"
    fi

    # Check Docker Compose
    if ! docker compose version &> /dev/null && ! command -v docker-compose &> /dev/null; then
        echo -e "${YELLOW}!${NC} Docker Compose not found"

        read -p "  Install Docker Compose automatically? [Y/n]: " install_compose_choice
        install_compose_choice=${install_compose_choice:-Y}

        if [[ "$install_compose_choice" =~ ^[Yy]$ ]]; then
            install_docker_compose
        else
            echo ""
            echo "  Please install Docker Compose manually:"
            echo "  https://docs.docker.com/compose/install/"
            echo ""
            exit 1
        fi
    else
        if docker compose version &> /dev/null; then
            echo -e "${GREEN}✓${NC} Docker Compose found ($(docker compose version --short 2>/dev/null || echo 'plugin'))"
        else
            echo -e "${GREEN}✓${NC} Docker Compose found ($(docker-compose --version | cut -d' ' -f4 2>/dev/null || echo 'standalone'))"
        fi
    fi

    # Check if Docker daemon is running
    if ! docker info &> /dev/null; then
        echo ""
        echo -e "${YELLOW}! Docker daemon is not running${NC}"

        if [ "$OS" = "linux" ]; then
            echo -e "${DIM}Starting Docker service...${NC}"
            $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
            sleep 2

            if ! docker info &> /dev/null; then
                setup_docker_group
                echo ""
                echo -e "${YELLOW}Please start Docker and run this script again.${NC}"
                exit 1
            fi
        elif [ "$OS" = "macos" ]; then
            echo "  Please start Docker Desktop and run this script again."
            exit 1
        fi
    fi

    # Setup docker group for non-root users
    if [ "$NEED_RESTART" = true ]; then
        setup_docker_group
    fi

    echo ""
    echo -e "${GREEN}All dependencies satisfied!${NC}"
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

    # Build and start (use --no-cache to ensure fresh build with latest code)
    if docker compose build --no-cache && docker compose up -d; then
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

# Reverse proxy mode installation
install_with_proxy() {
    echo -e "${BOLD}Starting MEET with Reverse Proxy (Caddy)...${NC}"
    echo ""

    # Get domain configuration
    echo -e "${BOLD}Domain Configuration${NC}"
    echo ""
    echo "  Enter your domain name for HTTPS/SSL certificates."
    echo "  Use 'localhost' for local development (HTTP only)."
    echo ""
    read -p "  Domain [localhost]: " domain
    domain=${domain:-localhost}

    # Detect if input is an IP address
    tls_mode=""
    acme_email="admin@example.com"

    if [ "$domain" = "localhost" ]; then
        # Localhost - no TLS needed
        tls_mode=""
    elif [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        # IP address - use self-signed certificate
        echo ""
        echo -e "${YELLOW}  Note: Using IP address with self-signed SSL certificate.${NC}"
        echo "  Your browser will show a security warning - this is normal."
        echo "  For trusted SSL, use a domain name instead."
        tls_mode="tls internal"
    else
        # Domain name - use Let's Encrypt
        echo ""
        echo "  Enter your email for Let's Encrypt SSL certificate notifications."
        echo ""
        read -p "  Email: " acme_email
        if [ -z "$acme_email" ]; then
            echo -e "${RED}  Email is required for SSL certificates.${NC}"
            exit 1
        fi
    fi

    # Create .env file (overwrite to ensure clean state)
    cat > .env << EOF
MEET_DOMAIN=$domain
ACME_EMAIL=$acme_email
TLS_MODE=$tls_mode
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
EOF

    echo ""
    echo -e "${DIM}Configuration saved to .env${NC}"
    echo ""

    # Check if containers are already running
    if docker compose -f docker-compose.proxy.yml ps 2>/dev/null | grep -q "meet\|caddy"; then
        echo -e "${YELLOW}! MEET containers already exist${NC}"
        read -p "  Stop and rebuild? [y/N]: " rebuild
        if [[ "$rebuild" =~ ^[Yy]$ ]]; then
            docker compose -f docker-compose.proxy.yml down --remove-orphans
        else
            echo ""
            echo -e "${GREEN}✓ MEET is already running!${NC}"
            if [ "$domain" = "localhost" ]; then
                echo -e "  ${BOLD}→ Open ${CYAN}http://localhost${NC}"
            else
                echo -e "  ${BOLD}→ Open ${CYAN}https://$domain${NC}"
            fi
            exit 0
        fi
    fi

    echo "Building and starting containers with reverse proxy..."
    echo ""

    # Build and start with proxy config (use --no-cache to ensure fresh build with latest code)
    if docker compose -f docker-compose.proxy.yml build --no-cache && docker compose -f docker-compose.proxy.yml up -d; then
        echo ""
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "${GREEN}  ✓ MEET is running with Caddy reverse proxy!${NC}"
        echo ""
        echo -e "  ${BOLD}Open your browser:${NC}"
        if [ "$domain" = "localhost" ]; then
            echo -e "    → ${CYAN}http://localhost${NC}"
        else
            echo -e "    → ${CYAN}https://$domain${NC}"
            echo ""
            echo -e "  ${BOLD}SSL/TLS:${NC}"
            echo "    Caddy will automatically obtain Let's Encrypt certificates"
            echo "    Ensure your domain points to this server's IP address"
        fi
        echo ""
        echo -e "  ${BOLD}Quick start:${NC}"
        echo -e "    1. Enter your name"
        echo -e "    2. Create or join a room"
        echo -e "    3. Share the room code with others"
        echo ""
        echo -e "  ${BOLD}Commands:${NC}"
        echo -e "    Stop:    ${YELLOW}docker compose -f docker-compose.proxy.yml down${NC}"
        echo -e "    Logs:    ${YELLOW}docker compose -f docker-compose.proxy.yml logs -f${NC}"
        echo -e "    Restart: ${YELLOW}docker compose -f docker-compose.proxy.yml restart${NC}"
        echo ""
        echo -e "  ${BOLD}Configuration:${NC}"
        echo -e "    Edit ${YELLOW}.env${NC} to change domain or settings"
        echo -e "    Edit ${YELLOW}Caddyfile${NC} for advanced proxy configuration"
        echo ""
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    else
        echo ""
        echo -e "${RED}✗ Failed to start MEET${NC}"
        echo "  Check logs with: docker compose -f docker-compose.proxy.yml logs"
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
    echo "  Full production deployment includes:"
    echo "    • SSL/TLS with automatic certificates"
    echo "    • Custom domain configuration"
    echo "    • PostgreSQL for room/user persistence"
    echo "    • Redis for session management"
    echo "    • TURN server for NAT traversal"
    echo "    • User authentication (OAuth/email)"
    echo "    • Admin dashboard"
    echo ""
    echo -e "${YELLOW}  Coming soon!${NC}"
    echo ""
    echo "  For now, use:"
    echo "    • Demo Mode - for local testing"
    echo "    • Demo + Proxy Mode - for deployment with SSL"
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    exit 0
}

# Main
main() {
    print_banner
    check_and_install_dependencies

    echo -e "${BOLD}Select installation mode:${NC}"
    echo ""
    echo -e "  ${CYAN}[1]${NC} Demo Mode"
    echo "      Quick start for local development and testing"
    echo "      Access via http://localhost:3000"
    echo ""
    echo -e "  ${CYAN}[2]${NC} Demo + Reverse Proxy (Caddy)"
    echo "      Includes Caddy for automatic HTTPS"
    echo "      Perfect for deployment with custom domain"
    echo ""
    echo -e "  ${CYAN}[3]${NC} Production Mode"
    echo "      Full deployment with persistence, auth, etc."
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
            install_with_proxy
            ;;
        3)
            install_production
            ;;
        *)
            echo -e "${RED}Invalid choice. Exiting.${NC}"
            exit 1
            ;;
    esac
}

main "$@"
