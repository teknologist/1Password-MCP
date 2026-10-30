/**
 * password_update — Update a password field on an existing 1Password item.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ItemFieldType, type ItemField } from "@1password/sdk";
import { getClient } from "../client.js";
import { log, logError } from "../logger.js";
import { jsonResult, errorResult } from "../utils.js";
import { assertVaultIdAllowed } from "../vault-access.js";
import { selectFieldIndex } from "../field-selection.js";
import { generationOptions, storedPassword, passwordReference, passwordError, PASSWORD_REFERENCE_WARNING } from "../password-generation.js";

export function registerPasswordUpdate(server: McpServer): void {
  server.registerTool("password_update", { description: "Update or generate/store a password in one server call. Supply exactly one newPassword or generate. Selects IDs before unique titles, rejects ambiguity, converts the selected field to Concealed, and creates missing fields. Returns an ID-based secret reference when saved metadata permits; otherwise returns a successful write with a warning and no reference. SDK failures use fixed safe messages; check item metadata before retrying. Hides the value by default. Does not rotate external credentials.", inputSchema: z.object({
              vaultId: z.string().min(1).describe("Vault ID containing the item."),
              itemId: z.string().min(1).describe("Item ID to update."),
              newPassword: z.string().min(1).optional().describe("Explicit new password. Supply this or generate, not both."),
              generate: generationOptions.optional().describe("Generate and store internally. Supply this or newPassword, not both."),
              field: z
                .string()
                .optional()
                .describe(
                  "Field id or title to update. Defaults to 'password'.",
                ),
              returnSecret: z
                .boolean()
                .optional()
                .describe(
                  "If true, include the updated password in the response. Defaults to false for security.",
                ),
            }) }, async ({ vaultId, itemId, newPassword, generate, field, returnSecret }) => {
              if ((newPassword === undefined) === (generate === undefined)) {
                return errorResult(new Error("Supply exactly one explicit password value or generate options."));
              }
              try {
                const secret = storedPassword(newPassword, generate);
                log("debug", "Tool call: password_update.", {
                  vaultId,
                  itemId,
                  field,
                });
                const client = await getClient();
                try {
                  await assertVaultIdAllowed(client, vaultId);
                } catch {
                  const safeError = new Error(`Vault '${vaultId}' is not in the allowed vault list, or vault access verification failed.`);
                  logError("password_update failed.", safeError);
                  return errorResult(safeError);
                }
                if (!client?.items?.get) {
                  return errorResult(new Error("Your @1password/sdk version does not support getting items."));
                }
                if (!client?.items?.put) {
                  return errorResult(new Error("Your @1password/sdk version does not support updating items."));
                }

                const item = await client.items.get(vaultId, itemId);
                const desiredField = field ?? "password";
                const fields: ItemField[] = [...(item.fields ?? [])];
                let index: number;
                try {
                  index = selectFieldIndex(fields, desiredField, true);
                } catch (error) {
                  return errorResult(error);
                }
                if (index >= 0) {
                  fields[index] = { ...fields[index], fieldType: ItemFieldType.Concealed, value: secret };
                } else {
                  fields.push({
                    id: desiredField.toLowerCase(),
                    title: desiredField.toLowerCase(),
                    fieldType: ItemFieldType.Concealed,
                    value: secret,
                  });
                }

                const target = fields[index >= 0 ? index : fields.length - 1];
                const identity = { id: target.id, sectionId: target.sectionId };
                const updatedItem = await client.items.put({ ...item, fields });

                const response: Record<string, unknown> = {
                  id: updatedItem.id,
                  title: updatedItem.title,
                  vaultId: updatedItem.vaultId ?? vaultId,
                };

                try {
                  const reference = passwordReference(updatedItem, identity);
                  if (reference) response.secretReference = reference;
                  else response.warning = PASSWORD_REFERENCE_WARNING;
                } catch {
                  response.warning = PASSWORD_REFERENCE_WARNING;
                }
                if (returnSecret) {
                  response.password = secret;
                }

                return jsonResult(response);
              } catch {
                const safeError = passwordError("update");
                logError("password_update failed.", safeError);
                return errorResult(safeError);
              }
            });
}
