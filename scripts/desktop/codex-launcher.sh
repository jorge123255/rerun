#!/bin/sh
# The SDK merges the engine environment into spawned processes. Rebuild the environment at
# the exec boundary so the runner never inherits Rerun's engine key, DB key or personal HOME.
set -eu
bin_dir=$(CDPATH= cd -P -- "$(/usr/bin/dirname "$0")" && pwd -P)
profile=$(CDPATH= cd -P -- "${RERUN_CODEX_PROFILE:?Missing Rerun Codex profile}" && pwd -P)
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
exec /usr/bin/env -i HOME="$profile" CODEX_HOME="$profile/state" TMPDIR="$profile/tmp" PATH=/usr/bin:/bin LANG=en_US.UTF-8 \
    /usr/bin/sandbox-exec -D "PROFILE=$profile" -D "BINARY=$bin_dir/codex" -D "OUTPUT=$output" -f "$bin_dir/rerun-codex.sb" \
    "$bin_dir/codex" -c 'cli_auth_credentials_store="keyring"' -c 'sandbox_mode="read-only"' -c 'approval_policy="never"' \
    -c 'web_search="disabled"' -c 'project_doc_max_bytes=0' -c 'mcp_servers={}' -c 'skills.bundled.enabled=false' \
    --disable shell_tool --disable unified_exec --disable hooks --disable plugins --disable apps \
    --disable image_generation --disable in_app_browser --disable multi_agent --disable multi_agent_v2 "$@"
