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

# Find the first available port starting from a given port
find_available_port() {
    local port=$1
    local max_port=$((port + 100))

    while [ "$port" -le "$max_port" ]; do
        # Check if port is in use using multiple methods for compatibility
        if command -v ss &> /dev/null; then
            if ! ss -tlnH 2>/dev/null | grep -q ":${port} "; then
                echo "$port"
                return 0
            fi
        elif command -v netstat &> /dev/null; then
            if ! netstat -tln 2>/dev/null | grep -q ":${port} "; then
                echo "$port"
                return 0
            fi
        else
            # Fallback: try to bind to the port briefly
            if (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null; then
                # Port is in use (something responded)
                :
            else
                echo "$port"
                return 0
            fi
        fi
        port=$((port + 1))
    done

    # If nothing found, return the original (will fail at docker level)
    echo "$1"
    return 1
}

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

# Install Nginx
install_nginx() {
    echo -e "${YELLOW}Installing Nginx...${NC}"

    case "$PKG_MANAGER" in
        apt)
            $SUDO apt-get update -qq && $SUDO apt-get install -y -qq nginx > /dev/null
            ;;
        dnf)
            $SUDO dnf install -y nginx > /dev/null 2>&1
            ;;
        yum)
            $SUDO yum install -y nginx > /dev/null 2>&1
            ;;
        pacman)
            $SUDO pacman -Sy --noconfirm nginx > /dev/null 2>&1
            ;;
        zypper)
            $SUDO zypper install -y nginx > /dev/null 2>&1
            ;;
        apk)
            $SUDO apk add --no-cache nginx > /dev/null 2>&1
            ;;
        brew)
            brew install nginx > /dev/null 2>&1
            ;;
        *)
            echo -e "${RED}✗ Unsupported package manager for Nginx installation${NC}"
            echo "  Please install Nginx manually: https://nginx.org/en/docs/install.html"
            exit 1
            ;;
    esac

    # Start and enable Nginx (Linux only)
    if [ "$OS" = "linux" ]; then
        $SUDO systemctl start nginx 2>/dev/null || $SUDO service nginx start 2>/dev/null || true
        $SUDO systemctl enable nginx 2>/dev/null || true
    fi

    echo -e "${GREEN}✓${NC} Nginx installed successfully"
}

# Install Certbot for Let's Encrypt
install_certbot() {
    echo -e "${YELLOW}Installing Certbot...${NC}"

    case "$PKG_MANAGER" in
        apt)
            $SUDO apt-get update -qq
            $SUDO apt-get install -y -qq certbot python3-certbot-nginx > /dev/null
            ;;
        dnf)
            $SUDO dnf install -y certbot python3-certbot-nginx > /dev/null 2>&1
            ;;
        yum)
            # EPEL required for certbot on CentOS/RHEL
            $SUDO yum install -y epel-release > /dev/null 2>&1 || true
            $SUDO yum install -y certbot python3-certbot-nginx > /dev/null 2>&1
            ;;
        pacman)
            $SUDO pacman -Sy --noconfirm certbot certbot-nginx > /dev/null 2>&1
            ;;
        zypper)
            $SUDO zypper install -y certbot python3-certbot-nginx > /dev/null 2>&1
            ;;
        apk)
            $SUDO apk add --no-cache certbot certbot-nginx > /dev/null 2>&1
            ;;
        brew)
            brew install certbot > /dev/null 2>&1
            ;;
        *)
            echo -e "${RED}✗ Unsupported package manager for Certbot installation${NC}"
            echo "  Please install Certbot manually: https://certbot.eff.org/"
            exit 1
            ;;
    esac

    echo -e "${GREEN}✓${NC} Certbot installed successfully"
}

# Repository URL
MEET_REPO="https://github.com/CyberTechArmor/MEET.git"
MEET_DIR="MEET"

