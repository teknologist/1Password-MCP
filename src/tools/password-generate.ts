/**
 * password_generate — Generate a cryptographically secure random password.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { randomOptions, randomPassword } from "../password-generation.js";
import { log, logError } from "../logger.js";
import {
  jsonResult,
  errorResult,
} from "../utils.js";

export function registerPasswordGenerate(server: McpServer): void {
  server.registerTool("password_generate", { description: "Generate a cryptographically secure random password with configurable length and character types. Uses rejection sampling for unbiased randomness.", inputSchema: randomOptions }, async ({
              length = 20,
              includeSymbols = true,
              includeNumbers = true,
              includeUppercase = true,
            }) => {
              try {
                log("debug", "Tool call: password_generate.", {
                  length,
                  includeSymbols,
                  includeNumbers,
                  includeUppercase,
                });

                const password = randomPassword({ length, includeUppercase, includeNumbers, includeSymbols });

                return jsonResult({ password });
              } catch (error) {
                logError("password_generate failed.", error);
                return errorResult(error);
              }
            });
}
