#!/bin/sh
# Installs the figma-font-sync binary for this Mac or Linux machine from the npm registry, without Node:
#
#   curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh
#   curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh -s -- --no-setup
#
# Every step is a function and main runs on the last line, so a truncated download runs nothing.

set -eu

# pack-npm.ts writes the version this script is published with here, so a cached copy of the script never
# installs a binary from another release.
PUBLISHED_VERSION='__VERSION__'

REGISTRY='https://registry.npmjs.org'
SCOPE='@figma-font-sync'
SUPPORTED='macOS arm64, macOS x64 and Linux x64 (glibc); Windows x64 through npm'

# npm's registry signing key, from https://registry.npmjs.org/-/npm/v1/keys (expires: null in October 2026).
# The registry serves the tarball and its checksum alike, so a checksum alone says nothing about who
# published it; a signature from this pinned key does. When npm rotates the key, update both lines.
NPM_KEY_ID='SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U'
NPM_KEY='MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g=='

FROM_TARBALL=''
REQUESTED_VERSION=''
RUN_SETUP=1
OS=''
ARCH=''
VERSION=''
WORK_DIR=''
INSTALL_DIR=''
BINARY_SOURCE=''
INSTALL_TARGET=''

say() {
  for say_line in "$@"; do
    printf '%s\n' "$say_line"
  done
}

abort() {
  printf 'figma-font-sync install: %s\n' "$1" >&2
  shift
  for abort_line in "$@"; do
    printf '%s\n' "$abort_line" >&2
  done
  exit 1
}

usage() {
  say "Installs figma-font-sync from the npm registry into \${FIGMA_FONT_SYNC_INSTALL_DIR:-\$HOME/.local/bin}." \
    "" \
    "Usage: install.sh [--version <version>] [--no-setup] [--from <tarball>]" \
    "" \
    "  --version <version>  Install this version instead of the one this script was published with" \
    "  --no-setup           Do not run 'figma-font-sync setup' afterwards" \
    "  --from <tarball>     Install from a local @figma-font-sync/<os>-<arch> tarball (npm pack output)," \
    "                       skipping the registry and its signature check" \
    "  -h, --help           Show this help" \
    "" \
    "Environment:" \
    "  FIGMA_FONT_SYNC_INSTALL_DIR  Where the binary goes (default: \$HOME/.local/bin)" \
    "  FIGMA_FONT_SYNC_VERSION      Version to install when --version is not given"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --from)
        [ $# -ge 2 ] || abort "--from needs a tarball path."
        FROM_TARBALL=$2
        shift 2
        ;;
      --from=*)
        FROM_TARBALL=${1#--from=}
        shift
        ;;
      --version)
        [ $# -ge 2 ] || abort "--version needs a version."
        REQUESTED_VERSION=$2
        shift 2
        ;;
      --version=*)
        REQUESTED_VERSION=${1#--version=}
        shift
        ;;
      --no-setup)
        RUN_SETUP=0
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        abort "Unknown option $1" "" "$(usage)"
        ;;
    esac
  done
}

is_musl() {
  for musl_loader in /lib/ld-musl-*; do
    [ -e "$musl_loader" ] && return 0
  done
  ldd --version 2>&1 | grep -qi musl
}

# Sets OS and ARCH to the suffix of the platform package to install.
detect_platform() {
  platform_kernel=$(uname -s)
  platform_machine=$(uname -m)
  case "$platform_kernel" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    MINGW* | MSYS* | CYGWIN*)
      abort "This installer is for macOS and Linux. On Windows, install with npm:" "  npm i -g figma-font-sync"
      ;;
    *) abort "There is no figma-font-sync build for $platform_kernel." "Supported: $SUPPORTED." ;;
  esac
  case "$platform_machine" in
    x86_64 | amd64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) abort "There is no figma-font-sync build for $platform_kernel $platform_machine." "Supported: $SUPPORTED." ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon; the native build is the one to install.
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi
  if [ "$OS" = linux ]; then
    [ "$ARCH" = x64 ] || abort "There is no figma-font-sync build for Linux arm64." "Supported: $SUPPORTED."
    if is_musl; then
      abort "This Linux uses musl libc (Alpine and similar); figma-font-sync is built for glibc only." \
        "Supported: $SUPPORTED."
    fi
  fi
}

