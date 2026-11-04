#!/usr/bin/env bash
# Checks an application node against what ops/node/bootstrap.sh builds. Read-only: it changes nothing, prints one PASS or
# FAIL line per check, shows key names and file modes but no secret value, and exits non-zero if any check fails.
# Runs as root, because nginx -t reads the TLS key and iptables needs it. See docs/deployment.md.
set -uo pipefail

APP_USER="${APP_USER:-ubuntu}"

APP_DIR=/opt/chambalink
EXTRA_443_SOURCES=/etc/chambalink/extra_443_sources
PERSISTED_RULES=/etc/iptables/rules.v4
TLS_DIR=/etc/ssl/chambalink
NGINX_MAIN_CONFIG=/etc/nginx/nginx.conf
NGINX_SITE_LINK=/etc/nginx/sites-enabled/chambalink.conf
NGINX_SITE="$APP_DIR/deploy/nginx/chambalink.conf"
CLOUDFLARE_CONFIG="$APP_DIR/deploy/nginx/cloudflare-real-ip.conf"
DOCKER_DAEMON_CONFIG=/etc/docker/daemon.json

COMPOSE_FILE_LIST=compose.prod.yaml:deploy/app/compose.yaml
MIN_CLOUDFLARE_RANGES=10

failures=0

pass() {
  echo "PASS $*"
}

failed() {
  echo "FAIL $*"
  failures=$((failures + 1))
}

# Runs a command with its output discarded, and reports the result under a name.
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$name"
  else
    failed "$name"
  fi
}

# Reports the first output line of a command, for versions.
check_version() {
  local name="$1"
  shift
  local version
  if version="$("$@" 2>&1)"; then
    pass "$name: ${version%%$'\n'*}"
  else
    failed "$name"
  fi
}

# The same parsing and rule list as ops/node/bootstrap.sh, which runs on a host where this file may not exist yet.

parse_cloudflare_ranges() {
  awk '
    $1 == "set_real_ip_from" {
      value = $2
      sub(/;$/, "", value)
      if (value ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/) print value
    }
  ' "$1"
}

extra_443_source_lines() {
  [[ -f "$1" ]] || return 0
  awk '!/^[ \t\r]*$/ && !/^#/ { print FNR, $0 }' "$1"
}

parse_extra_443_sources() {
  extra_443_source_lines "$1" | cut -d ' ' -f 2-
}

persisted_input_rules() {
  [[ -f "$1" ]] || return 0
  awk '$1 ~ /^\*/ { table = $1 } table == "*filter" && /^-A INPUT / { print }' "$1"
}

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

# The variable names of an env file, sorted, without their values.
env_key_names() {
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$1" | sort
}

# The value of a variable that holds no secret.
env_value() {
  sed -n "s/^$2=//p" "$1"
}

compose() {
  (
    cd "$APP_DIR" || exit 1
    env -u COMPOSE_FILE -u API_TAG -u DATABASE_URL docker compose "$@"
  )
}

# Checks.

os_is_ubuntu_2404() {
  local os_id os_version
  os_id="$(. /etc/os-release && echo "$ID")"
  os_version="$(. /etc/os-release && echo "$VERSION_ID")"
  [[ "$os_id" == "ubuntu" && "$os_version" == "24.04" ]]
}

