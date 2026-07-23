#!/bin/sh
# Glass installer - detects OS/arch, downloads the matching glass binary from
# the latest release on github.com/majorbeard/glass-engine, and installs it.
#
#   curl -fsSL https://raw.githubusercontent.com/majorbeard/glass-engine/main/install.sh | sh
#
# Piped into `sh` (not bash) by that one-liner, so this is written as real
# POSIX sh - no [[ ]], no arrays, no `set -o pipefail` (bashisms would
# silently misbehave or error under dash, which is /bin/sh on many Linux
# distros). Developed/tested in the private glass-runtime repo; copied into
# the public glass-engine repo as a static file (see docs/RELEASING.md) -
# it changes rarely, so this is simpler and lower-risk than having CI push it
# on every release.
set -eu

REPO="majorbeard/glass-engine"

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *)
      echo "glass: unsupported OS '$(uname -s)' - see https://github.com/${REPO}/releases for manual downloads" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *)
      echo "glass: unsupported architecture '$(uname -m)' - see https://github.com/${REPO}/releases for manual downloads" >&2
      exit 1
      ;;
  esac
}

# ensure_ffmpeg is a best-effort convenience, not a hard requirement of this
# script: it only ever prints a "Note:" and returns 0 on any failure,
# because `glass doctor` (run at the end of this script) already gives
# clear, actionable guidance if ffmpeg ends up missing - one of them failing
# should never fail the other. Skippable entirely via
# GLASS_SKIP_FFMPEG_INSTALL=1 for anyone who wants to manage ffmpeg
# themselves. See README.md's "FFmpeg and licensing" section for why Glass
# doesn't just bundle this.
ensure_ffmpeg() {
  if [ "${GLASS_SKIP_FFMPEG_INSTALL:-}" = "1" ]; then
    echo "GLASS_SKIP_FFMPEG_INSTALL=1 set - skipping ffmpeg check."
    return 0
  fi

  if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264; then
    echo "ffmpeg (with libx264) already installed."
    return 0
  fi

  echo "ffmpeg (with libx264) not found - attempting to install it..."

  if [ "$OS" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      echo "Installing ffmpeg via Homebrew..."
      brew install ffmpeg || echo "Note: 'brew install ffmpeg' failed - install it yourself."
    else
      echo "Note: Homebrew not found - install ffmpeg yourself, e.g. via https://brew.sh then 'brew install ffmpeg'."
    fi
    return 0
  fi

  # Linux: fetch John Van Sickle's static build for this architecture
  # (https://johnvansickle.com/ffmpeg/) and verify it against the published
  # md5 before using it - the same source `glass doctor`'s own
  # GLASS_AUTO_FETCH_FFMPEG path uses (see backend/internal/browser/ffmpeg_fetch.go).
  FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz"
  FF_TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$FF_TMP_DIR"' EXIT

  if ! curl -fsSL "$FF_URL" -o "$FF_TMP_DIR/ffmpeg.tar.xz"; then
    echo "Note: could not download $FF_URL - install ffmpeg yourself."
    return 0
  fi
  if ! curl -fsSL "${FF_URL}.md5" -o "$FF_TMP_DIR/ffmpeg.tar.xz.md5"; then
    echo "Note: could not download ffmpeg checksum - refusing to use an unverified download. Install ffmpeg yourself."
    return 0
  fi

  EXPECTED_MD5="$(awk '{print $1}' "$FF_TMP_DIR/ffmpeg.tar.xz.md5")"
  ACTUAL_MD5="$(md5sum "$FF_TMP_DIR/ffmpeg.tar.xz" | awk '{print $1}')"
  if [ -z "$EXPECTED_MD5" ] || [ "$EXPECTED_MD5" != "$ACTUAL_MD5" ]; then
    echo "Note: ffmpeg download checksum mismatch (expected '$EXPECTED_MD5', got '$ACTUAL_MD5') - refusing to use it. Install ffmpeg yourself."
    return 0
  fi

  if ! tar -xf "$FF_TMP_DIR/ffmpeg.tar.xz" -C "$FF_TMP_DIR"; then
    echo "Note: could not extract ffmpeg build - install ffmpeg yourself."
    return 0
  fi

  FF_BIN="$(ls "$FF_TMP_DIR"/ffmpeg-*-static/ffmpeg 2>/dev/null | head -1)"
  if [ -z "$FF_BIN" ] || [ ! -f "$FF_BIN" ]; then
    echo "Note: could not locate ffmpeg binary in downloaded archive - install ffmpeg yourself."
    return 0
  fi

  cp "$FF_BIN" "${INSTALL_DIR}/ffmpeg"
  chmod +x "${INSTALL_DIR}/ffmpeg"
  echo "Installed ffmpeg (checksum-verified) to ${INSTALL_DIR}/ffmpeg"
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET="glass-${OS}-${ARCH}"
# GitHub's "latest/download" convenience URL redirects straight to the
# newest release's matching asset - no GitHub API call or JSON parsing
# needed, and no auth required for a public repo.
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

INSTALL_DIR="/usr/local/bin"
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

echo "Installing glass (${OS}/${ARCH}) to ${INSTALL_DIR}..."

TMP="$(mktemp)"
if ! curl -fsSL "$URL" -o "$TMP"; then
  echo "glass: failed to download ${URL}" >&2
  echo "Check https://github.com/${REPO}/releases for available builds." >&2
  rm -f "$TMP"
  exit 1
fi

chmod +x "$TMP"
mv "$TMP" "${INSTALL_DIR}/glass"

echo "Installed glass to ${INSTALL_DIR}/glass"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Note: ${INSTALL_DIR} is not on your PATH. Add it, e.g.:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo
ensure_ffmpeg

echo
# Runs on a best-effort basis - a fresh install's very first output is
# whether it'll actually work (ffmpeg/Chrome present), not a silent "done."
"${INSTALL_DIR}/glass" doctor || true
