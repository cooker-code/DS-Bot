# DS Bot security model

The threat model that security reviews and scans of this repository start from.

## System overview and trust boundaries

The `ds-bot` plugin runs a team of long-lived Bots in DSH Desktop or DSH Web on the user's computer.

Trust boundaries:
1. Untrusted content -> model -> Bot tools. Web pages, files, search results, connector/MCP results and messages from other Bots reach the model; the model's tool calls run with the Bot's permission preset.
2. Ordinary Bot -> Main Bot rights (create/change/stop Bots, groups, folders), enforced in `ds-bot/src/host/tools.js` via `rt.isMain`.
3. Model/tool output -> outbound model requests (secret redaction in `ds-bot/src/host/secrets.js`).
4. Browser renderer -> host: `POST /api/bot` channel (`ds-bot/src/host/channel.js`, `ROUTE` in `constants.js`).
5. Bot-produced HTML widgets -> app page (`ds-bot/src/client/widget-html.js`, `sandbox="allow-scripts"` iframe without same-origin).
6. Bot browser pages run in per-Bot partitions provided by DSH Desktop.

## Components

- **host** — plugin server side: `ds-bot/index.js`, `ds-bot/src/host/` (roster, tools, turns/delivery, groups, goals, parts, memory, schedules, permissions, privacy, folders, connectors, providers).
- **secrets** — `ds-bot/src/host/secrets.js` (`bot/secrets.json` mode 600, optional passphrase encryption at rest in `secrets-crypto.js`, `$DSH_SECRET_<NAME>`, redactor) and API keys/providers (`providers.js`, `models.js`).
- **client** — browser UI: `ds-bot/src/client/` (incl. widget-html, read-page, connectors UI) and generated `ds-bot/client.js`.
- **browser** — Bot browser bridge and browser plugins: `ds-bot/src/host/browser.js`, `browser-plugins.js`, `src/host/browser/`, `browser-plugins/`.
- **web-search** — `ds-bot/web-search.js`.

## Entry points and who reaches them

- Chat input from the user (trusted).
- Content the Bot reads: web pages (Bot browser, `read_browser`, web search), files in the work folder, connector/MCP tool results, messages from other Bots and group chats, scheduled-task prompts. **Attacker-controlled.**
- `/api/bot` HTTP endpoints and DSH Web UI: users authenticated by the DSH host.

## Assets (maintainer-ranked)

1. **Critical: API keys and Bot secrets** — provider keys, `secrets.json`, `$DSH_SECRET_*`, connector tokens. Must not leak to the model, logs, tool results, other Bots outside the secret's scope, or outbound requests.
2. **Critical: files on the user's computer** — outside the Bot's work folder.
3. Other: browser login state, conversations and memory.

## Attacker profiles

- **Primary (maintainer-confirmed): prompt injection** in web pages, files or messages that makes a Bot exceed its rights — exfiltrate keys/secrets, read or write user files outside its scope, gain Main Bot rights, change other Bots, bypass the permission preset or redaction.
- Lower concern (not chosen by the maintainer): malicious browser plugins or connectors, a rogue ordinary Bot acting by itself.

## Existing controls

- Main-Bot checks in `tools.js` (`rt.isMain`, `rt.isAdminOf`).
- Working folders, the team workspace and Bot photos stay out of DSH's data and the team's data (`folders.js` `guarded`/`inData`).
- Private Bots (`privacy.js`): user-only switch; other Bots cannot read a private Bot's working folder, memory or Sessions, and a private Bot's outbound sharing (`message_bot`, shared capabilities, writes outside its folder) requires user approval; protection stays after deletion until the user releases it in Settings.
- Per-Bot permission presets (`permissions.js`), set on every Session.
- Secrets: scoped per Bot (`canUse`), redacted from tool results and outbound model requests (`redactor`, JSON/URL-encoded forms).
- Optional encryption at rest: the secrets file can be a scrypt + AES-256-GCM envelope. A passphrase unlocks it in Settings or, for unattended starts, from `DS_BOT_SECRETS_PASSPHRASE` or `DS_BOT_SECRETS_PASSPHRASE_FILE`; a locked store has no values, refuses secret writes, and shows why in Settings.
- Connectors refuse non-HTTPS addresses (`connectors.js`).
- HTML widgets run in `sandbox="allow-scripts"` iframes. DSH Desktop supplies the isolated webview partitions for Bot browser panels.

## Out of scope / accepted risk (maintainer)

- **Encryption at rest does not protect a running host**: the process needs the decrypted values and, for encrypted stores, the passphrase (in memory or in the environment/passphrase file). A compromised process, a same-user process that can read the environment, or an administrator can get the keys. The benefit is disk copies and backups not carrying plaintext; keep the passphrase out of those copies.

- DSH itself is upstream; not explicitly ruled out, but fixes belong upstream (hard rule: never patch DSH).

## Open questions

- Should a secret scoped to one Bot be treated as hidden from Main Bots too?
