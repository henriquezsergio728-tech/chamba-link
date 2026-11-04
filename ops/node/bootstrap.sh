#!/usr/bin/env bash
# Provisions an application node on a fresh Ubuntu 24.04 VM: firewall, Docker, nginx, TLS files and the api container.
# Runs as root. Every step compares before it writes, so a second run changes nothing. See docs/deployment.md.
set -euo pipefail
set -E
umask 022

API_TAG="${API_TAG:-}"
REPO_REF="${REPO_REF:-main}"
REPO_URL="${REPO_URL:-https://github.com/henriquezsergio728-tech/chamba-link.git}"
APP_USER="${APP_USER:-ubuntu}"

APP_DIR=/opt/chambalink
SECRETS_DIR=/etc/chambalink/secrets
EXTRA_443_SOURCES=/etc/chambalink/extra_443_sources
TLS_DIR=/etc/ssl/chambalink
NGINX_MAIN_CONFIG=/etc/nginx/nginx.conf
NGINX_SITE_LINK=/etc/nginx/sites-enabled/chambalink.conf
NGINX_DEFAULT_SITE=/etc/nginx/sites-enabled/default
DOCKER_DAEMON_CONFIG=/etc/docker/daemon.json
DOCKER_KEY=/etc/apt/keyrings/docker.asc
DOCKER_SOURCES=/etc/apt/sources.list.d/docker.sources

COMPOSE_FILE_LIST=compose.prod.yaml:deploy/app/compose.yaml
NGINX_RLIMIT_NOFILE=8192
NGINX_WORKER_CONNECTIONS=4096
MIN_CLOUDFLARE_RANGES=10
HEALTH_ATTEMPTS=30

WORK_DIR=""
NGINX_CHANGED=0

log() {
  echo "bootstrap: $*"
}

warn() {
  echo "bootstrap: warning: $*" >&2
}

fail() {
  echo "bootstrap: $*" >&2
  exit 1
}

# Pure functions, also exercised on their own by sourcing this file.

valid_api_tag() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

# One line with a postgres scheme and none of the characters that .env treats specially, because .env holds it unquoted.
valid_database_url() {
  local pattern="^postgres(ql)?://[^[:space:]'\"\$#\\\\]+$"
  [[ "$1" =~ $pattern ]]
}

