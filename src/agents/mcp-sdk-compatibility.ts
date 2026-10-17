import { isDeepStrictEqual } from "node:util";
import type {
  CallToolResult,
  GetPromptResult,
  ListResourceTemplatesResult,
  ListToolsResult,
} from "@modelcontextprotocol/client";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

/** The published plugin SDK retains its v1 result shapes for one release window. */
export class McpSdkCompatibilityError extends Error {
  readonly code = "MCP_SDK_RESULT_UNREPRESENTABLE";

  constructor(readonly method: string) {
    super(`MCP ${method} result cannot be represented losslessly by the current plugin SDK`);
    this.name = "McpSdkCompatibilityError";
  }
}

function legacyResult<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  // A successful parse can still strip fields in nested v1 schemas.
  if (!parsed.success || !isDeepStrictEqual(value, parsed.data)) {
    throw new McpSdkCompatibilityError(method);
  }
  return parsed.data;
}

export function toLegacyMcpCallToolResult(value: CallToolResult) {
  return legacyResult("tools/call", CallToolResultSchema, value);
}

export function toLegacyMcpListToolsResult(value: ListToolsResult) {
  return legacyResult("tools/list", ListToolsResultSchema, value);
}

export function toLegacyMcpListResourceTemplatesResult(value: ListResourceTemplatesResult) {
  return legacyResult("resources/templates/list", ListResourceTemplatesResultSchema, value);
}

export function toLegacyMcpGetPromptResult(value: GetPromptResult) {
  return legacyResult("prompts/get", GetPromptResultSchema, value);
}