# Only characters semver allows, so the version is safe in a URL and in messages.
is_version() {
  case "$1" in
    '' | *[!0-9A-Za-z.+-]*) return 1 ;;
    [0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Sets VERSION from --version, then FIGMA_FONT_SYNC_VERSION, then the version this script was published with.
resolve_version() {
  VERSION=${REQUESTED_VERSION:-${FIGMA_FONT_SYNC_VERSION:-$PUBLISHED_VERSION}}
  VERSION=${VERSION#v}
  is_version "$VERSION" && return 0
  if [ "$VERSION" = "$PUBLISHED_VERSION" ]; then
    abort "This copy of install.sh was not published with a version." \
      "Pass --version <version> or set FIGMA_FONT_SYNC_VERSION."
  fi
  abort "\"$VERSION\" is not a version."
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || abort "$1 is required but was not found. $2"
}

# Prints the body of an https URL, or writes it to a file when one is given.
download() {
  if command -v curl >/dev/null 2>&1; then
    if [ $# -ge 2 ]; then
      curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
    else
      curl -fsSL --proto '=https' --tlsv1.2 "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ $# -ge 2 ]; then
      wget -q -O "$2" "$1"
    else
      wget -q -O - "$1"
    fi
  else
    return 127
  fi
}

# The last "<key>":"<string>" in a JSON document. The keys read here (tarball, integrity, name) occur once in
# a registry version document, and their values never hold spaces or escaped quotes.
json_string() {
  printf '%s' "$1" | tr -d ' \t\r\n' | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

# Every dist.signatures[].sig made with the pinned key, one per line. Packages can carry several.
npm_signatures() {
  printf '%s' "$1" | tr -d ' \t\r\n' |
    sed -n 's/.*"signatures":\[\([^]]*\)\].*/\1/p' |
    tr '}' '\n' |
    grep -F "\"keyid\":\"$NPM_KEY_ID\"" |
    sed -n 's/.*"sig":"\([^"]*\)".*/\1/p'
}

# Verifies an npm registry ECDSA P-256 signature (base64 DER) over $1 with the pinned key, using files in $3.
verify_signature() {
  {
    printf '%s\n' '-----BEGIN PUBLIC KEY-----'
    printf '%s\n' "$NPM_KEY" | fold -w 64
    printf '%s\n' '-----END PUBLIC KEY-----'
  } >"$3/npm-key.pem" &&
    printf '%s' "$2" | openssl base64 -d -A >"$3/npm-signature.der" 2>/dev/null &&
    printf '%s' "$1" >"$3/npm-message" &&
    openssl dgst -sha256 -verify "$3/npm-key.pem" -signature "$3/npm-signature.der" "$3/npm-message" >/dev/null 2>&1
}

# Checks a file against a "sha512-<base64>" integrity string.
verify_integrity() {
  case "$2" in
    sha512-?*) ;;
    *) return 1 ;;
  esac
  integrity_actual=$(openssl dgst -sha512 -binary "$1" | openssl base64 -A) || return 1
  [ "$integrity_actual" = "${2#sha512-}" ]
}

# Downloads <name>@<version> into $3/package.tgz after checking npm's signature over its integrity, then the
# tarball against that integrity.
fetch_package() {
  fetch_name=$1
  fetch_version=$2
  fetch_dir=$3
  fetch_url="$REGISTRY/$(printf '%s' "$fetch_name" | sed 's|/|%2F|')/$fetch_version"
  fetch_meta=$(download "$fetch_url") ||
    abort "Could not read $fetch_name@$fetch_version from the npm registry ($fetch_url)." \
      "Check the version and your connection."

  fetch_tarball=$(json_string "$fetch_meta" tarball)
  fetch_integrity=$(json_string "$fetch_meta" integrity)
  fetch_signatures=$(npm_signatures "$fetch_meta")
  case "$fetch_tarball" in
    https://?*) ;;
    *) abort "The npm registry listed no https tarball for $fetch_name@$fetch_version." ;;
  esac
  case "$fetch_integrity" in
    sha512-?*) ;;
    *) abort "The npm registry listed no sha512 integrity for $fetch_name@$fetch_version." ;;
  esac
  [ -n "$fetch_signatures" ] ||
    abort "$fetch_name@$fetch_version has no npm registry signature made with key $NPM_KEY_ID." \
      "If npm has rotated its signing key, this installer needs an update. Until then: npm i -g figma-font-sync"

  # The message names the package and version asked for, so a signature for another package cannot pass.
  fetch_verified=0
  while IFS= read -r fetch_signature; do
    if verify_signature "$fetch_name@$fetch_version:$fetch_integrity" "$fetch_signature" "$fetch_dir"; then
      fetch_verified=1
      break
    fi
  done <<EOF
$fetch_signatures
EOF
  [ "$fetch_verified" = 1 ] ||
    abort "The npm registry signature for $fetch_name@$fetch_version does not verify. Refusing to install."

  download "$fetch_tarball" "$fetch_dir/package.tgz" || abort "Could not download $fetch_tarball."
  verify_integrity "$fetch_dir/package.tgz" "$fetch_integrity" ||
    abort "$fetch_tarball does not match the checksum npm signed. Refusing to install."
}

# Extracts the whole tarball (member selection and --strip-components differ between GNU, BSD and busybox
# tar) and sets BINARY_SOURCE.
extract_package() {
  mkdir "$WORK_DIR/extract" || abort "Could not create $WORK_DIR/extract."
  tar -xzf "$1" -C "$WORK_DIR/extract" || abort "Could not extract $1."
  BINARY_SOURCE="$WORK_DIR/extract/package/bin/figma-font-sync"
  [ -f "$BINARY_SOURCE" ] || abort "$1 has no package/bin/figma-font-sync."
}