# 0600 or stricter: no bit for group or others.
mode_is_private() {
  local mode="$1"
  (((8#$mode & 8#077) == 0))
}

# A dotted-quad CIDR with a prefix of 0 to 32. Leading zeros are refused, because iptables prints the address without them.
valid_ipv4_cidr() {
  local octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  local pattern="^$octet\\.$octet\\.$octet\\.$octet/(3[0-2]|[12]?[0-9])$"
  [[ "$1" =~ $pattern ]]
}

# No address bit past the prefix. iptables -S prints the masked network, so any other form never equals the rule list.
cidr_is_network() {
  local prefix="${1#*/}" a b c d
  IFS=. read -r a b c d <<<"${1%/*}"
  ((((a << 24 | b << 16 | c << 8 | d) & ((1 << (32 - prefix)) - 1)) == 0))
}

# The IPv4 ranges of the set_real_ip_from lines, in file order.
parse_cloudflare_ranges() {
  awk '
    $1 == "set_real_ip_from" {
      value = $2
      sub(/;$/, "", value)
      if (value ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/) print value
    }
  ' "$1"
}

# The lines of the extra sources file that are neither blank nor comments, each after its line number. No file, no lines.
extra_443_source_lines() {
  [[ -f "$1" ]] || return 0
  awk '!/^[ \t\r]*$/ && !/^#/ { print FNR, $0 }' "$1"
}

# The extra sources, in file order.
parse_extra_443_sources() {
  extra_443_source_lines "$1" | cut -d ' ' -f 2-
}

# The first name of the server_name line of the site config.
parse_server_name() {
  awk '
    $1 == "server_name" {
      value = $2
      sub(/;$/, "", value)
      print value
      exit
    }
  ' "$1"
}

# The INPUT rules as iptables -S prints them, for the sources given as arguments: the extra ones, then Cloudflare's.
expected_input_rules() {
  local range
  echo "-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT"
  echo "-A INPUT -p icmp -j ACCEPT"
  echo "-A INPUT -i lo -j ACCEPT"
  echo "-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT"
  for range in "$@"; do
    echo "-A INPUT -s $range -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT"
  done
  echo "-A INPUT -j REJECT --reject-with icmp-host-prohibited"
}

# Reads nginx.conf on stdin and writes it with the two limits set. The result does not depend on earlier runs.
nginx_config_with_limits() {
  sed -E \
    -e '/^[[:space:]]*worker_rlimit_nofile[[:space:]]/d' \
    -e "s/^([[:space:]]*worker_connections)[[:space:]]+[0-9]+;/\1 ${NGINX_WORKER_CONNECTIONS};/" \
    -e "/^worker_processes[[:space:]]/a worker_rlimit_nofile ${NGINX_RLIMIT_NOFILE};"
}

# Helpers that change the system.

# Copies $1 to $2 with the owner and mode given, through a temporary file in the target directory, unless $2 already
# matches. Returns 0 when it wrote and 1 when nothing changed. Callers test the result, which turns off set -e in here,
# so a failed write exits explicitly.
install_if_changed() {
  local source="$1" target="$2" owner="$3" group="$4" mode="$5"
  local temporary="${target}.tmp.$$"
  if [[ -f "$target" ]] && cmp -s "$source" "$target"; then
    if [[ "$(stat -c '%U:%G %a' "$target")" == "$owner:$group $mode" ]]; then
      return 1
    fi
  fi
  install -o "$owner" -g "$group" -m "$mode" "$source" "$temporary" || fail "cannot write $target"
  mv -f "$temporary" "$target" || fail "cannot write $target"
  return 0
}

apt_get() {
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -y -q -o DPkg::Lock::Timeout=300 "$@"
}

package_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"
}

# Installs the packages that are missing. Returns without touching apt when none is.
install_packages() {
  local package
  local missing=()
  for package in "$@"; do
    if ! package_installed "$package"; then
      missing+=("$package")
    fi
  done
  if ((${#missing[@]} == 0)); then
    return 0
  fi
  apt_get update
  apt_get install "${missing[@]}"
}

as_app_user() {
  sudo -H -u "$APP_USER" "$@"
}

git_in_clone() {
  as_app_user git -C "$APP_DIR" "$@"
}

# The clone's .env decides these; the same names in this process's environment would take precedence over it.
compose() {
  (
    cd "$APP_DIR"
    env -u COMPOSE_FILE -u API_TAG -u DATABASE_URL docker compose "$@"
  )
}

# Steps.

check_secret_file() {
  local name="$1" path="$SECRETS_DIR/$1"
  if [[ ! -s "$path" ]]; then
    PROBLEMS+=("$path is missing or empty")
    return 0
  fi
  if [[ "$(stat -c '%U' "$path")" != "root" ]]; then
    PROBLEMS+=("$path is not owned by root")
  fi
  if [[ "$name" != "origin.pem" ]] && ! mode_is_private "$(stat -c '%a' "$path")"; then
    PROBLEMS+=("$path must have mode 0600 or stricter")
  fi
}

# The file is optional. Problems name line numbers, so that its contents are not printed.
check_extra_443_sources() {
  local path="$EXTRA_443_SOURCES"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ -L "$path" || ! -f "$path" ]]; then
    PROBLEMS+=("$path must be a regular file")
    return 0
  fi
  if [[ "$(stat -c '%U' "$path")" != "root" ]]; then
    PROBLEMS+=("$path is not owned by root")
  fi
  if ! mode_is_private "$(stat -c '%a' "$path")"; then
    PROBLEMS+=("$path must have mode 0600 or stricter")
  fi

  local entry number source
  local -A seen=()
  while IFS= read -r entry; do
    number="${entry%% *}"
    source="${entry#* }"
    if ! valid_ipv4_cidr "$source"; then
      PROBLEMS+=("$path line $number is not an IPv4 CIDR")
    elif [[ "${source#*/}" == "0" ]]; then
      PROBLEMS+=("$path line $number has a /0 prefix")
    elif ! cidr_is_network "$source"; then
      PROBLEMS+=("$path line $number has address bits past its prefix")
    elif [[ -n "${seen[$source]:-}" ]]; then
      PROBLEMS+=("$path line $number repeats line ${seen[$source]}")
    else
      seen[$source]="$number"
    fi
  done < <(extra_443_source_lines "$path")
}

# Reads and changes nothing but its own variables, and reports every problem before exiting.
preflight() {
  PROBLEMS=()
  if ((EUID != 0)); then
    fail "must run as root"
  fi

  local os_id os_version
  os_id="$(. /etc/os-release && echo "$ID")"
  os_version="$(. /etc/os-release && echo "$VERSION_ID")"
  if [[ "$os_id" != "ubuntu" || "$os_version" != "24.04" ]]; then
    PROBLEMS+=("Ubuntu 24.04 is required, found $os_id $os_version")
  fi
  if [[ "$(uname -m)" != "aarch64" ]]; then
    warn "this machine is $(uname -m), not aarch64"
  fi

  if ! valid_api_tag "$API_TAG"; then
    PROBLEMS+=("API_TAG must be 40 lowercase hexadecimal characters")
  fi
  if ! id "$APP_USER" >/dev/null 2>&1; then
    PROBLEMS+=("user $APP_USER does not exist")
  fi

  check_secret_file origin.pem
  check_secret_file origin.key
  check_secret_file database_url
  if [[ -s "$SECRETS_DIR/database_url" ]] && ! valid_database_url "$(<"$SECRETS_DIR/database_url")"; then
    PROBLEMS+=("$SECRETS_DIR/database_url must be one postgres:// URL with only URL-safe characters")
  fi
  check_extra_443_sources

  # This script writes .env without the owner URL, so running it on the host that runs migrations would lose it.
  if [[ -f "$APP_DIR/.env" ]] && grep -q '^MIGRATE_DATABASE_URL=' "$APP_DIR/.env"; then
    PROBLEMS+=("$APP_DIR/.env defines MIGRATE_DATABASE_URL; this script does not manage the host that runs migrations")
  fi

  if ((${#PROBLEMS[@]} > 0)); then
    local problem
    for problem in "${PROBLEMS[@]}"; do
      echo "bootstrap: preflight: $problem" >&2
    done
    exit 1
  fi
  log "preflight passed"
}

wait_for_cloud_init() {
  if command -v cloud-init >/dev/null; then
    # Exit code 2 means finished with recoverable errors, which does not stop this script.
    cloud-init status --wait >/dev/null || true
  fi
  log "cloud-init finished"
}

install_base_packages() {
  install_packages ca-certificates curl git iptables-persistent nginx
  log "base packages installed"
}

clone_repository() {
  if [[ ! -d "$APP_DIR/.git" ]]; then
    if [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR")" ]]; then
      fail "$APP_DIR exists, is not empty and is not a clone"
    fi
    install -d -o "$APP_USER" -g "$(id -gn "$APP_USER")" -m 0755 "$APP_DIR"
    as_app_user git clone --quiet "$REPO_URL" "$APP_DIR"
  fi

  if [[ "$(git_in_clone remote get-url origin)" != "$REPO_URL" ]]; then
    fail "the origin of $APP_DIR is not $REPO_URL"
  fi
  git_in_clone fetch --quiet --tags origin

  local head target
  head="$(git_in_clone rev-parse HEAD)"
  if git_in_clone rev-parse --verify --quiet "refs/remotes/origin/$REPO_REF" >/dev/null; then
    target="$(git_in_clone rev-parse "refs/remotes/origin/$REPO_REF")"
    if [[ "$head" != "$target" || "$(git_in_clone branch --show-current)" != "$REPO_REF" ]]; then
      git_in_clone checkout --quiet "$REPO_REF"
      git_in_clone merge --quiet --ff-only "origin/$REPO_REF"
    fi
  else
    target="$(git_in_clone rev-parse --verify --quiet "$REPO_REF^{commit}")" || fail "$REPO_REF is not a branch, tag or commit"
    if [[ "$head" != "$target" ]]; then
      git_in_clone checkout --quiet --detach "$target"
    fi
  fi
  log "clone at $target"
}

# Runs before Docker is installed, so that the first save holds no Docker chains. Only INPUT is rebuilt, in one
# iptables-restore transaction, so no established session or ssh connection meets a partly built chain.
configure_firewall() {
  local ranges=() sources=()
  mapfile -t ranges < <(parse_cloudflare_ranges "$APP_DIR/deploy/nginx/cloudflare-real-ip.conf")
  if ((${#ranges[@]} < MIN_CLOUDFLARE_RANGES)); then
    fail "found ${#ranges[@]} Cloudflare IPv4 ranges, expected at least $MIN_CLOUDFLARE_RANGES"
  fi
  mapfile -t sources < <(parse_extra_443_sources "$EXTRA_443_SOURCES")

  expected_input_rules "${sources[@]}" "${ranges[@]}" >"$WORK_DIR/input.expected"
  iptables -S INPUT >"$WORK_DIR/input.all"
  grep '^-A INPUT ' "$WORK_DIR/input.all" >"$WORK_DIR/input.current" || true
  if cmp -s "$WORK_DIR/input.expected" "$WORK_DIR/input.current"; then
    log "firewall unchanged, ${#ranges[@]} Cloudflare ranges, ${#sources[@]} extra sources"
    return 0
  fi

  local policy
  policy="$(awk '$1 == "-P" { print $3 }' "$WORK_DIR/input.all")"
  {
    echo "*filter"
    echo ":INPUT $policy [0:0]"
    echo "-F INPUT"
    cat "$WORK_DIR/input.expected"
    echo "COMMIT"
  } >"$WORK_DIR/input.restore"
  iptables-restore --noflush --test <"$WORK_DIR/input.restore"
  iptables-restore --noflush <"$WORK_DIR/input.restore"

  if iptables -S | grep -q '^-N DOCKER'; then
    warn "Docker is running, so this save also persists its chains"
  fi
  netfilter-persistent save >/dev/null
  log "firewall rebuilt and saved, ${#ranges[@]} Cloudflare ranges, ${#sources[@]} extra sources"
}

install_docker() {
  local architecture codename
  architecture="$(dpkg --print-architecture)"
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"

  install -d -m 0755 "$(dirname "$DOCKER_KEY")"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$WORK_DIR/docker.asc"
  install_if_changed "$WORK_DIR/docker.asc" "$DOCKER_KEY" root root 644 || true

  cat >"$WORK_DIR/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $architecture
Signed-By: $DOCKER_KEY
EOF
  install_if_changed "$WORK_DIR/docker.sources" "$DOCKER_SOURCES" root root 644 || true

  install_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  log "docker installed"
}

configure_docker_daemon() {
  install -d -m 0755 "$(dirname "$DOCKER_DAEMON_CONFIG")"
  echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' >"$WORK_DIR/daemon.json"
  if install_if_changed "$WORK_DIR/daemon.json" "$DOCKER_DAEMON_CONFIG" root root 644; then
    systemctl restart docker
    log "docker daemon config written, docker restarted"
  else
    log "docker daemon config unchanged"
  fi
}

add_app_user_to_docker_group() {
  if id -nG "$APP_USER" | tr ' ' '\n' | grep -qx docker; then
    log "$APP_USER already in the docker group"
    return 0
  fi
  usermod -aG docker "$APP_USER"
  log "$APP_USER added to the docker group"
}

install_tls_files() {
  install -d -m 0755 "$TLS_DIR"
  if install_if_changed "$SECRETS_DIR/origin.pem" "$TLS_DIR/origin.pem" root root 644; then
    NGINX_CHANGED=1
  fi
  if install_if_changed "$SECRETS_DIR/origin.key" "$TLS_DIR/origin.key" root root 600; then
    NGINX_CHANGED=1
  fi
  log "TLS files in place"
}

configure_nginx_limits() {
  nginx_config_with_limits <"$NGINX_MAIN_CONFIG" >"$WORK_DIR/nginx.conf"
  if [[ "$(grep -c "^worker_rlimit_nofile ${NGINX_RLIMIT_NOFILE};$" "$WORK_DIR/nginx.conf")" != "1" ]]; then
    fail "$NGINX_MAIN_CONFIG has no single worker_processes line to follow"
  fi
  if [[ "$(grep -Ec "^[[:space:]]*worker_connections ${NGINX_WORKER_CONNECTIONS};$" "$WORK_DIR/nginx.conf")" != "1" ]]; then
    fail "$NGINX_MAIN_CONFIG has no single worker_connections line"
  fi
  if install_if_changed "$WORK_DIR/nginx.conf" "$NGINX_MAIN_CONFIG" root root 644; then
    NGINX_CHANGED=1
  fi
  log "nginx limits set"
}

enable_nginx_site() {
  local site="$APP_DIR/deploy/nginx/chambalink.conf"
  if [[ -e "$NGINX_DEFAULT_SITE" || -L "$NGINX_DEFAULT_SITE" ]]; then
    rm -f "$NGINX_DEFAULT_SITE"
    NGINX_CHANGED=1
  fi
  if [[ "$(readlink "$NGINX_SITE_LINK" || true)" != "$site" ]]; then
    ln -s "$site" "${NGINX_SITE_LINK}.tmp.$$"
    mv -fT "${NGINX_SITE_LINK}.tmp.$$" "$NGINX_SITE_LINK"
    NGINX_CHANGED=1
  fi
  log "nginx site enabled"
}

reload_nginx() {
  if ((NGINX_CHANGED == 0)) && systemctl is-active --quiet nginx; then
    log "nginx unchanged"
    return 0
  fi
  nginx -t -q
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
    log "nginx reloaded"
  else
    systemctl enable --now nginx
    log "nginx started"
  fi
}

write_env_file() {
  local database_url
  database_url="$(<"$SECRETS_DIR/database_url")"
  {
    printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILE_LIST"
    printf 'API_TAG=%s\n' "$API_TAG"
    printf 'DATABASE_URL=%s\n' "$database_url"
  } >"$WORK_DIR/env"
  if install_if_changed "$WORK_DIR/env" "$APP_DIR/.env" "$APP_USER" "$(id -gn "$APP_USER")" 600; then
    log ".env written"
  else
    log ".env unchanged"
  fi
}

start_api() {
  compose pull --quiet
  compose up -d --wait --wait-timeout 120
  log "api started with tag $API_TAG"
}

wait_for_http() {
  local label="$1"
  shift
  local attempt code
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$@" || true)"
    if [[ "$code" == "200" ]]; then
      log "$label: 200"
      return 0
    fi
    sleep 2
  done
  fail "$label: last status $code after $HEALTH_ATTEMPTS attempts"
}

wait_for_health() {
  local hostname
  hostname="$(parse_server_name "$APP_DIR/deploy/nginx/chambalink.conf")"
  wait_for_http "api on loopback" http://127.0.0.1:3000/healthz
  wait_for_http "nginx on loopback" -k --resolve "$hostname:443:127.0.0.1" "https://$hostname/healthz"
}

main() {
  trap 'echo "bootstrap: failed at line $LINENO" >&2' ERR
  cd /

  preflight

  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT

  wait_for_cloud_init
  install_base_packages
  clone_repository
  configure_firewall
  install_docker
  configure_docker_daemon
  add_app_user_to_docker_group
  install_tls_files
  configure_nginx_limits
  enable_nginx_site
  reload_nginx
  write_env_file
  start_api
  wait_for_health
  log "done"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
