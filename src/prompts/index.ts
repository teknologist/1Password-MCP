/**
 * MCP Prompts — interactive prompt templates for 1Password workflows.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Register all MCP prompts on the server. */
export function registerAllPrompts(server: McpServer): void {
  // ─── generate-secure-password ─────────────────────────────────────

  server.registerPrompt("generate-secure-password", { description: "Guide through generating a secure password with specific requirements", argsSchema: z.object({
              purpose: z
                .string()
                .optional()
                .describe("What the password is for (e.g., 'database', 'API key', 'user account')."),
              style: z
                .enum(["random", "memorable"])
                .optional()
                .describe("Password style: 'random' for maximum entropy or 'memorable' for a passphrase. Defaults to 'random'."),
            }) }, async ({ purpose, style }) => {
              const passwordStyle = style ?? "random";
              const purposeText = purpose ? ` for "${purpose}"` : "";

              return {
                messages: [
                  {
                    role: "user" as const,
                    content: {
                      type: "text" as const,
                      text: [
                        `I need to generate a secure password${purposeText}.`,
                        ``,
                        `Please help me create a ${passwordStyle === "memorable" ? "memorable passphrase" : "strong random password"} with these steps:`,
                        ``,
                        `1. If I want to store it, use \`vault_list\` to select the vault, then call \`password_create\` with \`generate: { style: "${passwordStyle}" }\` and \`returnSecret: false\`. Generate and store in one server call; omit \`password\`.`,
                        passwordStyle === "random"
                          ? `   - Use at least 20 characters with uppercase, numbers, and symbols.`
                          : `   - Use 7 words from the 402-word dictionary with default number and symbol suffixes (about 70.2 bits with distinct word boundaries; words alone provide about 60.6 bits). Fixed capitalization and separators add no entropy.`,
                        `2. If present, return the tool's ID-based \`secretReference\` so I can use it in my configuration. If a successful write returns a \`warning\` without a reference, report the warning. Do not retry the write; inspect item metadata with \`item_get\` and \`reveal: false\`.`,
                        `   - SDK failures return fixed safe messages. Check item metadata before retrying because the write outcome may be unknown.`,
                        `3. Only if I request generation without storage, use \`password_generate${passwordStyle === "memorable" ? "_memorable" : ""}\`; its result contains the plaintext password.`,
                        `4. Do not claim storage succeeds unless the create call succeeds.`,
                        ``,
                        `Important: Do NOT display the raw password in your response unless I explicitly ask. Confirm storage only after a successful call. Provide the reference only when the tool returns one.`,
                      ].join("\n"),
                    },
                  },
                ],
              };
            });

  // ─── credential-rotation ──────────────────────────────────────────

  server.registerPrompt("credential-rotation", { description: "Step-by-step workflow for rotating a credential stored in 1Password", argsSchema: z.object({
              vaultId: z.string().optional().describe("Vault ID containing the credential to rotate."),
              itemId: z.string().optional().describe("Item ID of the credential to rotate."),
            }) }, async ({ vaultId, itemId }) => {
              const hasTarget = vaultId && itemId;

              return {
                messages: [
                  {
                    role: "user" as const,
                    content: {
                      type: "text" as const,
                      text: [
                        `I need to rotate a credential in 1Password.`,
                        ``,
                        hasTarget
                          ? `Target: vault \`${vaultId}\`, item \`${itemId}\`.`
                          : `I haven't specified which credential yet. Please help me find it.`,
                        ``,
                        `Follow this rotation workflow:`,
                        ``,
                        !hasTarget
                          ? `1. Use \`vault_list\` to show my vaults, then \`item_lookup\` to find the item.\n`
                          : "",
                        `${hasTarget ? "1" : "2"}. Use \`password_read\` to verify access to the current credential (with \`reveal: false\` for safety).`,
                        `${hasTarget ? "2" : "3"}. Call \`password_update\` with \`generate: { style: "random" }\` and \`returnSecret: false\`; omit \`newPassword\`. This generates and stores in one server call.`,
                        `${hasTarget ? "3" : "4"}. If storage succeeds and a reference is present, return the tool's ID-based \`secretReference\`. If the successful write returns a \`warning\` without a reference, report it. Do not retry the write; inspect item metadata with \`item_get\` and \`reveal: false\`.`,
                        `SDK failures return fixed safe messages. Check item metadata before retrying because the write outcome may be unknown.`,
                        ``,
                        `Important: This updates 1Password only. It does not rotate the external service credential atomically. Coordinate the external service change separately with my approval; use op_run with the reference rather than revealing the value.`,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    },
                  },
                ],
              };
            });

  // ─── vault-audit ──────────────────────────────────────────────────

  server.registerPrompt("vault-audit", { description: "Audit the contents of a 1Password vault — list all items with categories and metadata", argsSchema: z.object({
              vaultId: z.string().optional().describe("Vault ID to audit. If omitted, all vaults will be listed first."),
            }) }, async ({ vaultId }) => {
              return {
                messages: [
                  {
                    role: "user" as const,
                    content: {
                      type: "text" as const,
                      text: [
                        `I want to audit my 1Password vault${vaultId ? ` (vault ID: \`${vaultId}\`)` : ""}.`,
                        ``,
                        `Please perform the following:`,
                        ``,
                        !vaultId
                          ? `1. Use \`vault_list\` to show all accessible vaults and ask which one to audit.\n`
                          : "",
                        `${!vaultId ? "2" : "1"}. Use \`item_lookup\` with \`pageSize: 50\`. Follow each \`nextCursor\` as \`cursor\` with the same vault and filters until it is null. Pages bound response size, not SDK fetch cost; vault changes can skip or repeat items.`,
                        `${!vaultId ? "3" : "2"}. Summarize the findings:`,
                        `   - Total number of items`,
                        `   - Breakdown by category (Login, Password, etc.)`,
                        `   - List of all item titles (but NOT passwords)`,
                        `${!vaultId ? "4" : "3"}. Flag any concerns:`,
                        `   - Items without a category`,
                        `   - Duplicate-looking titles`,
                        `   - Any items that look like they could be consolidated`,
                        ``,
                        `Do NOT reveal any secret values during the audit.`,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    },
                  },
                ],
              };
            });

  // ─── secret-reference-helper ──────────────────────────────────────

  server.registerPrompt("secret-reference-helper", { description: "Help construct an op://vault/item/field secret reference from vault and item names", argsSchema: z.object({
              vaultName: z
                .string()
                .optional()
                .describe("Name of the vault (partial match is OK)."),
              itemName: z
                .string()
                .optional()
                .describe("Name of the item to reference (partial match is OK)."),
            }) }, async ({ vaultName, itemName }) => {
              return {
                messages: [
                  {
                    role: "user" as const,
                    content: {
                      type: "text" as const,
                      text: [
                        `I need to construct a 1Password secret reference (\`op://vault/item/field\`).`,
                        ``,
                        vaultName
                          ? `Vault name: "${vaultName}"`
                          : `I'm not sure which vault to use.`,
                        itemName
                          ? `Item name: "${itemName}"`
                          : `I'm not sure which item to reference.`,
                        ``,
                        `Steps:`,
                        `1. Use \`vault_list\` to find the vault${vaultName ? ` matching "${vaultName}"` : ""}.`,
                        `2. Use \`item_lookup\` with the vault ID${itemName ? ` and query "${itemName}"` : ""} to find the item.`,
                        `3. Use \`item_get\` with \`reveal: false\` to inspect field IDs, titles, and section IDs. Use only this metadata; do not display values or notes.`,
                        `4. Construct an ID-based \`op://vaultId/itemId/fieldId\` reference (include \`sectionId\` before \`fieldId\` when present), then validate it with \`op_check_ref\` and present it.`,
                        ``,
                        `The final reference should be ready to paste into my configuration files.`,
                      ].join("\n"),
                    },
                  },
                ],
              };
            });
}