# Setup repository - clone if needed, ensure we're in the right directory
setup_repository() {
    # Check if we're already in the MEET directory with required files
    if [ -f "docker-compose.yml" ] && [ -f "docker-compose.proxy.yml" ] && [ -f "Caddyfile" ]; then
        echo -e "${GREEN}✓${NC} Already in MEET directory"
        # Pull latest changes if it's a git repo
        if [ -d ".git" ]; then
            echo -e "${DIM}Pulling latest changes...${NC}"
            git fetch origin 2>/dev/null || true
            git pull 2>/dev/null || true
        fi
        # Remove any stale .env to ensure fresh config
        rm -f .env 2>/dev/null || true
        return 0
    fi

    # Check if MEET directory exists in current location
    if [ -d "$MEET_DIR" ] && [ -f "$MEET_DIR/docker-compose.yml" ]; then
        echo -e "${DIM}Found existing MEET directory, switching to it...${NC}"
        cd "$MEET_DIR"
        # Pull latest changes
        if [ -d ".git" ]; then
            echo -e "${DIM}Pulling latest changes...${NC}"
            git fetch origin 2>/dev/null || true
            git pull 2>/dev/null || true
        fi
        # Remove any stale .env to ensure fresh config
        rm -f .env 2>/dev/null || true
        return 0
    fi

    # Clone the repository
    echo -e "${BOLD}Cloning MEET repository...${NC}"
    echo ""

    if git clone "$MEET_REPO" "$MEET_DIR"; then
        cd "$MEET_DIR"
        echo -e "${GREEN}✓${NC} Repository cloned successfully"
        echo ""
    else
        echo -e "${RED}✗ Failed to clone repository${NC}"
        echo "  Please check your internet connection and try again."
        echo "  Or manually clone: git clone $MEET_REPO"
        exit 1
    fi
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
            # Read port from .env if available
            local existing_port=$(grep MEET_FRONTEND_PORT .env 2>/dev/null | cut -d= -f2)
            existing_port=${existing_port:-3000}
            echo -e "  ${BOLD}→ Open ${CYAN}http://localhost:${existing_port}${NC}"
            exit 0
        fi
    fi

    # Find available ports
    echo -e "${DIM}Checking for available ports...${NC}"

    local frontend_port
    frontend_port=$(find_available_port 3000)
    local api_port
    api_port=$(find_available_port 8080)

    if [ "$frontend_port" != "3000" ]; then
        echo -e "${YELLOW}!${NC} Port 3000 is in use, using port ${CYAN}$frontend_port${NC} for frontend"
    else
        echo -e "${GREEN}✓${NC} Port 3000 available for frontend"
    fi

    if [ "$api_port" != "8080" ]; then
        echo -e "${YELLOW}!${NC} Port 8080 is in use, using port ${CYAN}$api_port${NC} for API"
    else
        echo -e "${GREEN}✓${NC} Port 8080 available for API"
    fi

    # Write port config to .env
    cat > .env << EOF
MEET_FRONTEND_PORT=$frontend_port
MEET_API_PORT=$api_port
EOF

    echo ""
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
        echo -e "    → ${CYAN}http://localhost:${frontend_port}${NC}"
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

    # Detect server's public IPv4 for LiveKit (needed for WebRTC ICE)
    livekit_ip=""
    if [[ "$domain" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        # Already an IP address
        livekit_ip="$domain"
    elif [ "$domain" != "localhost" ]; then
        # Detect the server's actual public IPv4 (not DNS resolution)
        # Use -4 flag to force IPv4 (WebRTC works best with IPv4)
        echo -e "${DIM}Detecting server's public IPv4...${NC}"

        # Try multiple services in case one is down (all force IPv4)
        livekit_ip=$(curl -4 -s --connect-timeout 5 ifconfig.me 2>/dev/null)
        if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            livekit_ip=$(curl -4 -s --connect-timeout 5 icanhazip.com 2>/dev/null)
        fi
        if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            livekit_ip=$(curl -4 -s --connect-timeout 5 ipinfo.io/ip 2>/dev/null)
        fi
        if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            livekit_ip=$(curl -4 -s --connect-timeout 5 api.ipify.org 2>/dev/null)
        fi
        if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            livekit_ip=$(curl -4 -s --connect-timeout 5 checkip.amazonaws.com 2>/dev/null | tr -d '\n')
        fi

        # Validate IPv4 format
        if [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo -e "${GREEN}✓${NC} Detected public IPv4: $livekit_ip"
        else
            echo -e "${YELLOW}  Warning: Could not detect server's public IPv4${NC}"
            echo "  LiveKit will attempt auto-detection. If WebRTC fails, set LIVEKIT_NODE_IP manually in .env"
            livekit_ip=""
        fi
    fi

    # Create .env file (overwrite to ensure clean state)
    cat > .env << EOF
MEET_DOMAIN=$domain
ACME_EMAIL=$acme_email
TLS_MODE=$tls_mode
LIVEKIT_NODE_IP=$livekit_ip
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

# Nginx reverse proxy mode installation
install_with_nginx() {
    echo -e "${BOLD}Starting MEET with Nginx Reverse Proxy...${NC}"
    echo ""

    # macOS is not supported for this mode
    if [ "$OS" = "macos" ]; then
        echo -e "${RED}✗ Nginx reverse proxy mode is designed for Linux servers.${NC}"
        echo "  Use Demo Mode or Caddy Reverse Proxy mode on macOS."
        exit 1
    fi

    # Check for Nginx
    if ! command -v nginx &> /dev/null; then
        echo -e "${YELLOW}!${NC} Nginx is not installed."
        echo ""
        read -p "  Install Nginx? [Y/n]: " install_nginx_choice
        install_nginx_choice=${install_nginx_choice:-Y}

        if [[ "$install_nginx_choice" =~ ^[Yy]$ ]]; then
            install_nginx
        else
            echo ""
            echo -e "${RED}✗ Nginx is required for this installation mode.${NC}"
            echo "  Install it manually: https://nginx.org/en/docs/install.html"
            echo "  Or choose a different installation mode."
            exit 1
        fi
    else
        echo -e "${GREEN}✓${NC} Nginx found ($(nginx -v 2>&1 | cut -d'/' -f2))"
    fi

    # Get domain configuration
    echo ""
    echo -e "${BOLD}Domain Configuration${NC}"
    echo ""
    echo "  Enter your domain name for Let's Encrypt SSL certificates."
    echo "  Your domain's DNS must already point to this server."
    echo ""
    read -p "  Domain: " domain

    if [ -z "$domain" ]; then
        echo -e "${RED}  A domain name is required for Nginx + Let's Encrypt mode.${NC}"
        echo "  For local development, use Demo Mode instead."
        exit 1
    fi

    if [ "$domain" = "localhost" ]; then
        echo -e "${RED}  Cannot use 'localhost' with Let's Encrypt.${NC}"
        echo "  For local development, use Demo Mode instead."
        exit 1
    fi

    # Check for Certbot
    if ! command -v certbot &> /dev/null; then
        echo ""
        echo -e "${YELLOW}!${NC} Certbot (Let's Encrypt client) is not installed."
        echo -e "${DIM}  Certbot is required for automatic SSL certificates.${NC}"
        echo ""
        read -p "  Install Certbot with Nginx plugin? [Y/n]: " install_certbot_choice
        install_certbot_choice=${install_certbot_choice:-Y}

        if [[ "$install_certbot_choice" =~ ^[Yy]$ ]]; then
            install_certbot
        else
            echo ""
            echo -e "${RED}✗ Certbot is required for SSL certificates.${NC}"
            echo "  Install it manually: https://certbot.eff.org/"
            exit 1
        fi
    else
        echo -e "${GREEN}✓${NC} Certbot found"
    fi

    # Check that certbot-nginx plugin is available
    if ! certbot plugins 2>/dev/null | grep -q nginx; then
        echo -e "${YELLOW}!${NC} Certbot Nginx plugin not found. Installing..."
        install_certbot
    fi

    # Detect server's public IPv4 for LiveKit
    livekit_ip=""
    echo -e "${DIM}Detecting server's public IPv4...${NC}"

    livekit_ip=$(curl -4 -s --connect-timeout 5 ifconfig.me 2>/dev/null)
    if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        livekit_ip=$(curl -4 -s --connect-timeout 5 icanhazip.com 2>/dev/null)
    fi
    if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        livekit_ip=$(curl -4 -s --connect-timeout 5 ipinfo.io/ip 2>/dev/null)
    fi
    if [ -z "$livekit_ip" ] || ! [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        livekit_ip=$(curl -4 -s --connect-timeout 5 api.ipify.org 2>/dev/null)
    fi

    if [[ "$livekit_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo -e "${GREEN}✓${NC} Detected public IPv4: $livekit_ip"
    else
        echo -e "${YELLOW}  Warning: Could not detect server's public IPv4${NC}"
        echo "  LiveKit will attempt auto-detection. If WebRTC fails, set LIVEKIT_NODE_IP manually in .env"
        livekit_ip=""
    fi

    # Find available ports
    echo -e "${DIM}Checking for available ports...${NC}"

    local frontend_port
    frontend_port=$(find_available_port 3000)
    local api_port
    api_port=$(find_available_port 8080)

    if [ "$frontend_port" != "3000" ]; then
        echo -e "${YELLOW}!${NC} Port 3000 is in use, using port ${CYAN}$frontend_port${NC} for frontend"
    else
        echo -e "${GREEN}✓${NC} Port 3000 available for frontend"
    fi

    if [ "$api_port" != "8080" ]; then
        echo -e "${YELLOW}!${NC} Port 8080 is in use, using port ${CYAN}$api_port${NC} for API"
    else
        echo -e "${GREEN}✓${NC} Port 8080 available for API"
    fi

    # Create .env file
    cat > .env << EOF
MEET_DOMAIN=$domain
LIVEKIT_NODE_IP=$livekit_ip
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
MEET_FRONTEND_PORT=$frontend_port
MEET_API_PORT=$api_port
EOF

    echo ""
    echo -e "${DIM}Configuration saved to .env${NC}"
    echo ""

    # Generate Nginx config from template, replacing domain and ports
    echo -e "${DIM}Generating Nginx configuration...${NC}"
    sed -e "s/MEET_DOMAIN_PLACEHOLDER/$domain/g" \
        -e "s/127\.0\.0\.1:3000/127.0.0.1:$frontend_port/g" \
        -e "s/127\.0\.0\.1:8080/127.0.0.1:$api_port/g" \
        nginx.meet.conf > "nginx.meet.$domain.conf"

    # Install Nginx config
    $SUDO cp "nginx.meet.$domain.conf" "/etc/nginx/sites-available/meet"

    # Enable the site
    if [ -d /etc/nginx/sites-enabled ]; then
        $SUDO ln -sf /etc/nginx/sites-available/meet /etc/nginx/sites-enabled/meet
        # Remove default site if it exists (it would conflict on port 80)
        if [ -L /etc/nginx/sites-enabled/default ]; then
            echo -e "${DIM}Disabling default Nginx site to avoid port conflicts...${NC}"
            $SUDO rm -f /etc/nginx/sites-enabled/default
        fi
    elif [ -d /etc/nginx/conf.d ]; then
        # Some distros use conf.d instead of sites-available
        $SUDO cp "nginx.meet.$domain.conf" "/etc/nginx/conf.d/meet.conf"
    fi

    echo -e "${GREEN}✓${NC} Nginx configuration installed"

    # Check if containers are already running
    if docker compose -f docker-compose.nginx.yml ps 2>/dev/null | grep -q "meet"; then
        echo -e "${YELLOW}! MEET containers already exist${NC}"
        read -p "  Stop and rebuild? [y/N]: " rebuild
        if [[ "$rebuild" =~ ^[Yy]$ ]]; then
            docker compose -f docker-compose.nginx.yml down --remove-orphans
        else
            echo ""
            echo -e "${GREEN}✓ MEET is already running!${NC}"
            echo -e "  ${BOLD}→ Open ${CYAN}https://$domain${NC}"
            exit 0
        fi
    fi

    echo ""
    echo "Building and starting Docker containers..."
    echo ""

    # Build and start Docker services
    if docker compose -f docker-compose.nginx.yml build --no-cache && docker compose -f docker-compose.nginx.yml up -d; then
        echo ""
        echo -e "${GREEN}✓${NC} Docker containers started"
    else
        echo ""
        echo -e "${RED}✗ Failed to start Docker containers${NC}"
        echo "  Check logs with: docker compose -f docker-compose.nginx.yml logs"
        exit 1
    fi

    # Obtain SSL certificate with Certbot
    echo ""
    echo -e "${BOLD}Obtaining SSL certificate...${NC}"
    echo ""
    echo "  Certbot will now request a certificate from Let's Encrypt."
    echo "  Make sure your domain ($domain) points to this server's IP."
    echo ""

    # First, start Nginx with just the HTTP config for the ACME challenge
    # We need a temporary config that doesn't reference SSL certs yet
    $SUDO tee /etc/nginx/sites-available/meet > /dev/null << NGINX_TEMP
server {
    listen 80;
    listen [::]:80;
    server_name $domain;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 200 'MEET is being configured...';
        add_header Content-Type text/plain;
    }
}
NGINX_TEMP

    # Reload Nginx with the temporary config
    $SUDO nginx -t 2>/dev/null && $SUDO systemctl reload nginx 2>/dev/null || $SUDO service nginx reload 2>/dev/null || true

    # Run Certbot
    if $SUDO certbot --nginx -d "$domain" --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>&1; then
        echo ""
        echo -e "${GREEN}✓${NC} SSL certificate obtained successfully"

        # Now install the full Nginx config (with SSL paths)
        $SUDO cp "nginx.meet.$domain.conf" "/etc/nginx/sites-available/meet"

        # Reload Nginx with the full config
        if $SUDO nginx -t 2>/dev/null; then
            $SUDO systemctl reload nginx 2>/dev/null || $SUDO service nginx reload 2>/dev/null || true
            echo -e "${GREEN}✓${NC} Nginx configured with SSL"
        else
            echo -e "${YELLOW}!${NC} Nginx config test failed, keeping Certbot-managed config"
        fi
    else
        echo ""
        echo -e "${YELLOW}! SSL certificate could not be obtained automatically.${NC}"
        echo ""
        echo "  This usually means:"
        echo "    • DNS for $domain does not point to this server"
        echo "    • Port 80 is blocked by a firewall"
        echo "    • Let's Encrypt rate limits have been reached"
        echo ""
        echo "  You can retry manually later:"
        echo "    sudo certbot --nginx -d $domain"
        echo ""
        echo "  The Docker services are running. Once SSL is configured,"
        echo "  install the full Nginx config:"
        echo "    sudo cp nginx.meet.$domain.conf /etc/nginx/sites-available/meet"
        echo "    sudo nginx -t && sudo systemctl reload nginx"
    fi

    # Clean up generated config file
    rm -f "nginx.meet.$domain.conf"

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${GREEN}  ✓ MEET is running with Nginx reverse proxy!${NC}"
    echo ""
    echo -e "  ${BOLD}Open your browser:${NC}"
    echo -e "    → ${CYAN}https://$domain${NC}"
    echo ""
    echo -e "  ${BOLD}Quick start:${NC}"
    echo -e "    1. Enter your name"
    echo -e "    2. Create or join a room"
    echo -e "    3. Share the room code with others"
    echo ""
    echo -e "  ${BOLD}Commands:${NC}"
    echo -e "    Stop:    ${YELLOW}docker compose -f docker-compose.nginx.yml down${NC}"
    echo -e "    Logs:    ${YELLOW}docker compose -f docker-compose.nginx.yml logs -f${NC}"
    echo -e "    Restart: ${YELLOW}docker compose -f docker-compose.nginx.yml restart${NC}"
    echo ""
    echo -e "  ${BOLD}SSL:${NC}"
    echo -e "    Renew:   ${YELLOW}sudo certbot renew${NC}"
    echo -e "    Status:  ${YELLOW}sudo certbot certificates${NC}"
    echo ""
    echo -e "  ${BOLD}Nginx:${NC}"
    echo -e "    Config:  ${YELLOW}/etc/nginx/sites-available/meet${NC}"
    echo -e "    Test:    ${YELLOW}sudo nginx -t${NC}"
    echo -e "    Reload:  ${YELLOW}sudo systemctl reload nginx${NC}"
    echo ""
    echo -e "  ${BOLD}Configuration:${NC}"
    echo -e "    Edit ${YELLOW}.env${NC} to change settings"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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
    setup_repository

    echo -e "${BOLD}Select installation mode:${NC}"
    echo ""
    echo -e "  ${CYAN}[1]${NC} Demo Mode"
    echo "      Quick start for local development and testing"
    echo "      Access via http://localhost:3000"
    echo ""
    echo -e "  ${CYAN}[2]${NC} Deploy with Caddy (automatic HTTPS)"
    echo "      Caddy reverse proxy with automatic Let's Encrypt"
    echo "      Supports domain names, IPs, and localhost"
    echo ""
    echo -e "  ${CYAN}[3]${NC} Deploy with Nginx + Let's Encrypt"
    echo "      Uses host-installed Nginx with Certbot for SSL"
    echo "      Installs Nginx and Certbot if not present"
    echo ""
    echo -e "  ${CYAN}[4]${NC} Production Mode"
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
            install_with_nginx
            ;;
        4)
            install_production
            ;;
        *)
            echo -e "${RED}Invalid choice. Exiting.${NC}"
            exit 1
            ;;
    esac
}

main "$@"
