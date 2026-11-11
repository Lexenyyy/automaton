# Sourced by runtime-entrypoint.sh (fork, Phase 1).
# Loads API keys from the read-only secrets folder into the runtime process
# environment only. The sandbox container never sees this folder.
# Missing files are skipped. Values are never printed.

_automaton_secrets_dir=/run/secrets/automaton

_automaton_load_secret() {
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

unset -f _automaton_load_secret
unset _automaton_secrets_dir