daemon_log_options_match() {
  python3 -c '
import json, sys
expected = {"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}
with open(sys.argv[1]) as config:
    sys.exit(0 if json.load(config) == expected else 1)
' "$DOCKER_DAEMON_CONFIG"
}

rlimit_follows_worker_processes() {
  grep -A1 '^worker_processes' "$NGINX_MAIN_CONFIG" | grep -q '^worker_rlimit_nofile 8192;$'
}

worker_connections_set() {
  grep -Eq '^[[:space:]]*worker_connections 4096;$' "$NGINX_MAIN_CONFIG"
}

site_link_points_to_clone() {
  [[ "$(readlink "$NGINX_SITE_LINK")" == "$NGINX_SITE" ]]
}

default_site_absent() {
  [[ ! -e /etc/nginx/sites-enabled/default ]]
}

listens_on_443() {
  ss -H -ltn | awk '$4 ~ /:443$/ { found = 1 } END { exit !found }'
}

api_port_on_loopback_only() {
  local addresses
  addresses="$(ss -H -ltn | awk '$4 ~ /:3000$/ { print $4 }' | sort -u)"
  [[ "$addresses" == "127.0.0.1:3000" ]]
}

check_firewall() {
  local ranges=() sources=() rules expected allowed
  mapfile -t sources < <(parse_extra_443_sources "$EXTRA_443_SOURCES")
  pass "extra 443 sources: ${#sources[@]}"
  mapfile -t ranges < <(parse_cloudflare_ranges "$CLOUDFLARE_CONFIG")
  if ((${#ranges[@]} < MIN_CLOUDFLARE_RANGES)); then
    failed "Cloudflare ranges parsed from the repository: ${#ranges[@]}"
    return
  fi
  pass "Cloudflare ranges parsed from the repository: ${#ranges[@]}"

  rules="$(iptables -S INPUT | grep '^-A INPUT ')"
  expected="$(expected_input_rules "${sources[@]}" "${ranges[@]}")"

  allowed="$(sed -n 's/^-A INPUT -s \([^ ]*\) .*--dport 443 .*/\1/p' <<<"$rules" | sort)"
  if [[ "$allowed" == "$(printf '%s\n' "${sources[@]}" "${ranges[@]}" | sort)" ]]; then
    pass "iptables 443 allow rules equal the parsed ranges and extra sources"
  else
    failed "iptables 443 allow rules equal the parsed ranges and extra sources"
  fi
  if grep -qx -- "-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT" <<<"$rules"; then
    pass "iptables ssh rule present"
  else
    failed "iptables ssh rule present"
  fi
  if [[ "$(tail -n 1 <<<"$rules")" == "-A INPUT -j REJECT --reject-with icmp-host-prohibited" ]]; then
    pass "iptables chain ends in REJECT"
  else
    failed "iptables chain ends in REJECT"
  fi
  if [[ "$rules" == "$expected" ]]; then
    pass "iptables INPUT rules match what bootstrap builds"
  else
    failed "iptables INPUT rules match what bootstrap builds"
  fi
  if [[ "$(persisted_input_rules "$PERSISTED_RULES")" == "$expected" ]]; then
    pass "persisted INPUT rules equal the expected rules"
  else
    failed "persisted INPUT rules equal the expected rules"
  fi
}

check_file_owner_and_mode() {
  local path="$1" expected="$2" actual
  actual="$(stat -c '%U:%G %a' "$path" 2>/dev/null)"
  if [[ "$actual" == "$expected" ]]; then
    pass "$path is $actual"
  else
    failed "$path is ${actual:-missing}, expected $expected"
  fi
}

# The file is optional, and any mode of 0600 or stricter passes.
check_extra_443_file() {
  local path="$EXTRA_443_SOURCES" actual
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ -L "$path" || ! -f "$path" ]]; then
    failed "$path is a regular file"
    return 0
  fi
  actual="$(stat -c '%U %a' "$path")"
  if [[ "${actual%% *}" == "root" ]] && (((8#${actual##* } & 8#077) == 0)); then
    pass "$path is $actual"
  else
    failed "$path is $actual, expected root and 0600 or stricter"
  fi
}

check_env_file() {
  local env_file="$APP_DIR/.env" group keys
  group="$(id -gn "$APP_USER")"
  check_file_owner_and_mode "$env_file" "$APP_USER:$group 600"

  keys="$(env_key_names "$env_file" | tr '\n' ' ')"
  if [[ "$keys" == "API_TAG COMPOSE_FILE DATABASE_URL " ]]; then
    pass ".env keys: $keys"
  else
    failed ".env keys: $keys"
  fi
  if grep -q '^MIGRATE_DATABASE_URL=' "$env_file"; then
    failed ".env does not define MIGRATE_DATABASE_URL"
  else
    pass ".env does not define MIGRATE_DATABASE_URL"
  fi
  if [[ "$(env_value "$env_file" COMPOSE_FILE)" == "$COMPOSE_FILE_LIST" ]]; then
    pass ".env COMPOSE_FILE is the two-file list"
  else
    failed ".env COMPOSE_FILE is the two-file list"
  fi
}

api_is_healthy() {
  [[ "$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null)" == "api healthy" ]]
}

check_running_image() {
  local tag container image
  tag="$(env_value "$APP_DIR/.env" API_TAG)"
  container="$(compose ps -q api 2>/dev/null)"
  image="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null)"
  if [[ -n "$tag" && "${image##*:}" == "$tag" ]]; then
    pass "running image tag equals API_TAG: $tag"
  else
    failed "running image tag equals API_TAG: running ${image##*:}, .env $tag"
  fi
}

check_http() {
  local name="$1"
  shift
  local code
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$@")"
  if [[ "$code" == "200" ]]; then
    pass "$name: 200"
  else
    failed "$name: $code"
  fi
}

main() {
  if ((EUID != 0)); then
    failed "must run as root"
    exit 1
  fi

  local hostname
  hostname="$(parse_server_name "$NGINX_SITE")"

  check "OS is Ubuntu 24.04" os_is_ubuntu_2404
  check_version "docker version" docker --version
  check_version "compose version" docker compose version
  check_version "nginx version" nginx -v
  check "daemon.json log options" daemon_log_options_match
  check "nginx -t" nginx -t
  check "worker_rlimit_nofile 8192 follows worker_processes" rlimit_follows_worker_processes
  check "worker_connections 4096" worker_connections_set
  check "site symlink points to the clone" site_link_points_to_clone
  check "default site removed" default_site_absent
  check "listening on 443" listens_on_443
  check "3000 listening on loopback only" api_port_on_loopback_only
  check_firewall
  check_extra_443_file
  check_file_owner_and_mode "$TLS_DIR/origin.pem" "root:root 644"
  check_file_owner_and_mode "$TLS_DIR/origin.key" "root:root 600"
  check_env_file
  check "docker compose ps shows api healthy" api_is_healthy
  check_running_image
  check_http "api on loopback" http://127.0.0.1:3000/healthz
  check_http "nginx on loopback" -k --resolve "$hostname:443:127.0.0.1" "https://$hostname/healthz"

  if ((failures > 0)); then
    echo "verify: $failures checks failed"
    exit 1
  fi
  echo "verify: all checks passed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
