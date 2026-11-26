# Sourced by runtime-entrypoint.sh (fork, Phase 1).
# Loads API keys from the read-only secrets folder into the runtime process
# environment only. The sandbox container never sees this folder.
# Missing files are skipped. Values are never printed.

_automaton_secrets_dir=/run/secrets/automaton

_automaton_secrets_fix="runtime: on a Linux host: sudo chown -R root:10001 <secrets dir>; sudo chmod 750 <secrets dir>; sudo chmod 640 <secrets dir>/*"

# Fork (Linux host): a secrets folder the runtime (uid/gid 10001) cannot enter
# hides every file in it (they would look missing). Refuse with the fix.
if [ -d "$_automaton_secrets_dir" ] && { ! [ -r "$_automaton_secrets_dir" ] || ! [ -x "$_automaton_secrets_dir" ]; }; then
  echo "runtime: refusing to start: the secrets folder is not readable by the runtime (uid/gid 10001)." >&2
  echo "$_automaton_secrets_fix" >&2
  exit 78
fi

_automaton_load_secret() {
  # Fork (Linux host): a file the runtime cannot read is a setup error, not a
  # missing key. Say which file and how to fix it (never its value).
  if [ -e "$_automaton_secrets_dir/$1" ] && ! [ -r "$_automaton_secrets_dir/$1" ]; then
    echo "runtime: refusing to start: secret file $1 is not readable by the runtime (uid/gid 10001)." >&2
    echo "$_automaton_secrets_fix" >&2
    exit 78
  fi
  if [ -f "$_automaton_secrets_dir/$1" ]; then
    _automaton_value=$(tr -d '\r\n' < "$_automaton_secrets_dir/$1")
    if [ -n "$_automaton_value" ]; then
      export "$2=$_automaton_value"
    fi
    unset _automaton_value
  fi
}

_automaton_load_secret openai_api_key OPENAI_API_KEY
_automaton_load_secret anthropic_api_key ANTHROPIC_API_KEY
_automaton_load_secret groq_api_key GROQ_API_KEY
_automaton_load_secret together_api_key TOGETHER_API_KEY
# Fork (Phase 3): wallet encryption passphrase. The runtime removes it from its
# environment right after reading it (src/identity/wallet-crypto.ts).
_automaton_load_secret wallet_passphrase AUTOMATON_WALLET_PASSPHRASE

unset -f _automaton_load_secret
unset _automaton_secrets_dir _automaton_secrets_fix
