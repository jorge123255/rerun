#!/bin/sh
# The SDK merges the engine environment into spawned processes. Rebuild the environment at
# the exec boundary so the runner never inherits Rerun's engine key, DB key or CLI configuration.
set -eu
bin_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname "$0")" && pwd -P)
profile=$(CDPATH= cd -P -- "${RERUN_CODEX_PROFILE:?Missing Rerun Codex profile}" && pwd -P)
# Security.framework locates the user's default Keychain using HOME. CODEX_HOME, cwd and
# TMPDIR are still private to Rerun; Seatbelt denies access to other personal files.
mac_home=${RERUN_MAC_HOME:?Missing Mac account home}
keychain=$(/usr/bin/env -i HOME="$mac_home" /usr/bin/security default-keychain -d user | /usr/bin/sed -n 's/^[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p')
case "$keychain" in /*) ;; *) exit 2 ;; esac
keydir=$(CDPATH= cd -P -- "$(/usr/bin/dirname "$keychain")" && pwd -P)
keychain="$keydir/${keychain##*/}"
# Only chat workers receive these per-coworker grants. Account and one-shot workers use neither.
code_host=0
code_host_flag=--disable
if [ "${RERUN_DESKTOP_CODEX_CODE_MODE:-0}" = 1 ] && [ "${RERUN_CODEX_ACCOUNT_OP:-0}" != 1 ]; then
    code_host=1
    code_host_flag=--enable
fi
web=disabled
if [ "${RERUN_DESKTOP_CODEX_WEB:-0}" = 1 ] && [ "${RERUN_CODEX_ACCOUNT_OP:-0}" != 1 ]; then web=live; fi
# Native commands must use the engine's credential-free worker. Without this env
# Codex would execute locally even if the thread had an exec_server_url override.
shell_feature=--disable
exec_server_env=CODEX_EXEC_SERVER_URL=none
worker_url=${RERUN_NATIVE_EXEC_URL:-}
if [ -n "$worker_url" ]; then
    [ "${RERUN_CODEX_ACCOUNT_OP:-0}" != 1 ] || exit 2
    /usr/bin/printf '%s\n' "$worker_url" | /usr/bin/grep -Eq '^ws://127\.0\.0\.1:[1-9][0-9]{0,4}/[A-Za-z0-9_-]{32,128}$' || exit 2
    exec_server_env="CODEX_EXEC_SERVER_URL=$worker_url"
    if [ "${RERUN_NATIVE_SHELL:-0}" = 1 ]; then shell_feature=--enable; fi
fi
output=/dev/null
# The exec adapter writes one explicitly requested response file under its own temporary directory.
previous=
for arg in "$@"; do
    if [ "$previous" = "--output-last-message" ]; then
        case "$arg" in
            */codex-cli-*/last-message.txt) output=$(CDPATH= cd -P -- "$(/usr/bin/dirname "$arg")" && pwd -P)/last-message.txt ;;
            *) exit 2 ;;
        esac
    fi
    previous=$arg
done
exec /usr/bin/env -i HOME="$mac_home" CODEX_HOME="$profile/state" TMPDIR="$profile/tmp" PATH=/usr/bin:/bin LANG=en_US.UTF-8 "$exec_server_env" \
    /usr/bin/sandbox-exec -D "PROFILE=$profile" -D "BINARY=$bin_dir/codex" -D "OUTPUT=$output" \
    -D "HOST=$bin_dir/codex-code-mode-host" -D "HOST_ALLOWED=$code_host" -D "KEYCHAIN=$keychain" -D "KEYDIR=$keydir" -D "ACCOUNT=${RERUN_CODEX_ACCOUNT_OP:-0}" -f "$bin_dir/rerun-codex.sb" \
    "$bin_dir/codex" -c 'cli_auth_credentials_store="keyring"' -c 'sandbox_mode="read-only"' -c 'approval_policy="never"' \
    -c "web_search=\"$web\"" -c 'project_doc_max_bytes=0' -c 'mcp_servers={}' -c 'skills.bundled.enabled=false' \
    "$shell_feature" shell_tool "$shell_feature" unified_exec --disable hooks --disable plugins --disable apps \
    --disable image_generation --disable in_app_browser --disable multi_agent --disable multi_agent_v2 \
    --disable browser_use --disable computer_use --disable in_app_local_automation --disable in_app_voice \
    "$code_host_flag" code_mode_host --disable remote_plugin --disable daemon_auto_start "$@"
