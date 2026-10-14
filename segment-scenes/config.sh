#!/usr/bin/env bash
# Shared configuration for direct script use. Make reads the same files itself.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_env_file() {
  local path="$1"
  local override="$2"
  local line key value
  [[ -f "$path" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ "$override" == "1" || -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$path"
}

# Precedence: an already-exported value (e.g. `make PORT=18088`, or an explicit shell
# export) wins; then .env; then the tracked env-default. Loading .env BEFORE env-default,
# both with override=0 ("set only when unset"), yields exactly that; override=1 on .env
# would clobber per-invocation overrides such as the e2e-offloading test's NAME=/PORT=
# containers.
load_env_file "$SCRIPT_DIR/.env" 0
load_env_file "$SCRIPT_DIR/env-default" 0

# Resolve tracked relative defaults against the project, not the caller's cwd.
[[ "$DATA_DIR" == /* ]] || DATA_DIR="$SCRIPT_DIR/$DATA_DIR"
[[ "$MODELS_DIR" == /* ]] || MODELS_DIR="$SCRIPT_DIR/$MODELS_DIR"

export SCRIPT_DIR
export DATA_DIR MODELS_DIR
