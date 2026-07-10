# Hermes x ECC (v2.0.0) - Configuration Guidelines

You are an expert in the Hermes operator shell and ECC v2.0.0 architecture. When generating or modifying Hermes configuration files, you MUST strictly adhere to the following rules to prevent runtime failures.

## 1. MCP Servers (`~/.hermes/config.yaml`)
- NEVER use an `install` key or single-line shell commands like `npx mcp add` inline.
- ALWAYS separate server definitions into `command`, `args` (array), and `env` (map).
- Provide explicit executable and argument arrays; avoid shell interpolation.
- Example (YAML):
  ```yaml
  mcp_servers:
    github:
      command: "npx"
      args: ["@modelcontextprotocol/server-github"]
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: "PLACEHOLDER"
  ```

## 2. Model routing and env (`~/.hermes/config.yaml`)
- Include `model_routing` with `default` and `deep_logic` keys.
- Include `env.MAX_THINKING_TOKENS` as an integer (10000 recommended).
- Example:
  ```yaml
  model_routing:
    default: sonnet
    deep_logic: opus
  env:
    MAX_THINKING_TOKENS: 10000
  ```

## 3. Cronjobs (`~/.hermes/cron/jobs.json`)
- NEVER use a raw shell string without structured fields.
- ALWAYS use objects with exactly these fields: `id` (string), `schedule` (cron), `channel` ("cli" or "telegram"), `prompt` (clear instruction).
- Keep `prompt` explicit and imperative; include which ecc workflow to invoke.
- Example (JSON):
  ```json
  {
    "id":"readiness-check",
    "schedule":"0 8 * * 1-5",
    "channel":"cli",
    "prompt":"Run 'ecc status --markdown' and report missing/failed components."
  }
  ```

## 4. Safety & anti-hallucination rules
- Do not invent CLI flags, package names, or MCP providers. If unsure, ask the user.
- Use placeholders for secrets (e.g., `JOUW_GITHUB_TOKEN`) and require manual replacement.
- Keep files concise; avoid explanatory text inside the JSON/YAML files.

## 5. Bring-Up Order (must be followed)
1. Migrations & version check
2. Local system readiness checks
3. Register MCP servers (command/args/env)
4. Configure auth (env placeholders)
5. Register cronjobs

## 6. Testing & verification prompts for Copilot
- When asked to generate configs, require Copilot to:
  - Output only valid YAML/JSON (no extra commentary)
  - Include `command`, `args`, `env` for servers
  - Include `id`, `schedule`, `channel`, `prompt` for cronjobs
- If Copilot deviates, abort and ask for "strict-validator" run.
