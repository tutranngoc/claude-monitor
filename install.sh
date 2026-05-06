#!/bin/sh
#
# claude-monitor installer
# ------------------------
#   curl -fsSL https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.sh | sh
#
# Downloads the latest pre-built binary for your arch, drops it into
# $INSTALL_DIR (default ~/.local/bin), ad-hoc codesigns it, and ensures
# the dir is on PATH via $SHELL_RC (default ~/.zshrc).
#
# Override with env vars:
#   INSTALL_DIR=/usr/local/bin   SHELL_RC=~/.bashrc   sh install.sh
#
set -eu

REPO="Tungify/claude-monitor"
BINARY="claude-monitor"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
SHELL_RC="${SHELL_RC:-$HOME/.zshrc}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
die()   { red "✗ $*" >&2; exit 1; }

# ---------- platform check ----------
[ "$(uname -s)" = "Darwin" ] || die "macOS only — depends on the 'security' Keychain CLI."

case "$(uname -m)" in
    arm64|aarch64)  target="darwin-arm64" ;;
    x86_64)         target="darwin-amd64" ;;
    *)              die "unsupported architecture: $(uname -m)" ;;
esac

# ---------- download ----------
url="https://github.com/$REPO/releases/latest/download/$BINARY-$target"
dest="$INSTALL_DIR/$BINARY"

blue "→ downloading $target binary"
mkdir -p "$INSTALL_DIR"
if ! curl -fL --progress-bar -o "$dest" "$url"; then
    die "download failed — confirm a release exists at https://github.com/$REPO/releases/latest"
fi

chmod +x "$dest"
xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
codesign -f -s - "$dest" >/dev/null 2>&1 || true
green "✓ installed $dest"

# ---------- PATH wiring ----------
case ":$PATH:" in
    *:"$INSTALL_DIR":*)
        blue "→ $INSTALL_DIR already on PATH"
        ;;
    *)
        if [ -f "$SHELL_RC" ] && grep -qF "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
            blue "→ $SHELL_RC already references $INSTALL_DIR — open a new shell"
        else
            printf '\n# claude-monitor\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$SHELL_RC"
            green "✓ added $INSTALL_DIR to PATH in $SHELL_RC"
            blue "→ run: exec \$SHELL -l    (or open a new terminal)"
        fi
        ;;
esac

# ---------- verify ----------
echo
blue "→ verify:"
"$dest" --version
echo
green "✓ done. Run: $BINARY"
