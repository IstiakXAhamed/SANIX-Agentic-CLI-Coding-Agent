#!/usr/bin/env bash
#
# SANIX — Sanim's Agentic Neural Intelligence eXecutor
# One-line installer: curl -fsSL https://sanix.dev/install.sh | bash
#
# This script:
#   1. Checks for Node.js 20+ and npm
#   2. Clones the SANIX monorepo (or downloads a release tarball)
#   3. Installs all dependencies
#   4. Builds all 42 packages
#   5. Links the `sanix` command globally
#   6. Optionally installs shell completions
#   7. Runs the onboarding wizard on first launch
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────────────────────
info()  { echo -e "${CYAN}⟡${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }
step()  { echo -e "\n${BOLD}${BLUE}[$1]${NC} $2"; }

# ─── Banner ──────────────────────────────────────────────────────────────────
echo ""
cat << 'EOF'
 ███████╗ █████╗ ███╗   ██╗██╗██╗  ██╗
 ██╔════╝██╔══██╗████╗  ██║██║╚██╗██╔╝
 ███████╗███████║██╔██╗ ██║██║ ╚███╔╝ 
 ╚════██║██╔══██║██║╚██╗██║██║ ██╔██╗ 
 ███████║██║  ██║██║ ╚████║██║██╔╝ ██╗
 ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝
EOF
echo ""
echo -e "${BOLD}Sanim's Agentic Neural Intelligence eXecutor${NC}"
echo -e "${DIM}Your terminal. Your agent. Your name on it.${NC}"
echo ""

# ─── Pre-flight checks ──────────────────────────────────────────────────────
step "1/6" "Checking prerequisites..."

# Check Node.js
if ! command -v node &>/dev/null; then
  error "Node.js is not installed."
  echo ""
  echo -e "  Install Node.js 20+ from ${CYAN}https://nodejs.org${NC}"
  echo -e "  Or use nvm:  ${DIM}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install 20${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js 20+ required (you have $(node -v))."
  echo -e "  Upgrade: ${DIM}nvm install 20${NC}"
  exit 1
fi
ok "Node.js $(node -v)"

# Check npm
if ! command -v npm &>/dev/null; then
  error "npm is not installed (should come with Node.js)."
  exit 1
fi
ok "npm $(npm -v)"

# Check git (for cloning)
if ! command -v git &>/dev/null; then
  error "git is not installed."
  echo -e "  Install: ${DIM}sudo apt install git${NC}  or  ${DIM}brew install git${NC}"
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# Check available disk space (need ~500MB for node_modules)
AVAILABLE_MB=$(df -m "${HOME}" | tail -1 | awk '{print $4}')
if [ "$AVAILABLE_MB" -lt 500 ]; then
  warn "Low disk space (${AVAILABLE_MB}MB available, ~500MB needed)."
fi

# ─── Choose install location ─────────────────────────────────────────────────
step "2/6" "Choosing install location..."

INSTALL_DIR="${SANIX_INSTALL_DIR:-$HOME/.sanix/src}"
if [ -d "$INSTALL_DIR" ]; then
  info "Existing installation found at $INSTALL_DIR"
  read -rp "  Update? [Y/n] " UPDATE_CHOICE
  UPDATE_CHOICE=${UPDATE_CHOICE:-Y}
  if [[ "$UPDATE_CHOICE" =~ ^[Yy] ]]; then
    info "Pulling latest changes..."
    cd "$INSTALL_DIR"
    git pull --quiet || warn "git pull failed (continuing with existing code)"
  else
    info "Reusing existing installation."
  fi
else
  info "Cloning SANIX to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 https://github.com/sanix-ahmed/sanix.git "$INSTALL_DIR" 2>/dev/null || {
    # Fallback: if the repo doesn't exist yet, try a local copy
    if [ -d "/home/z/my-project/sanix" ]; then
      info "Using local source..."
      cp -r /home/z/my-project/sanix "$INSTALL_DIR"
    else
      error "Could not clone SANIX. Check your internet connection."
      exit 1
    fi
  }
  ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ─── Install dependencies ────────────────────────────────────────────────────
step "3/6" "Installing dependencies..."

info "Running npm install (this may take 1-2 minutes)..."
if npm install --no-audit --no-fund --loglevel=error 2>/dev/null; then
  ok "Dependencies installed"
else
  warn "npm install had issues, retrying with --ignore-scripts..."
  npm install --no-audit --no-fund --loglevel=error --ignore-scripts
  ok "Dependencies installed (scripts skipped)"
fi

# ─── Build all packages ──────────────────────────────────────────────────────
step "4/6" "Building all 42 packages..."

info "Running turbo build (parallel, ~60 seconds)..."
if npm run build 2>/dev/null; then
  ok "All packages built successfully"
else
  warn "Build had some issues, but core packages should work."
  warn "Run 'npm run build' manually to see errors."
