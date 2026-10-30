/**
 * password_create — Create a new password item in a 1Password vault.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as sdk from "@1password/sdk";
import { generationOptions, storedPassword, passwordReference, passwordError, PASSWORD_REFERENCE_WARNING } from "../password-generation.js";
import { getClient } from "../client.js";
import { log, logError } from "../logger.js";
import { jsonResult, errorResult } from "../utils.js";
import { assertVaultIdAllowed } from "../vault-access.js";

export function registerPasswordCreate(server: McpServer): void {
  server.registerTool("password_create", { description: "Create a password/login item. Supply exactly one password or generate options. Generation and storage use one server call. Returns an ID-based secret reference when saved metadata permits; otherwise returns a successful write with a warning and no reference. SDK failures use fixed safe messages; check item metadata before retrying. Hides the password unless returnSecret is true.", inputSchema: z.object({
              vaultId: z.string().min(1).describe("Vault ID to create the item in."),
              title: z.string().min(1).describe("Item title."),
              username: z
                .string()
                .optional()
                .describe("Username to store in the item."),
              password: z.string().min(1).optional().describe("Explicit password. Supply this or generate, not both."),
              generate: generationOptions.optional().describe("Generate and store a password internally. Supply this or password, not both."),
              category: z
                .enum(["Login", "Password"])
                .optional()
                .describe("Item category. Defaults to Login."),
              tags: z
                .array(z.string().min(1))
                .optional()
                .describe("Optional tags for organization."),
              notes: z.string().optional().describe("Optional notes."),
              url: z
                .string()
                .url()
                .optional()
                .describe("Optional website URL to associate."),
              returnSecret: z
                .boolean()
                .optional()
                .describe(
                  "If true, include the created password in the response. Defaults to false for security.",
                ),
            }) }, async ({
              vaultId,
              title,
              username,
              password,
              generate,
              category,
              tags,
              notes,
              url,
              returnSecret,
            }) => {
              if ((password === undefined) === (generate === undefined)) {
                return errorResult(new Error("Supply exactly one explicit password value or generate options."));
              }
              try {
                const secret = storedPassword(password, generate);
                log("debug", "Tool call: password_create.", { vaultId, title });
                const client = await getClient();
                try {
                  await assertVaultIdAllowed(client, vaultId);
                } catch {
                  const safeError = new Error(`Vault '${vaultId}' is not in the allowed vault list, or vault access verification failed.`);
                  logError("password_create failed.", safeError);
                  return errorResult(safeError);
                }
                if (!client?.items?.create) {
                  return errorResult(new Error("Your @1password/sdk version does not support creating items."));
                }

                const fields: sdk.ItemField[] = [];

                if (username) {
                  fields.push({
                    id: "username",
                    title: "username",
                    fieldType: sdk.ItemFieldType.Text,
                    value: username,
                  });
                }

                fields.push({
                  id: "password",
                  title: "password",
                  fieldType: sdk.ItemFieldType.Concealed,
                  value: secret,
                });

                const categoryEnum =
                  (category ?? "Login") === "Password"
                    ? sdk.ItemCategory.Password
                    : sdk.ItemCategory.Login;

                const item = await client.items.create({
                  title,
                  category: categoryEnum,
                  vaultId,
                  fields,
                  tags,
                  notes,
                  websites: url ? [{ url, label: "website", autofillBehavior: sdk.AutofillBehavior.AnywhereOnWebsite }] : undefined,
                });

                const response: Record<string, unknown> = {
                  id: item.id,
                  title: item.title,
                  vaultId: item.vaultId ?? vaultId,
                  category: item.category,
                };

                try {
                  const savedFields = Array.isArray(item.fields) ? item.fields.filter((field) => field?.id === "password") : [];
                  const reference = passwordReference(item, savedFields.length === 1 ? savedFields[0] : undefined);
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
                const safeError = passwordError("create");
                logError("password_create failed.", safeError);
                return errorResult(safeError);
              }
            });
}