# A --from tarball skips the signature check, so at least make sure it is the build for this machine.
check_local_package() {
  local_manifest=$(cat "$WORK_DIR/extract/package/package.json") || abort "$FROM_TARBALL has no package/package.json."
  local_name=$(json_string "$local_manifest" name)
  [ "$local_name" = "$SCOPE/$OS-$ARCH" ] ||
    abort "$FROM_TARBALL holds ${local_name:-an unnamed package}, but this machine needs $SCOPE/$OS-$ARCH."
  VERSION=$(json_string "$local_manifest" version)
}

install_binary() {
  mkdir -p "$INSTALL_DIR" || abort "Could not create $INSTALL_DIR."
  INSTALL_TARGET="$INSTALL_DIR/figma-font-sync"
  install_temp="$INSTALL_DIR/.figma-font-sync.$$"
  # Renamed over the old file rather than written into it: Linux refuses to write a running binary (ETXTBSY),
  # and macOS kills a signed binary whose pages change under it.
  if ! { cp "$BINARY_SOURCE" "$install_temp" && chmod 755 "$install_temp" &&
    mv -f "$install_temp" "$INSTALL_TARGET"; }; then
    rm -f "$install_temp"
    abort "Could not write $INSTALL_TARGET."
  fi
  # curl and tar never set it, but a tarball a browser downloaded passes it on, and Gatekeeper then blocks the binary.
  if [ "$OS" = darwin ] && command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$INSTALL_TARGET" 2>/dev/null || true
  fi
}

on_path() {
  case ":${PATH:-}:" in
    *":$INSTALL_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

path_hint() {
  on_path && return 0
  hint_home=${HOME:-~}
  case "$INSTALL_DIR" in
    "$hint_home"/*) hint_dir="\$HOME/${INSTALL_DIR#"$hint_home"/}" ;;
    *) hint_dir=$INSTALL_DIR ;;
  esac
  hint_line="export PATH=\"$hint_dir:\$PATH\""
  case "$(basename "${SHELL:-sh}")" in
    zsh) hint_file="$hint_home/.zshrc" ;;
    bash)
      if [ "$OS" = darwin ]; then hint_file="$hint_home/.bash_profile"; else hint_file="$hint_home/.bashrc"; fi
      ;;
    fish)
      hint_file="$hint_home/.config/fish/config.fish"
      hint_line="fish_add_path \"$hint_dir\""
      ;;
    *) hint_file="$hint_home/.profile" ;;
  esac
  say "" "$INSTALL_DIR is not on your PATH. Add this line to $hint_file and open a new terminal:" "" "  $hint_line" ""
}

run_setup() {
  if on_path; then setup_command='figma-font-sync setup'; else setup_command="$INSTALL_TARGET setup"; fi
  if [ "$RUN_SETUP" = 0 ]; then
    say "Next: $setup_command"
    return 0
  fi
  # Piped into sh, stdin is this script; setup asks questions, so it reads the terminal instead.
  if ! (: </dev/tty) 2>/dev/null; then
    say "No terminal to run setup in. Next: $setup_command"
    return 0
  fi
  say "Running $setup_command"
  "$INSTALL_TARGET" setup </dev/tty || abort "setup did not finish. Run it again: $setup_command"
}

cleanup() {
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}

main() {
  parse_args "$@"
  detect_platform

  INSTALL_DIR=${FIGMA_FONT_SYNC_INSTALL_DIR:-}
  if [ -z "$INSTALL_DIR" ]; then
    [ -n "${HOME:-}" ] || abort "HOME is not set. Set FIGMA_FONT_SYNC_INSTALL_DIR to choose where the binary goes."
    INSTALL_DIR="$HOME/.local/bin"
  fi

  need_cmd tar ""
  need_cmd mktemp ""
  WORK_DIR=$(mktemp -d 2>/dev/null || mktemp -d "${TMPDIR:-/tmp}/figma-font-sync.XXXXXX") ||
    abort "Could not create a temporary directory."
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -n "$FROM_TARBALL" ]; then
    [ -f "$FROM_TARBALL" ] || abort "$FROM_TARBALL does not exist."
    extract_package "$FROM_TARBALL"
    check_local_package
  else
    resolve_version
    need_cmd openssl "It checks npm's signature on the download."
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || abort "curl or wget is required."
    say "Downloading $SCOPE/$OS-$ARCH@$VERSION from the npm registry"
    fetch_package "$SCOPE/$OS-$ARCH" "$VERSION" "$WORK_DIR"
    extract_package "$WORK_DIR/package.tgz"
  fi

  install_binary
  say "Installed figma-font-sync $VERSION to $INSTALL_TARGET"
  path_hint
  run_setup
}

# Tests source this file with FIGMA_FONT_SYNC_INSTALL_SH_TEST=1 to call the functions one at a time.
[ "${FIGMA_FONT_SYNC_INSTALL_SH_TEST:-}" = 1 ] || main "$@"
