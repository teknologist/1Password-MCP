/**
 * password_generate_memorable — Generate a memorable passphrase from random words.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { log, logError } from "../logger.js";
import {
  jsonResult,
  errorResult,
} from "../utils.js";
import { memorableOptions, memorablePasswordResult } from "../password-generation.js";

export function registerPasswordGenerateMemorable(server: McpServer): void {
  server.registerTool("password_generate_memorable", { description: "Generate a memorable passphrase from 402 distinct words. Defaults to seven words and random number/symbol suffixes (about 70.2 bits with distinct word boundaries). Fixed capitalization and separators add no entropy.", inputSchema: memorableOptions }, async ({
              wordCount = 7,
              separator = "-",
              includeNumber = true,
              includeSymbol = true,
              capitalize = true,
            }) => {
              try {
                log("debug", "Tool call: password_generate_memorable.", {
                  wordCount,
                  separator,
                  includeNumber,
                  includeSymbol,
                  capitalize,
                });

                const result = memorablePasswordResult({
                  wordCount,
                  separator,
                  includeNumber,
                  includeSymbol,
                  capitalize,
                });

                return jsonResult(result);
              } catch (error) {
                logError("password_generate_memorable failed.", error);
                return errorResult(error);
              }
            });
}
