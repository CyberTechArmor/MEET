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
        pull_latest_or_warn
        # NOTE: we used to remove .env at the repo root here. The
        # external-proxy mode (option 5) keeps its .env at
        # deploy/external-proxy/.env which we leave alone — install.sh
        # is idempotent for it. Removing the root .env stays for the
        # demo / Caddy / nginx / proxypilot modes whose state is at
        # the root.
        rm -f .env 2>/dev/null || true
        return 0
    fi

    # Check if MEET directory exists in current location
    if [ -d "$MEET_DIR" ] && [ -f "$MEET_DIR/docker-compose.yml" ]; then
        echo -e "${DIM}Found existing MEET directory, switching to it...${NC}"
        cd "$MEET_DIR"
        pull_latest_or_warn
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

# Pull latest with visibility into branch, before/after hash, and
# behind/ahead. Doesn't fail the install on git errors (the user might
# have intentionally pinned a branch) — but never silently swallows
# them either.
pull_latest_or_warn() {
    [ -d ".git" ] || return 0
    local branch before_hash
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)
    before_hash=$(git rev-parse --short HEAD 2>/dev/null || echo "?")

    if [ -z "$branch" ]; then
        echo -e "  ${YELLOW}!${NC} HEAD is detached at ${before_hash} — skipping pull."
        echo -e "  ${DIM}You'll deploy whatever's at this commit. Run 'git checkout <branch>' first if that's not what you want.${NC}"
        return 0
    fi

    echo -e "  ${DIM}branch:  ${branch}${NC}"
    echo -e "  ${DIM}commit:  ${before_hash}${NC}"

    if ! git fetch origin "$branch" >/dev/null 2>&1; then
        echo -e "  ${YELLOW}!${NC} git fetch failed (network?) — continuing with local copy."
        return 0
    fi

    local behind ahead
    behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
    ahead=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)
    if [ "$ahead" -gt 0 ] && [ "$behind" -gt 0 ]; then
        echo -e "  ${YELLOW}!${NC} Local branch has diverged from origin/$branch ($ahead local, $behind remote)."
        echo -e "  ${DIM}Skipping pull. Resolve manually if you want the remote commits.${NC}"
        return 0
    fi
    if [ "$behind" -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} already up to date"
        return 0
    fi

    if git pull --ff-only origin "$branch" >/dev/null 2>&1; then
        local after_hash
        after_hash=$(git rev-parse --short HEAD)
        echo -e "  ${GREEN}✓${NC} pulled $behind commit(s); now at $after_hash"
    else
        echo -e "  ${YELLOW}!${NC} pull failed (likely uncommitted changes) — continuing with local copy."
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

    # Check for existing SSL certificate
    echo ""
    if [ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ] && [ -f "/etc/letsencrypt/live/$domain/privkey.pem" ]; then
        # Existing certificate found — check if it's still valid
        local cert_expiry
        cert_expiry=$($SUDO openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$domain/fullchain.pem" 2>/dev/null | cut -d= -f2)

        if [ -n "$cert_expiry" ] && $SUDO openssl x509 -checkend 86400 -noout -in "/etc/letsencrypt/live/$domain/fullchain.pem" 2>/dev/null; then
            echo -e "${GREEN}✓${NC} Valid SSL certificate found for $domain"
            echo -e "${DIM}  Expires: $cert_expiry${NC}"

            # Install the full Nginx config (certs already exist)
            $SUDO cp "nginx.meet.$domain.conf" "/etc/nginx/sites-available/meet"

            if $SUDO nginx -t 2>/dev/null; then
                $SUDO systemctl reload nginx 2>/dev/null || $SUDO service nginx reload 2>/dev/null || true
                echo -e "${GREEN}✓${NC} Nginx configured with existing SSL certificate"
            else
                echo -e "${YELLOW}!${NC} Nginx config test failed — check /etc/nginx/sites-available/meet"
            fi
        else
            echo -e "${YELLOW}!${NC} SSL certificate for $domain exists but is expired or expiring soon"
            echo -e "${DIM}  Attempting renewal...${NC}"
            if $SUDO certbot renew --cert-name "$domain" --non-interactive 2>&1; then
                echo -e "${GREEN}✓${NC} SSL certificate renewed successfully"

                $SUDO cp "nginx.meet.$domain.conf" "/etc/nginx/sites-available/meet"

                if $SUDO nginx -t 2>/dev/null; then
                    $SUDO systemctl reload nginx 2>/dev/null || $SUDO service nginx reload 2>/dev/null || true
                    echo -e "${GREEN}✓${NC} Nginx configured with renewed SSL certificate"
                else
                    echo -e "${YELLOW}!${NC} Nginx config test failed — check /etc/nginx/sites-available/meet"
                fi
            else
                echo -e "${RED}✗${NC} Certificate renewal failed. Try manually: sudo certbot renew"
            fi
        fi
    else
        # No existing certificate — obtain a new one
        echo -e "${BOLD}Obtaining SSL certificate...${NC}"
        echo ""
        echo "  Certbot will request a certificate from Let's Encrypt."
        echo "  Make sure your domain ($domain) points to this server's IP."
        echo ""

        # Start Nginx with a temporary HTTP-only config for the ACME challenge
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

        # Pre-check: test nginx config before using --nginx plugin
        # The --nginx plugin requires ALL nginx configs to be valid, not just ours.
        # If another site has a broken config, --nginx will fail entirely.
        local certbot_ok=false
        if $SUDO nginx -t 2>&1; then
            echo -e "${DIM}  Nginx config OK — using nginx plugin${NC}"
            if $SUDO certbot --nginx -d "$domain" --non-interactive --agree-tos --register-unsafely-without-email --redirect 2>&1; then
                certbot_ok=true
            fi
        else
            echo -e "${YELLOW}!${NC} Existing nginx configuration has errors (from another site)"
            echo -e "${DIM}  Falling back to webroot authentication...${NC}"
            echo ""
            $SUDO mkdir -p /var/www/html
            if $SUDO certbot certonly --webroot -w /var/www/html -d "$domain" --non-interactive --agree-tos --register-unsafely-without-email 2>&1; then
                certbot_ok=true
            fi
        fi

        if [ "$certbot_ok" = true ]; then
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
            echo "    - DNS for $domain does not point to this server"
            echo "    - Port 80 is blocked by a firewall"
            echo "    - Let's Encrypt rate limits have been reached"
            echo "    - Another site's nginx config has syntax errors (fix with: sudo nginx -t)"
            echo ""
            echo "  You can retry manually later:"
            echo "    sudo certbot certonly --webroot -w /var/www/html -d $domain"
            echo "    sudo certbot --nginx -d $domain"
            echo ""
            echo "  The Docker services are running. Once SSL is configured,"
            echo "  install the full Nginx config:"
            echo "    sudo cp nginx.meet.$domain.conf /etc/nginx/sites-available/meet"
            echo "    sudo nginx -t && sudo systemctl reload nginx"

            # Clean up the temporary nginx config so it doesn't interfere
            # with other reverse proxies (e.g., ProxyPilot) on the same server
            $SUDO rm -f /etc/nginx/sites-enabled/meet
            $SUDO rm -f /etc/nginx/sites-available/meet
            $SUDO systemctl reload nginx 2>/dev/null || $SUDO service nginx reload 2>/dev/null || true
        fi
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

# ProxyPilot / External Reverse Proxy mode
install_with_proxypilot() {
    echo ""
    echo -e "${BOLD}Deploy with External Reverse Proxy (ProxyPilot, NPM, etc.)${NC}"
    echo ""
    echo "  This mode is for servers that already run a reverse proxy manager"
    echo "  like ProxyPilot or Nginx Proxy Manager."
    echo ""
    echo "  Each service gets its own subdomain:"
    echo "    • meet.example.com         → Frontend"
    echo "    • api.meet.example.com     → API"
    echo "    • livekit.meet.example.com → LiveKit (WebRTC signaling)"
    echo ""

    read -p "Enter your domain (e.g., meet.example.com): " domain
    if [ -z "$domain" ]; then
        echo -e "${RED}Domain is required.${NC}"
        exit 1
    fi

    echo ""
    echo -e "${BOLD}Required DNS records:${NC}"
    echo "  • ${CYAN}$domain${NC}            → this server's IP"
    echo "  • ${CYAN}api.$domain${NC}        → this server's IP"
    echo "  • ${CYAN}livekit.$domain${NC}    → this server's IP"
    echo ""
    read -p "Are DNS records configured? [y/N]: " dns_ok
    if [[ ! "$dns_ok" =~ ^[Yy]$ ]]; then
        echo ""
        echo "  Please configure DNS records first, then re-run the installer."
        exit 0
    fi

    # Detect public IP for LiveKit
    local public_ip
    public_ip=$(curl -4 -s --connect-timeout 5 https://ifconfig.me 2>/dev/null || \
                curl -4 -s --connect-timeout 5 https://api.ipify.org 2>/dev/null || \
                curl -4 -s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null || \
                echo "")

    if [ -n "$public_ip" ]; then
        echo -e "${GREEN}✓${NC} Detected public IP: $public_ip"
    else
        read -p "Could not detect public IP. Enter your server's public IPv4: " public_ip
    fi

    # Set frontend port (default 3002 to avoid conflicts)
    local frontend_port
    frontend_port=$(find_available_port 3002)

    # Create .env
    cat > .env << ENV_FILE
# MEET Configuration — ProxyPilot / External Reverse Proxy Mode
MEET_DOMAIN=$domain
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_NODE_IP=$public_ip
MEET_FRONTEND_PORT=$frontend_port
MEET_API_PORT=8080
ENV_FILE

    echo -e "${GREEN}✓${NC} Configuration saved to .env"

    # Check if containers are already running
    if docker compose -f docker-compose.proxypilot.yml ps 2>/dev/null | grep -q "meet"; then
        echo -e "${YELLOW}! MEET containers already exist${NC}"
        read -p "  Stop and rebuild? [y/N]: " rebuild
        if [[ "$rebuild" =~ ^[Yy]$ ]]; then
            docker compose -f docker-compose.proxypilot.yml down --remove-orphans
        else
            echo ""
            echo -e "${GREEN}✓ MEET is already running!${NC}"
            exit 0
        fi
    fi

    echo ""
    echo "Building and starting Docker containers..."
    echo ""

    if docker compose -f docker-compose.proxypilot.yml build --no-cache && docker compose -f docker-compose.proxypilot.yml up -d; then
        echo ""
        echo -e "${GREEN}✓${NC} Docker containers started"
    else
        echo ""
        echo -e "${RED}✗ Failed to start Docker containers${NC}"
        echo "  Check logs with: docker compose -f docker-compose.proxypilot.yml logs"
        exit 1
    fi

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${GREEN}  ✓ MEET containers are running!${NC}"
    echo ""
    echo -e "  ${BOLD}Now create 3 proxy services in your reverse proxy manager:${NC}"
    echo ""
    echo -e "  ${CYAN}1. Frontend${NC}"
    echo "     Domain:    $domain"
    echo "     Target:    127.0.0.1:$frontend_port"
    echo "     WebSocket: ON"
    echo "     SSL:       ON (auto-obtain)"
    echo ""
    echo -e "  ${CYAN}2. API${NC}"
    echo "     Domain:    api.$domain"
    echo "     Target:    127.0.0.1:8080"
    echo "     WebSocket: ON"
    echo "     SSL:       ON (auto-obtain)"
    echo ""
    echo -e "  ${CYAN}3. LiveKit${NC}"
    echo "     Domain:    livekit.$domain"
    echo "     Target:    127.0.0.1:7880"
    echo "     WebSocket: ON"
    echo "     SSL:       ON (auto-obtain)"
    echo ""
    echo -e "  ${BOLD}Firewall:${NC} Ensure these ports are open:"
    echo "     80/tcp, 443/tcp    (HTTP/HTTPS for proxy)"
    echo "     7881/tcp           (LiveKit RTC over TCP)"
    echo "     50000-50100/udp    (LiveKit RTC media)"
    echo ""
    echo -e "  ${BOLD}After creating proxies, open:${NC}"
    echo -e "    → ${CYAN}https://$domain${NC}"
    echo ""
    echo -e "  ${BOLD}Commands:${NC}"
    echo -e "    Stop:    ${YELLOW}docker compose -f docker-compose.proxypilot.yml down${NC}"
    echo -e "    Logs:    ${YELLOW}docker compose -f docker-compose.proxypilot.yml logs -f${NC}"
    echo -e "    Restart: ${YELLOW}docker compose -f docker-compose.proxypilot.yml restart${NC}"
    echo ""
    echo -e "  ${BOLD}Configuration:${NC}"
    echo -e "    Edit ${YELLOW}.env${NC} to change settings"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# External reverse proxy mode (LXC / bare-metal where the host already
# terminates TLS — e.g. host Caddy fronting an Incus container).
install_with_external_proxy() {
    echo ""
    echo -e "${BOLD}Behind external reverse proxy (LXC / bare-metal)${NC}"
    echo ""
    echo "  This mode is for hosts that already run a reverse proxy"
    echo "  (host Caddy, host nginx, NPM, …) as the single TLS edge."
    echo ""
    echo "  This stack ships NO TLS, NO ACME, NO bundled proxy."
    echo "  Every externally-routed port binds on 0.0.0.0 so the"
    echo "  host proxy can reach it across the bridge."
    echo ""

    local compose_dir="deploy/external-proxy"
    if [ ! -f "$compose_dir/docker-compose.yml" ] || [ ! -f "$compose_dir/.env.example" ]; then
        echo -e "${RED}✗ $compose_dir/docker-compose.yml not found.${NC}"
        echo "  Are you running install.sh from the repo root?"
        exit 1
    fi

    read -p "Public hostname (e.g., meet.example.com): " public_host
    if [ -z "$public_host" ]; then
        echo -e "${RED}Public hostname is required.${NC}"
        exit 1
    fi

    echo ""
    echo -e "${BOLD}URL layout:${NC}"
    echo -e "  ${CYAN}[1]${NC} Single-domain (one DNS record, path-prefix routing)"
    echo "      https://$public_host/, /api, /livekit"
    echo -e "  ${CYAN}[2]${NC} Three-domain (subdomain split)"
    echo "      meet.$public_host, api.$public_host, livekit.$public_host"
    echo ""
    read -p "Enter choice [1]: " layout
    layout=${layout:-1}

    local public_base_url=""
    local public_api_url=""
    local public_livekit_url=""
    case "$layout" in
        1)
            public_base_url="https://$public_host"
            public_api_url=""
            public_livekit_url=""
            ;;
        2)
            public_base_url="https://$public_host"
            public_api_url="https://api.$public_host"
            public_livekit_url="wss://livekit.$public_host"
            ;;
        *)
            echo -e "${RED}Invalid choice. Exiting.${NC}"
            exit 1
            ;;
    esac

    # Detect host public IP (used by LiveKit so ICE candidates point at a
    # routable address, not the container's bridge IP).
    local public_ip
    public_ip=$(curl -4 -s --connect-timeout 5 https://ifconfig.me 2>/dev/null || \
                curl -4 -s --connect-timeout 5 https://api.ipify.org 2>/dev/null || \
                curl -4 -s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null || \
                echo "")
    if [ -n "$public_ip" ]; then
        echo -e "${GREEN}✓${NC} Detected host public IP: $public_ip"
        read -p "Use this for LIVEKIT_NODE_IP? [Y/n]: " accept_ip
        if [[ "$accept_ip" =~ ^[Nn]$ ]]; then
            read -p "Enter host's public IPv4: " public_ip
        fi
    else
        read -p "Could not auto-detect. Enter host's public IPv4 (blank = STUN auto-detect): " public_ip
    fi

    # LiveKit credentials. Single source of truth: the .env file.
    # On rerun we REUSE existing keys instead of regenerating, otherwise
    # meet-api and the livekit container drift apart and every /api/rooms
    # call fails with "Unauthorized: invalid API key" (login still works
    # because login never touches LiveKit, so the breakage is invisible
    # until the admin panel opens). The same .env value is mirrored into
    # LIVEKIT_KEYS so the livekit container loads the matching pair —
    # don't split key generation across two files.
    local lk_key=""
    local lk_secret=""
    if [ -f "$compose_dir/.env" ]; then
        lk_key=$(grep -E '^LIVEKIT_API_KEY=' "$compose_dir/.env" 2>/dev/null \
                 | tail -n1 | cut -d= -f2-)
        lk_secret=$(grep -E '^LIVEKIT_API_SECRET=' "$compose_dir/.env" 2>/dev/null \
                    | tail -n1 | cut -d= -f2-)
    fi
    local lk_keys_reused=0
    if [ -n "$lk_key" ] && [ -n "$lk_secret" ]; then
        lk_keys_reused=1
        echo -e "${GREEN}✓${NC} Reusing existing LiveKit credentials from $compose_dir/.env"
    else
        lk_key="meet_$(openssl rand -hex 6 2>/dev/null || head -c 12 /dev/urandom | xxd -p)"
        lk_secret=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
    fi

    # TURN config. Reuse the previous .env's values on rerun; only ask the
    # operator if we're starting fresh. Cellular users need TURN; without
    # it, calls fail on cellular even when wifi works perfectly.
    #
    # We deploy a dedicated coturn container (not LiveKit's built-in TURN).
    # The cert is bind-mounted live from the host's reverse proxy
    # (ProxyPilot's Caddy / host certbot / etc.) at TURN_CERT_MOUNT, set
    # up once on the host via mount-cert.sh. Rotations propagate
    # automatically; MEET never holds a copy.
    local turn_enabled="false"
    local turn_domain=""
    local turn_username=""
    local turn_password=""
    local turn_cert_mount=""
    if [ -f "$compose_dir/.env" ]; then
        turn_enabled=$(grep -E '^TURN_ENABLED=' "$compose_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
        turn_domain=$(grep -E '^TURN_DOMAIN=' "$compose_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
        turn_username=$(grep -E '^TURN_USERNAME=' "$compose_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
        turn_password=$(grep -E '^TURN_PASSWORD=' "$compose_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
        turn_cert_mount=$(grep -E '^TURN_CERT_MOUNT=' "$compose_dir/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
        turn_enabled=${turn_enabled:-false}
    fi
    if [ "$turn_enabled" != "true" ]; then
        echo ""
        echo -e "  ${BOLD}TURN server (cellular / restrictive-network fallback)${NC}"
        echo "    Cellular carriers use symmetric NAT — WebRTC's STUN-based hole punching"
        echo "    can't get through. Without TURN, phone-on-cellular calls fail even when"
        echo "    wifi works. Deploys a dedicated coturn container alongside livekit."
        echo "    Single-domain (reuse the cert your reverse proxy already serves)"
        echo "    is the default; runs unattended unless you explicitly opt out."
        echo ""

        # Default ON. The opt-out exists for the rare operator who really
        # doesn't want a TURN relay (testing, intranet-only, etc.). For
        # everyone else, this is the path that makes cellular work.
        # Non-interactive runs (no TTY) just take the default.
        local enable_turn="Y"
        if [ -t 0 ] && [ -t 1 ]; then
            read -p "  Enable coturn? [Y/n]: " enable_turn
        else
            echo "  ${DIM}(non-interactive run — enabling by default)${NC}"
        fi
        if [[ ! "$enable_turn" =~ ^[Nn]$ ]]; then
            turn_enabled="true"

            # Cert mode: single-domain is the default and the single-press
            # path. Operators who want the dedicated subdomain say so by
            # answering "2"; everything else takes the default.
            echo ""
            echo "  Cert reuse:"
            echo "    [1] Single-domain — reuse the cert your reverse proxy already serves"
            echo "        for $public_host. No new DNS record. (recommended, default)"
            echo "    [2] Dedicated turn.$public_host — separate cert, separate DNS record."
            echo ""
            local cert_mode="1"
            if [ -t 0 ] && [ -t 1 ]; then
                read -p "  Cert mode [1]: " cert_mode
                cert_mode=${cert_mode:-1}
            fi
            case "$cert_mode" in
                2)  turn_domain="turn.$public_host" ;;
                *)  turn_domain="$public_host" ;;
            esac
            if [ -t 0 ] && [ -t 1 ]; then
                read -p "  TURN hostname [$turn_domain]: " turn_domain_in
                turn_domain="${turn_domain_in:-$turn_domain}"
            fi
        else
            turn_enabled="false"
        fi
    fi

    # Generate creds if we don't already have them. Same idempotency rule
    # as the LiveKit keys: never regenerate if .env already has them, so
    # already-issued JWTs (with embedded TURN creds) keep working.
    local turn_cert_file=""
    local turn_key_file=""
    if [ "$turn_enabled" = "true" ]; then
        if [ -z "$turn_username" ]; then
            turn_username="meet"
        fi
        if [ -z "$turn_password" ]; then
            turn_password=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p)
        fi
        # Default mount path matches mount-cert.sh's default. Fall back
        # to ./tls if the operator hasn't run mount-cert.sh on the host
        # yet — that path works for the manual-copy fallback.
        if [ -z "$turn_cert_mount" ]; then
            if [ -d "/var/meet-tls" ]; then
                turn_cert_mount="/var/meet-tls"
            else
                turn_cert_mount="./tls"
                mkdir -p "$compose_dir/tls"
            fi
        fi
        # Caddy stores certs as <hostname>.{crt,key}. install.sh fills
        # these in based on TURN_DOMAIN; coturn reads them via the
        # rendered turnserver.conf.
        turn_cert_file="$turn_domain.crt"
        turn_key_file="$turn_domain.key"

        # Validate cert files. Bind-mount path means the files might be
        # there already (host's Caddy is writing them); just check.
        # TURN_CERT_MOUNT can be absolute (e.g. /var/meet-tls) or
        # relative to the compose dir (e.g. ./tls). Resolve to an
        # absolute-from-here path so stat() works from this cwd.
        local _mount_abs
        case "$turn_cert_mount" in
            /*) _mount_abs="$turn_cert_mount" ;;
            *)  _mount_abs="$compose_dir/${turn_cert_mount#./}" ;;
        esac
        local cert_path="$_mount_abs/$turn_cert_file"
        local key_path="$_mount_abs/$turn_key_file"
        local turn_uid="0"
        local turn_gid="0"
        if [ ! -d "$_mount_abs" ]; then
            echo ""
            echo -e "  ${YELLOW}!${NC} TURN_CERT_MOUNT (${turn_cert_mount}) doesn't exist in this LXC."
            echo -e "  ${BOLD}Run on the Incus host (NOT inside this LXC):${NC}"
            echo -e "    ${YELLOW}sudo bash $compose_dir/mount-cert.sh${NC}"
            echo "  Then re-run install.sh / update.sh. coturn won't start until the"
            echo "  cert is reachable, but the rest of the stack will be fine."
        elif [ ! -f "$cert_path" ] || [ ! -f "$key_path" ]; then
            echo ""
            echo -e "  ${YELLOW}!${NC} Cert files not found at ${turn_cert_mount}/${turn_domain}.{crt,key}"
            echo -e "  Make sure your reverse proxy has issued a cert for ${BOLD}${turn_domain}${NC},"
            echo -e "  or re-run ${YELLOW}sudo bash $compose_dir/mount-cert.sh${NC} on the Incus host"
            echo "  if you're using a different cert location."
            ls -1 "$turn_cert_mount/" 2>/dev/null \
                | head -5 \
                | sed "s|^|    ${turn_cert_mount}/|"
        else
            echo -e "  ${GREEN}✓${NC} cert files found at ${turn_cert_mount}/${turn_domain}.{crt,key}"
            # Detect the cert's owner uid/gid. Caddy stores certs as
            # 0600 owned by its own uid; coturn must run as that uid
            # inside its container or it can't read the cert and the
            # TLS listener silently doesn't bind. Falls back to 0:0
            # (root, can read anything) if stat fails for any reason.
            turn_uid=$(stat -c '%u' "$cert_path" 2>/dev/null || echo "0")
            turn_gid=$(stat -c '%g' "$cert_path" 2>/dev/null || echo "0")
            if [ "$turn_uid" != "0" ] || [ "$turn_gid" != "0" ]; then
                echo -e "  ${DIM}cert owned by uid:gid ${turn_uid}:${turn_gid} — coturn will run with that user${NC}"
            fi
        fi
    fi

    cat > "$compose_dir/.env" << ENV_FILE
# MEET Configuration — External Reverse Proxy Mode
PUBLIC_BASE_URL=$public_base_url
PUBLIC_API_URL=$public_api_url
PUBLIC_LIVEKIT_URL=$public_livekit_url

BIND_HOST=0.0.0.0

MEET_FRONTEND_PORT=3000
MEET_API_PORT=8080
MEET_LIVEKIT_WS_PORT=7880
MEET_LIVEKIT_TCP_PORT=7881

LIVEKIT_UDP_PORT_RANGE_START=50000
LIVEKIT_UDP_PORT_RANGE_END=60000
LIVEKIT_NODE_IP=$public_ip

# LiveKit auth — DO NOT EDIT EITHER OF THESE WITHOUT UPDATING LIVEKIT_KEYS BELOW.
# meet-api reads LIVEKIT_API_KEY/SECRET; livekit reads LIVEKIT_KEYS. The two
# must agree. Re-running install.sh preserves these values.
LIVEKIT_API_KEY=$lk_key
LIVEKIT_API_SECRET=$lk_secret
LIVEKIT_KEYS=$lk_key: $lk_secret

# TURN — cellular / symmetric-NAT fallback. Deployed via the coturn
# service (profile-gated). The turnserver.conf is rendered from
# turnserver.conf.template using these values; the password is also
# embedded in /api/token's iceServers field for the browser.
#
# TURN_CERT_MOUNT is the path INSIDE the LXC where the host's reverse-
# proxy cert dir is bind-mounted (run mount-cert.sh on the Incus host).
# TURN_CERT_FILE / TURN_KEY_FILE are the filenames under that path
# (Caddy uses <hostname>.{crt,key}).
TURN_ENABLED=$turn_enabled
TURN_DOMAIN=$turn_domain
TURN_USERNAME=$turn_username
TURN_PASSWORD=$turn_password
TURN_TLS_PORT=5349
TURN_UDP_PORT=3478
TURN_RELAY_RANGE_START=30000
TURN_RELAY_RANGE_END=32000
TURN_CERT_MOUNT=$turn_cert_mount
TURN_CERT_FILE=$turn_cert_file
TURN_KEY_FILE=$turn_key_file
# uid/gid that owns the cert files. coturn must run as this uid to read
# them — otherwise the TLS listener on tcp/5349 silently doesn't bind.
# Set automatically from `stat` at install/update time; default 0:0 is
# "run as root" which can read anything.
TURN_UID=$turn_uid
TURN_GID=$turn_gid
ENV_FILE
    echo -e "${GREEN}✓${NC} Configuration saved to $compose_dir/.env"
    if [ "$lk_keys_reused" = "1" ]; then
        echo -e "  ${DIM}LiveKit auth: ${lk_key:0:14}…  (reused — meet-api ↔ livekit pair preserved)${NC}"
    else
        echo -e "  ${DIM}LiveKit auth: ${lk_key:0:14}…  (newly generated — installed in both meet-api and livekit)${NC}"
    fi

    # Render turnserver.conf from the template if TURN is enabled. The
    # bridge IP gets baked in here so coturn knows which interface to
    # relay traffic on; if the bridge IP changes, re-run install.sh
    # (or update.sh, which calls render_turnserver_conf via the same
    # logic). The rendered file is gitignored.
    if [ "$turn_enabled" = "true" ]; then
        local detected_bridge_ip
        detected_bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
                             | awk '$2 !~ /^(docker|br-|veth|cni|lxcbr|virbr|tun|tap)/ {print $4}' \
                             | cut -d/ -f1 | head -n1)
        detected_bridge_ip=${detected_bridge_ip:-127.0.0.1}
        sed -e "s|@TURN_UDP_PORT@|3478|g" \
            -e "s|@TURN_TLS_PORT@|5349|g" \
            -e "s|@TURN_RELAY_RANGE_START@|30000|g" \
            -e "s|@TURN_RELAY_RANGE_END@|32000|g" \
            -e "s|@TURN_DOMAIN@|$turn_domain|g" \
            -e "s|@TURN_USERNAME@|$turn_username|g" \
            -e "s|@TURN_PASSWORD@|$turn_password|g" \
            -e "s|@TURN_CERT_FILE@|$turn_cert_file|g" \
            -e "s|@TURN_KEY_FILE@|$turn_key_file|g" \
            -e "s|@BRIDGE_IP@|$detected_bridge_ip|g" \
            -e "s|@LIVEKIT_NODE_IP@|$public_ip|g" \
            "$compose_dir/turnserver.conf.template" > "$compose_dir/turnserver.conf"
        echo -e "${GREEN}✓${NC} Rendered $compose_dir/turnserver.conf for TURN_DOMAIN=$turn_domain"
    fi

    # Render livekit.yaml from livekit.yaml.template. When TURN is enabled,
    # populate rtc.turn_servers so LiveKit advertises coturn to clients
    # via the participant join response — a redundant path alongside
    # meet-api's /api/token iceServers, so cellular still works if either
    # path fails for any reason.
    if [ -f "$compose_dir/livekit.yaml.template" ]; then
        local turn_servers_block=""
        if [ "$turn_enabled" = "true" ]; then
            turn_servers_block=$(cat <<TURN_BLOCK

  turn_servers:
    - host: $turn_domain
      port: 5349
      protocol: tls
      username: $turn_username
      credential: $turn_password
TURN_BLOCK
)
        fi
        # Use awk to do the substitution because the block has newlines
        # and special chars that would confuse sed.
        awk -v block="$turn_servers_block" '
            { gsub(/@TURN_SERVERS_BLOCK@/, block); print }
        ' "$compose_dir/livekit.yaml.template" > "$compose_dir/livekit.yaml"
        echo -e "${GREEN}✓${NC} Rendered $compose_dir/livekit.yaml${turn_servers_block:+ (with turn_servers block)}"
    fi

    echo ""
    echo "Building and starting Docker containers..."
    echo "(Using cached layers — set FORCE_REBUILD=1 to rebuild from scratch.)"
    echo ""
    local build_args=""
    if [ "${FORCE_REBUILD:-}" = "1" ]; then
        build_args="--no-cache"
    fi
    # --profile turn includes the coturn service when TURN_ENABLED=true.
    # Without the profile, compose ignores any service marked profiles:[turn].
    local compose_profiles=""
    if [ "$turn_enabled" = "true" ]; then
        compose_profiles="--profile turn"
    fi
    if ! (cd "$compose_dir" && docker compose $compose_profiles build $build_args && docker compose $compose_profiles up -d); then
        echo -e "${RED}✗ Failed to build or start Docker containers${NC}"
        echo "  Logs: (cd $compose_dir && docker compose logs)"
        exit 1
    fi

    # Verify containers actually came up. `docker compose up -d` exits 0 even
    # if a container immediately crashes, so the proxy ends up probing ports
    # that nobody is listening on.
    echo ""
    echo "Waiting for containers to become healthy..."
    local healthy=0
    for i in $(seq 1 24); do
        local bad
        bad=$(cd "$compose_dir" && docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' \
              | awk '$2 != "running" || ($3 != "" && $3 != "healthy" && $3 != "starting") {print $1}')
        if [ -z "$bad" ]; then
            healthy=1
            break
        fi
        sleep 5
    done

    if [ "$healthy" != "1" ]; then
        echo -e "${RED}✗ One or more containers are not running / not healthy:${NC}"
        (cd "$compose_dir" && docker compose ps)
        echo ""
        echo "  Last 50 log lines per service:"
        (cd "$compose_dir" && docker compose logs --tail 50)
        echo ""
        echo -e "  ${YELLOW}This is usually one of:${NC}"
        echo "    • Out-of-memory during build (LXC memory limit too low for"
        echo "      the Vite build — give the container ≥2 GiB or set a swap)"
        echo "    • Missing security.nesting=true on the LXC profile"
        echo "    • Port already in use on the host"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} All containers running"

    # Detect the bridge IP — the address the host reverse proxy must dial.
    # Filter out Docker's per-network bridges (docker0, br-<hash>, veth*) and
    # CNI/libvirt/lxcbr scaffolding so we don't return e.g. 172.17.0.1, which
    # is only reachable from inside the LXC. The Incus host can route to the
    # LXC's external interface (eth0 → e.g. 10.185.17.131); it cannot route
    # to docker0 inside the LXC. Same filter as info.sh.
    local bridge_ip
    bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
                | awk '$2 !~ /^(docker|br-|veth|cni|lxcbr|virbr|tun|tap)/ {print $4}' \
                | cut -d/ -f1 | head -n1)
    if [ -z "$bridge_ip" ]; then
        # Fallback if the filter eliminated everything.
        bridge_ip=$(ip -4 -o addr show scope global 2>/dev/null \
                    | awk '{print $4}' | cut -d/ -f1 | head -n1)
    fi
    bridge_ip=${bridge_ip:-<bridge-ip>}

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${GREEN}  ✓ MEET is running on this host.${NC}"
    echo ""
    echo -e "  ${BOLD}Next: point your existing reverse proxy at this stack.${NC}"
    echo "  Reference snippets:"
    if [ "$layout" = "1" ]; then
        echo -e "    Caddy: ${YELLOW}$compose_dir/caddy/single-domain.Caddyfile${NC}"
        echo -e "    nginx: ${YELLOW}$compose_dir/nginx/single-domain.conf${NC}"
    else
        echo -e "    Caddy: ${YELLOW}$compose_dir/caddy/three-domain.Caddyfile${NC}"
        echo -e "    nginx: ${YELLOW}$compose_dir/nginx/three-domain.conf${NC}"
    fi
    echo ""
    echo -e "  ${BOLD}Port → service map${NC} (give these to your reverse proxy):"
    echo ""
    printf "     ${BOLD}%-6s %-26s %s${NC}\n" "PROTO" "UPSTREAM" "SERVICE"
    printf "     %-6s ${CYAN}%-26s${NC} %s\n" "HTTP"  "$bridge_ip:3000"          "frontend"
    printf "     %-6s ${CYAN}%-26s${NC} %s\n" "HTTP"  "$bridge_ip:8080"          "meet-api  (/api/*, /ws/*)"
    printf "     %-6s ${CYAN}%-26s${NC} %s\n" "WS"    "$bridge_ip:7880"          "livekit signaling  (24h timeouts)"
    printf "     %-6s ${CYAN}%-26s${NC} %s\n" "TCP"   "$bridge_ip:7881"          "livekit TCP fb  (L4, NOT proxied)"
    printf "     %-6s ${CYAN}%-26s${NC} %s\n" "UDP"   "$bridge_ip:50000-60000"   "livekit RTC media  (L4, NOT proxied)"
    echo ""
    if [ "$layout" = "1" ]; then
        echo -e "  ${BOLD}Routing for ${CYAN}$public_host${NC}:"
        echo -e "    https://$public_host/             → ${CYAN}$bridge_ip:3000${NC}"
        echo -e "    https://$public_host/api/*        → ${CYAN}$bridge_ip:8080${NC}"
        echo -e "    https://$public_host/ws/*         → ${CYAN}$bridge_ip:8080${NC}  (WS)"
        echo -e "    https://$public_host/livekit/*    → ${CYAN}$bridge_ip:7880${NC}  (WS, ${BOLD}strip prefix${NC})"
    else
        echo -e "  ${BOLD}Routing (three-domain):${NC}"
        echo -e "    https://$public_host/             → ${CYAN}$bridge_ip:3000${NC}"
        echo -e "    https://api.$public_host/         → ${CYAN}$bridge_ip:8080${NC}"
        echo -e "    wss://livekit.$public_host/       → ${CYAN}$bridge_ip:7880${NC}  (24h)"
    fi
    echo ""
    echo -e "  ${BOLD}Smoke-test from the host (should all return 200):${NC}"
    echo -e "    ${YELLOW}curl -fsSI http://$bridge_ip:3000/health${NC}"
    echo -e "    ${YELLOW}curl -fsS  http://$bridge_ip:8080/health${NC}"
    echo -e "    ${YELLOW}curl -fsSI http://$bridge_ip:7880/${NC}"
    echo ""
    echo -e "  ${BOLD}Host firewall (internet-facing):${NC}"
    echo "     tcp/443             (HTTPS via your reverse proxy)"
    echo "     tcp/7881            (LiveKit RTC TCP fallback)"
    echo "     udp/50000-60000     (LiveKit RTC media)"
    if [ "$turn_enabled" = "true" ]; then
        echo "     tcp/5349            (TURN-TLS — cellular fallback)"
        echo "     udp/3478            (TURN — STUN/TURN bind)"
        echo "     udp/30000-32000     (TURN relay)"
    fi
    echo ""
    echo -e "  ${BOLD}LXC users:${NC} the livekit container runs with host networking, so"
    echo -e "  ports 7880/7881/50000-60000 already bind on ${CYAN}$bridge_ip${NC}."
    echo -e "  Open the firewall to the internet pointed at that IP. If your"
    echo -e "  bridge isn't directly routable from the WAN, forward with:"
    echo -e "    ${YELLOW}incus config device add <container> rtcudp proxy \\${NC}"
    echo -e "    ${YELLOW}    listen=udp:0.0.0.0:50000-60000 connect=udp:$bridge_ip:50000-60000${NC}"
    echo -e "  (note: connect=$bridge_ip, not 127.0.0.1 — livekit isn't on Docker's loopback)"
    echo ""

    # If TURN was enabled, the cert mount is the one remaining manual
    # step (we run inside the LXC; mount-cert.sh runs on the Incus host).
    # Flag it loudly with the exact one-liner so it isn't missed.
    #
    # Check for the cert FILES, not just the directory — install.sh
    # auto-creates ./tls/ as a fallback before the cert is provisioned,
    # so a directory check is always true and the message never showed.
    if [ "$turn_enabled" = "true" ]; then
        local _cert_path="$compose_dir/$turn_cert_mount/$turn_cert_file"
        # If TURN_CERT_MOUNT is absolute (e.g. /var/meet-tls), use it directly.
        case "$turn_cert_mount" in
            /*) _cert_path="$turn_cert_mount/$turn_cert_file" ;;
        esac
        if [ ! -f "$_cert_path" ]; then
            echo -e "  ${BOLD}${YELLOW}━━━ Final step (run on the Incus host, NOT this LXC) ━━━${NC}"
            echo ""
            echo "  TURN's TLS cert isn't in place yet — coturn started but will fail TLS"
            echo "  handshakes until you give it a real cert. One command does it: idempotent,"
            echo "  auto-discovers ProxyPilot's Caddy / host certbot / host Caddy, then runs"
            echo "  update.sh in the LXC for you so coturn picks up the new cert."
            echo ""
            echo -e "    ${YELLOW}sudo bash <path-to-MEET-on-host>/deploy/external-proxy/mount-cert.sh${NC}"
            echo ""
            echo -e "  ${DIM}Don't have the repo on the host? Pull mount-cert.sh out of the LXC:${NC}"
            echo -e "  ${DIM}    incus file pull <container>/root/MEET/deploy/external-proxy/mount-cert.sh /tmp/mount-cert.sh${NC}"
            echo -e "  ${DIM}    sudo bash /tmp/mount-cert.sh${NC}"
            echo ""
            echo -e "  ${DIM}Looking for $_cert_path inside the LXC.${NC}"
            echo ""
        else
            echo -e "  ${GREEN}✓${NC} TURN cert in place at ${DIM}$_cert_path${NC}"
            echo ""
        fi
    fi
    if [ "$layout" != "1" ]; then
        echo -e "  ${YELLOW}!${NC} ${BOLD}Three-domain mode:${NC} the frontend was built with"
        echo -e "    ${CYAN}PUBLIC_API_URL=$public_api_url${NC}"
        echo -e "    ${CYAN}PUBLIC_LIVEKIT_URL=$public_livekit_url${NC}"
        echo -e "    If you change either, rebuild:"
        echo -e "      ${YELLOW}(cd $compose_dir && docker compose build meet-frontend && docker compose up -d)${NC}"
        echo ""
    fi
    echo -e "  ${BOLD}Reference snippets:${NC}"
    if [ "$layout" = "1" ]; then
        echo -e "    Caddy: ${YELLOW}$compose_dir/caddy/single-domain.Caddyfile${NC}"
        echo -e "    nginx: ${YELLOW}$compose_dir/nginx/single-domain.conf${NC}"
    else
        echo -e "    Caddy: ${YELLOW}$compose_dir/caddy/three-domain.Caddyfile${NC}"
        echo -e "    nginx: ${YELLOW}$compose_dir/nginx/three-domain.conf${NC}"
    fi
    echo ""
    echo -e "  ${BOLD}Re-print this summary anytime:${NC} ${YELLOW}bash $compose_dir/info.sh${NC}"
    echo -e "  ${BOLD}Walk-through:${NC} ${CYAN}docs/install/external-reverse-proxy.md${NC}"
    echo ""
    echo -e "  ${BOLD}Commands:${NC}"
    echo -e "    Stop:    ${YELLOW}(cd $compose_dir && docker compose down)${NC}"
    echo -e "    Logs:    ${YELLOW}(cd $compose_dir && docker compose logs -f)${NC}"
    echo -e "    Restart: ${YELLOW}(cd $compose_dir && docker compose restart)${NC}"
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
    echo -e "  ${CYAN}[4]${NC} Deploy with ProxyPilot / External Proxy"
    echo "      For servers already running ProxyPilot, NPM, or similar"
    echo "      Uses subdomains (api.*, livekit.*) for each service"
    echo ""
    echo -e "  ${CYAN}[5]${NC} Behind external reverse proxy (LXC / bare-metal)"
    echo "      Host already runs Caddy/nginx as the TLS edge"
    echo "      Stack ships NO TLS, binds 0.0.0.0, host proxy reaches it"
    echo ""
    echo -e "  ${CYAN}[6]${NC} Production Mode"
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
            install_with_proxypilot
            ;;
        5)
            install_with_external_proxy
            ;;
        6)
            install_production
            ;;
        *)
            echo -e "${RED}Invalid choice. Exiting.${NC}"
            exit 1
            ;;
    esac
}

main "$@"