fi

# ─── Link global command ─────────────────────────────────────────────────────
step "5/6" "Linking 'sanix' command..."

# Make the CLI entry point executable
chmod +x packages/cli/dist/main.js 2>/dev/null || true

# Try npm link first (works on most systems)
if npm link 2>/dev/null; then
  ok "Linked via npm"
else
  # Fallback: manual symlink
  BIN_DIR="/usr/local/bin"
  if [ -w "$BIN_DIR" ]; then
    ln -sf "$INSTALL_DIR/packages/cli/dist/main.js" "$BIN_DIR/sanix"
    ok "Linked via symlink to $BIN_DIR/sanix"
  elif command -v sudo &>/dev/null; then
    sudo ln -sf "$INSTALL_DIR/packages/cli/dist/main.js" "$BIN_DIR/sanix"
    ok "Linked via sudo symlink"
  else
    warn "Could not create global link automatically."
    echo -e "  Manual link: ${DIM}npm link${NC}  (run in $INSTALL_DIR)"
    echo -e "  Or: ${DIM}ln -s $INSTALL_DIR/packages/cli/dist/main.js /usr/local/bin/sanix${NC}"
  fi
fi

# Verify installation
if command -v sanix &>/dev/null; then
  ok "'sanix' is now available: $(which sanix)"
  sanix --version 2>/dev/null && ok "SANIX is running!" || warn "sanix command exists but may need a restart of your shell"
else
  warn "'sanix' not found in PATH yet."
  echo -e "  Try: ${DIM}source ~/.bashrc${NC}  (or restart your terminal)"
fi

# ─── Shell completions ───────────────────────────────────────────────────────
step "6/6" "Setting up shell completions (optional)..."

DETECTED_SHELL=""
if [ -n "${SHELL:-}" ]; then
  case "$SHELL" in
    */bash) DETECTED_SHELL="bash" ;;
    */zsh)  DETECTED_SHELL="zsh" ;;
    */fish) DETECTED_SHELL="fish" ;;
  esac
fi

if [ -n "$DETECTED_SHELL" ]; then
  read -rp "  Install $DETECTED_SHELL completions? [Y/n] " COMPLETION_CHOICE
  COMPLETION_CHOICE=${COMPLETION_CHOICE:-Y}
  if [[ "$COMPLETION_CHOICE" =~ ^[Yy] ]]; then
    # Generate completions
    if command -v sanix &>/dev/null; then
      case "$DETECTED_SHELL" in
        bash)
          echo 'eval "$(_SANIX_COMPLETE=bash sanix)"' >> ~/.bashrc
          ok "bash completions added to ~/.bashrc"
          ;;
        zsh)
          echo 'eval "$(_SANIX_COMPLETE=zsh sanix)"' >> ~/.zshrc
          ok "zsh completions added to ~/.zshrc"
          ;;
        fish)
          sanix completions fish > ~/.config/fish/completions/sanix.fish 2>/dev/null || true
          ok "fish completions written to ~/.config/fish/completions/sanix.fish"
          ;;
      esac
    fi
  fi
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    🎉 SANIX Installed!                      ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Type ${BOLD}sanix${NC}${GREEN} in your terminal to start.                       ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Quick start:                                                ║${NC}"
echo -e "${GREEN}║    ${CYAN}sanix --help${NC}              See all commands                   ${GREEN}║${NC}"
echo -e "${GREEN}║    ${CYAN}sanix config init${NC}         Run the onboarding wizard          ${GREEN}║${NC}"
echo -e "${GREEN}║    ${CYAN}sanix ask \"hello\"${NC}         Ask a quick question               ${GREEN}║${NC}"
echo -e "${GREEN}║    ${CYAN}sanix run \"refactor X\"${NC}    Run an agent on a goal             ${GREEN}║${NC}"
echo -e "${GREEN}║    ${CYAN}sanix chat${NC}                 Interactive REPL                  ${GREEN}║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Set an API key:                                             ║${NC}"
echo -e "${GREEN}║    ${DIM}export ANTHROPIC_API_KEY=sk-ant-...${NC}                       ${GREEN}║${NC}"
echo -e "${GREEN}║    ${DIM}export OPENAI_API_KEY=sk-...${NC}                               ${GREEN}║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Docs: https://github.com/sanix-ahmed/sanix                  ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Run onboarding wizard on first install
if [ ! -f "$HOME/.sanix/config.json" ]; then
  read -rp "Run the onboarding wizard now? [Y/n] " ONBOARD_CHOICE
  ONBOARD_CHOICE=${ONBOARD_CHOICE:-Y}
  if [[ "$ONBOARD_CHOICE" =~ ^[Yy] ]]; then
    sanix config init 2>/dev/null || true
  fi
fi

echo ""
info "If 'sanix' command is not found, restart your terminal or run: source ~/.bashrc"
echo ""
