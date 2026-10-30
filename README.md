# 1Password MCP Server

[![CI](https://github.com/CakeRepository/1Password-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/CakeRepository/1Password-MCP/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@takescake/1password-mcp?color=cb3837)](https://www.npmjs.com/package/@takescake/1password-mcp)
[![Node](https://img.shields.io/node/v/@takescake/1password-mcp)](https://www.npmjs.com/package/@takescake/1password-mcp)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-0ea5e9)](https://modelcontextprotocol.io/specification/2026-07-28)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Give your AI assistant a locked door to 1Password — not a pile of passwords in the chat.**

`@takescake/1password-mcp` is a community [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server. It lets Claude, Cursor, VS Code Copilot, OpenAI Codex, Gemini, and other MCP clients manage vaults and credentials through a [1Password Service Account](https://developer.1password.com/docs/service-accounts/).

Built on the **MCP TypeScript SDK v2** with protocol negotiation for **[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)** (and legacy clients). Secrets stay in 1Password; agents prefer `op://` references and `op_run` so plaintext never has to land in the model transcript.

> **Not an official 1Password product.** Community-built, Apache 2.0 licensed.

---

## Who this is for

| You are… | You get… |
|----------|----------|
| **Not deeply technical** | A one-time setup: create a service account, paste the token into your AI app’s MCP settings, then ask in plain English (“list my automation vault”, “rotate the staging DB password”). |
| **An agent / LLM** | Fifteen typed tools, four workflow prompts, three browsable resources, and clear rules: **prefer `op_run` + `op://` over revealing secrets**. |
| **A developer / SRE** | Full item CRUD, secure notes, password generation, vault allow-lists, Keychain token loading on macOS, and CI-friendly env config. |

---

## Why teams pick this server

- **Security-first defaults** — `password_read` returns metadata, and `item_get` hides secret-bearing fields (passwords, SSH keys, OTP seeds, card numbers), unless you opt in with `reveal: true`.
- **`op_run` (the MCP equivalent of `op run`)** — inject `op://vault/item/field` into a local command’s environment; resolved secrets are redacted from the returned stdout/stderr on a best-effort basis (including common encodings).
- **Full vault toolkit** — list, search, get, edit, create logins & notes, rotate passwords, archive, or delete.
- **Guided prompts** — password generation, credential rotation, vault audit, and secret-reference helpers.
- **Browsable resources** — vault and item catalogs over `onepassword://…` URIs (no secrets in resource payloads).
- **Modern MCP** — stdio transport, Zod 4 schemas, MCP 2026-07-28 negotiation with legacy client compatibility.

---

## What you get

### Tools (15)

Grouped the way agents and humans actually use them.

#### Discover

| Tool | What it does |
|------|----------------|
| `vault_list` | List vaults the service account can access (id, name, description, type), limited to the allow-list if one is set. |
| `item_lookup` | Search by title substring and optional exact `tag`; supports `limit` (max 200), `pageSize`, and `cursor`. |
| `item_list` | List metadata (id, title, category, tags, `updatedAt`), with optional exact `tag`, `pageSize`, and `cursor`. Never returns secret values. |

#### Read (safe by default)

| Tool | What it does |
|------|----------------|
| `item_get` | Full item: title, category, tags, notes, fields. Secret-bearing values (passwords and other concealed fields, SSH private keys, OTP seeds, card numbers) stay hidden unless `reveal: true`; only known non-secret field types are shown. **Notes are returned as-is.** Accepts `op://…` **or** `vaultId` + `itemId`. |
| `password_read` | Read one field (default `password`) via `op://…` or ids. **Metadata-only unless `reveal: true`.** Prefer `op_run` to *use* a secret. |
| `op_check_ref` | Validate `op://vault/item/field` or `op://vault/item/section/field` and return non-secret metadata only (vault, item, field). Never the value. |

#### Create & update

| Tool | What it does |
|------|----------------|
| `password_create` | Create a Login or Password item. Supply exactly one `password` or `generate` object. Returns an ID-based `secretReference` when saved metadata permits, or a successful write with a warning and no reference; `returnSecret` defaults to `false`. |
| `note_create` | Create a Secure Note with optional tags and custom fields. |
| `password_update` | Supply exactly one `newPassword` or `generate` object. Updates or creates a password field. Returns an ID-based `secretReference` when saved metadata permits, or a successful write with a warning and no reference. Converts the selected field to `Concealed`. |
| `item_edit` | Update title, notes (empty string clears), tags, and the first website URL; update, create, or remove fields. Preserves other website properties, secondary websites, and unrelated fields. |
| `password_generate` | Cryptographically secure random password (length 8–128; symbols/numbers/uppercase toggles). |
| `password_generate_memorable` | Passphrase from 402 distinct words. Defaults to seven words, `-` separators, capitalized words, and random number/symbol suffixes. Returns the password and an entropy estimate. |

#### Generate and store without returning the value

Use one server call to generate and store a password:

```json
{
  "vaultId": "vault-id",
  "title": "Example login",
  "generate": { "style": "memorable" }
}
```

Pass this input to `password_create`. For `password_update`, replace `title` with `itemId` and optionally specify `field`. Omit `password` / `newPassword` when you supply `generate`. Both tools validate exactly one explicit value or generation request before SDK access. Keep `returnSecret: false` (the default). When saved metadata permits, both tools return `secretReference` as `op://vaultId/itemId/fieldId`, or `op://vaultId/itemId/sectionId/fieldId` for a field in a section. IDs come from the saved SDK response. These references have not been live-resolved in this change.

If a write succeeds but saved metadata is incomplete or ambiguous, the response remains successful. It includes item metadata and a fixed `warning`, but no `secretReference`: "Password saved, but no reliable secret reference is available from the SDK response. Do not retry the write; inspect item metadata." Use `item_get` with `reveal: false` to inspect field and section metadata. Do not repeat the write to obtain a reference. `returnSecret: true` remains the only way to include the password.

`op_check_ref` checks a supplied section before it selects the field, so identical field IDs in different sections cannot select the wrong section. Names and IDs retain case-insensitive matching, with exact IDs first; ambiguous matches fail. References require three or four nonempty path segments. Parsing keeps percent-encoded text and query text literal; it does not decode them or add query handling. The SDK receives the original reference unchanged.

Generation options use the same defaults as the standalone tools:

- `style: "random"`: `length` (8–128, default 20), `includeSymbols`, `includeNumbers`, and `includeUppercase` (all default `true`).
- `style: "memorable"`: `wordCount` (2–10, default 7), `separator` (0–5 characters, default `-`), `includeNumber`, `includeSymbol`, and `capitalize` (all default `true`).

Seven independently selected words provide approximately 60.6 bits. The random number (0–99) and eight-symbol suffix increase the default estimate to approximately 70.2 bits. Fixed capitalization and separators add no entropy. The estimate uses the actual deduplicated dictionary length (402 words from 420 raw entries). Standalone memorable generation returns `dictionarySize` and `entropyBits`. For an empty or alphabetic-only separator, it returns `samplingEntropyBits` and an upper-bound explanation instead of claiming exact output entropy. Explicit options, including shorter passphrases, remain available.

Generate-and-store updates 1Password only. It does not rotate an external service credential atomically. SDK failures do not trigger a second write. `password_create`, `password_update`, and `item_edit` log and return fixed operation-specific messages, never the SDK exception's message, stack, cause, or raw properties. The message states that the write outcome may be unknown; check item metadata before retrying. Local exactly-one, field-ambiguity, and conflicting-field-operation diagnostics remain available. Vault verification failures return a safe denial-or-verification-failure message without the SDK exception. `op_run` output redaction remains best effort.

#### Field selection and website updates

`item_edit` and `password_update` select an exact field ID first, then a unique case-insensitive ID, then a unique case-insensitive title. `password_update` also supports legacy labels. Ambiguous matches return candidate IDs and section IDs without values; select a unique field ID or title. If one ID occurs in multiple sections, use a unique title. `password_update` retains the selected section and ID through the single write and matches that exact identity in the saved response. `item_edit` resolves all operations against the original fields. It rejects repeated updates and remove/update combinations for the same field. Missing update targets still create fields.

**Security change:** `password_update` changes the selected field type to `Concealed`, even if it was a text field. It preserves the field's ID, section, title, and other properties. Both update tools preserve the fetched item version. A live test with SDK `0.3.1` on 2026-10-30 confirms that a stale-version write is rejected and the newer write remains intact. This is observed SDK behavior, not an additional server-side concurrency guarantee. Failed writes are not retried.

When `item_edit` receives `url`, it changes only the first website entry's URL. It preserves that entry's label and autofill behavior, all secondary entries, and order. If no entry exists, it adds one. If you omit `url`, websites remain unchanged. “First” does not mean a verified SDK primary designation.

#### Bounded metadata pages

For `item_list` or `item_lookup`, set `pageSize` (1–200). A page returns `items`, `count` for that page, and `nextCursor` (`null` on the final page). Pass a non-null `nextCursor` as `cursor` for the next call. If you supply only `cursor`, the page size defaults to 50. Keep the same tool, vault, query, tag, and lookup limit. Cursors are opaque, validated, and valid only in the current server process. Invalid, changed-filter, or out-of-range cursors return an error.

Pages sort by title, then ID. Tag matching is exact and case-sensitive. Lookup query matching remains case-insensitive. Lookup `limit` caps the complete filtered result across pages. Without `pageSize` or `cursor`, both tools preserve the previous response shape and SDK order, including lookup's existing local limit behavior.

Pagination and tag filtering run locally on typed SDK list metadata. They reduce response size, not SDK fetch cost. They do not fetch full items for tags. Vault changes between calls can cause skipped or repeated items; pages are not a snapshot. Only explicitly allowed metadata properties enter responses.

#### Use secrets without revealing them

| Tool | What it does |
|------|----------------|
| `op_run` | Run a local command (`command` **or** `argv`) with env vars. Values matching `op://…` are resolved into the **child process only**; resolved secrets are redacted from returned output (best effort — see Security & privacy). Output is capped at 5 MiB per stream, and a timeout kills the whole process tree. Optional `cwd`, `shell`, `timeout_ms`, `stdin`. |

#### Soft-delete & destroy

| Tool | What it does |
|------|----------------|
| `item_archive` | Move an item to the archive (hidden from normal views). |
| `item_delete` | Permanently delete an item — **cannot be undone**. |

### Prompts (4)

| Prompt | When to use it |
|--------|----------------|
| `generate-secure-password` | Generate (random or memorable) and optionally store — without dumping the password into chat. |
| `credential-rotation` | Find, verify access, generate/store with `password_update`, and return its reference. Coordinate the external service change separately. |
| `vault-audit` | Inventory a vault by category; flag duplicates / oddities — never reveal secrets. |
| `secret-reference-helper` | Build a paste-ready `op://vault/item/field` from names. |

### Resources (3)

| URI | Contents |
|-----|----------|
| `onepassword://config` | Non-secret server config (name, version, log level, token source, Node version). |
| `onepassword://vaults` | JSON list of accessible vaults (limited to the allow-list if one is set). |
| `onepassword://vaults/{vaultId}/items` | URI template (listed by `resources/templates/list`): JSON item metadata for one vault (no secret values). |

> **Upgrading from 4.x:** resource URIs used to start with `1password://`, which MCP clients could never read (a URI scheme can't start with a digit). Replace any hard-coded `1password://` URIs with `onepassword://`.

---

## Before you start

You need two things:

1. **Node.js 20 or newer**
2. A **1Password Service Account** with access to the vault(s) you want the AI to use

### Create a service account (plain English)

1. Sign in to your 1Password account on the web.
2. Open **Developer** → **Service Accounts** (or follow [1Password’s guide](https://developer.1password.com/docs/service-accounts/)).
3. Create a service account and grant it **only** the vaults you want automation to touch (for example an `Automation` or `CI` vault — not your personal banking vault).
4. Copy the token once. Treat it like a master key.

---

## Quick start

### Claude Desktop / Cursor / VS Code / most IDEs

Add this to your MCP config (exact file depends on the app):

```json
{
  "mcpServers": {
    "1password": {
      "command": "npx",
      "args": ["-y", "@takescake/1password-mcp"],
      "env": {
        "OP_SERVICE_ACCOUNT_TOKEN": "YOUR_SERVICE_ACCOUNT_TOKEN"
      }
    }
  }
}
```

Restart the app, then try: *“List my 1Password vaults.”*

### macOS Keychain (no token in the config file)

Store the token in Keychain, then point the server at it:

```json
{
  "mcpServers": {
    "1password": {
      "command": "npx",
      "args": ["-y", "@takescake/1password-mcp"],
      "env": {
        "OP_KEYCHAIN_SERVICE": "op-service-account-claude-automation",
        "OP_KEYCHAIN_ACCOUNT": "your-macos-username"
      }
    }
  }
}
```

**Token resolution order:** CLI (`--service-account-token` / `--token`) → `OP_SERVICE_ACCOUNT_TOKEN` → macOS Keychain. `OP_KEYCHAIN_ACCOUNT` is optional when the service name alone is unique. Avoid the CLI flags: command-line arguments are visible to other local processes, and the server logs a warning at startup if you use them.

### OpenAI Codex (TOML)

**Option A** — token in config:

```toml
[mcp_servers."1password"]
command = "npx"
args = ["-y", "@takescake/1password-mcp"]

[mcp_servers."1password".env]
OP_SERVICE_ACCOUNT_TOKEN = "YOUR_SERVICE_ACCOUNT_TOKEN"
```

**Option B** *(recommended)* — config only names the env var:

```toml
[mcp_servers."1password"]
command = "npx"
args = ["-y", "@takescake/1password-mcp"]
env_vars = ["OP_SERVICE_ACCOUNT_TOKEN"]
```

Set `OP_SERVICE_ACCOUNT_TOKEN` in your shell or CI. Note: `codex mcp add ... --env OP_SERVICE_ACCOUNT_TOKEN=...` writes the secret into Codex config; prefer `env_vars` when you can.

On macOS you can omit the token env and use `OP_KEYCHAIN_SERVICE` (+ optional `OP_KEYCHAIN_ACCOUNT`) instead.

### Optional: restrict the server to certain vaults

By default the server can use any vault the service account can see. To allow-list vaults:

```json
{
  "env": {
    "OP_SERVICE_ACCOUNT_TOKEN": "YOUR_SERVICE_ACCOUNT_TOKEN",
    "OP_MCP_ALLOWED_VAULTS": "Automation, CI"
  }
}
```

Names or IDs work (case-insensitive). Same setting via `--allowed-vaults`. The allow-list applies **server-wide**, to every tool and resource that touches a vault, not only `op_run` / `op_check_ref`:

- `vault_list` and `onepassword://vaults` show only allowed vaults.
- Tools that take a `vaultId`, and the `onepassword://vaults/{vaultId}/items` resource, must be given the vault’s ID (not its name); vaults outside the list are rejected.
- `op://` references are checked both as written and by the vault they actually resolve to.
- When an allow-list is set, each guarded call makes one extra `vaults.list` read (mind service-account rate limits), and the server fails closed if vaults can’t be listed.

> **Upgrading from 4.0.3 or earlier?** If you set this expecting it to affect only `op_run` / `op_check_ref`, it now restricts everything.

This is defense in depth: **scope the service account’s own vault access in 1Password first.**

---

## For agents: how to handle secrets

Follow this order every time:

1. **Discover** with `vault_list` → `item_lookup` / `item_list` (metadata only).
2. **Confirm a reference** with `op_check_ref` — never `reveal` just to see if a path exists.
3. **Use** a secret in a command or API call with **`op_run`** and `op://vault/item/field` in `env`.
4. **Reveal** with `password_read` / `item_get` + `reveal: true` only when the human explicitly needs the value in chat.
5. **Generate and store** with `password_create` or `password_update` plus `generate` (keep `returnSecret: false` unless asked). Use the returned `secretReference` when present. If the tool returns a successful write with a warning and no reference, inspect metadata instead of repeating the write. Coordinate external credential changes separately.
6. Prefer **`item_archive`** over **`item_delete`** unless permanent removal is required.

### `op_run` sketch

```json
{
  "argv": ["curl", "-sS", "https://api.example.com/health"],
  "env": {
    "API_TOKEN": "op://Automation/Example API/credential"
  },
  "timeout_ms": 60000
}
```

Prefer `argv` over a shell `command` string when you can — fewer quoting surprises.

---

## Configuration reference

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OP_SERVICE_ACCOUNT_TOKEN` | Usually yes | Service account token. Not required on macOS if Keychain vars are set. |
| `OP_KEYCHAIN_SERVICE` | No | macOS: Keychain service name for the token. |
| `OP_KEYCHAIN_ACCOUNT` | No | macOS: optional account to narrow the Keychain lookup. |
| `OP_MCP_ALLOWED_VAULTS` | No | Comma-separated vault names/IDs (case-insensitive) the server may use, enforced server-wide. Empty = unrestricted. |
| `OP_INTEGRATION_NAME` | No | Name reported to the 1Password SDK (default: `1password-mcp`). |
| `OP_INTEGRATION_VERSION` | No | Version reported to the SDK (default: package version). |
| `MCP_LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default: `info`). |
| `MCP_DEBUG` | No | If set, forces debug logging. |

### CLI flags

```
--service-account-token <token>   1Password service account token (avoid: visible to other local processes)
--token <token>                   Alias for --service-account-token
--log-level <level>               error | warn | info | debug (default: info)
--integration-name <name>         Custom integration name for the 1Password SDK
--integration-version <version>   Custom integration version
--allowed-vaults <list>           Comma-separated vault allow-list (names or IDs), applied server-wide
```

---

## Security & privacy

> **Read this before pointing the server at a vault you care about.**

- **LLM privacy** — Anything revealed to the model may be sent to your AI provider and retained under their policies.
- **MCP is not end-to-end encrypted for secrets in flight** — Values are plaintext inside the MCP workflow and toward the model. They are encrypted at rest in 1Password once stored.
- **Best fit** — Automation credentials: CI tokens, bot accounts, disposable env secrets.
- **Avoid** — Banking, primary personal logins, recovery codes, or anything you cannot afford to expose to a model provider.
- **Token = master key** — Scope the service account tightly; rotate immediately if leaked; never commit tokens or MCP configs with secrets.
- **Prefer the env var or Keychain for the token** — `--token` / `--service-account-token` puts it in the process arguments, which other local processes can read (the server warns at startup). A same-user process can generally read the server’s environment too (for example `/proc/<pid>/environ` on Linux), so on macOS Keychain is the strongest option: it keeps the token out of config files and the process environment.
- **Prefer references** — `op://…` + `op_run` beat pasting passwords into prompts or files.
- **`op_run` runs arbitrary commands as your user** — Keep your MCP client’s approval prompts on for it; don’t auto-approve it.
- **Redaction is best effort** — `op_run` masks resolved secrets in returned output, including common encodings (base64, JSON- and URL-encoded forms, multi-line values). That protects against accidental disclosure. It is not a sandbox: a command can deliberately transform or transmit a secret it was given.
- **Notes are not concealed** — `item_get` returns notes as-is (like `op item get`). Don’t keep secrets in the notes of vaults an agent can read.
- **Least privilege** — Dedicated automation vaults beat sharing your whole account. `OP_MCP_ALLOWED_VAULTS` is a second fence, not a substitute.
- **Reporting vulnerabilities** — Open a public issue; see [SECURITY.md](SECURITY.md).

---

## Protocol & compatibility

| Piece | Detail |
|-------|--------|
| Package | `@takescake/1password-mcp` |
| Runtime | Node.js **≥ 20** |
| Transport | **stdio** |
| MCP SDK | `@modelcontextprotocol/server` v2 |
| Protocol | Negotiates **2026-07-28**; keeps legacy client compatibility |
| Registry name | `io.github.CakeRepository/1password` |

---

## Development

```bash
git clone https://github.com/CakeRepository/1Password-MCP.git
cd 1Password-MCP
npm ci
npm run build
npm test
npm run lint
```

Watch mode: `npm run dev`.

### Project layout

```
src/
  index.ts                 # Entrypoint — MCP stdio + protocol negotiation
  server.ts                # buildServer() — registers tools, prompts, resources
  config.ts                # CLI / env / Keychain / allow-list
  client.ts                # 1Password SDK client
  logger.ts                # Structured logs on stderr (stdout is protocol)
  secret-ref.ts            # op:// parsing & reference checks
  vault-access.ts          # Server-wide vault allow-list enforcement
  redaction.ts             # op_run output redaction
  utils.ts                 # Result helpers, password generation
  tools/                   # All 15 MCP tools
  prompts/                 # Interactive workflow prompts
  resources/               # onepassword:// resources
tests/
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Maintainers / agents: [agents.md](agents.md).

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history, including the **5.0.0** release (resource URIs moved from `1password://` to `onepassword://`, plus security hardening; read its **Changed** notes before upgrading), the **4.0.0** MCP v2 / 2026-07-28 migration, and the **3.0.0** `op_run` / reveal-opt-in security changes.

---

## License

[Apache License 2.0](LICENSE)
