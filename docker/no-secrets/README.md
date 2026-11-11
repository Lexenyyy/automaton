Empty on purpose. `docker/compose.agent.yml` mounts this folder as the runtime's
secrets folder when `AUTOMATON_SECRETS_DIR` is not set, so build, init and
verify never need real keys. Never put keys here; keep them outside the repo.
