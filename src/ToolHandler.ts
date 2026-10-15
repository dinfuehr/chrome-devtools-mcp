/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParsedArguments} from './config/ConfigParser.js';
import type {McpContext} from './McpContext.js';
import type {McpPage} from './McpPage.js';
import {McpResponse, type DataFormat} from './McpResponse.js';
import type {ServerContext} from './ServerContext.js';
import {SlimMcpResponse} from './SlimMcpResponse.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import type {Browser, CallToolResult, Mutex} from './third_party/index.js';
import {zod} from './third_party/index.js';
import {labels} from './tools/categories.js';
import {categoryToFlagName} from './config/category-options.js';
import type {
  AnyToolDefinition,
  BrowserlessToolDefinition,
  DefinedPageTool,
  DevToolsData,
  FileVerificationOption,
  ToolDefinition,
} from './tools/ToolDefinition.js';
import {
  isAvailableInMode,
  isBrowserlessTool,
  isPageScopedTool,
  isSlimTool,
} from './tools/ToolDefinition.js';
import {logger} from './utils/logger.js';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isLocalhost} from './utils/url.js';

/**
 * Upper bound on how long a single tool call may wait on the browser
 * connection. Puppeteer normally rejects in-flight CDP calls when the
 * underlying transport closes, but a transport that dies silently (e.g. an
 * adb port-forward torn down mid-call, rather than closed cleanly) never
 * fires `close`/`error`/`disconnected`, so the call would otherwise hang
 * until an external (client-side) timeout gives up on the whole server. This
 * bound turns that into a fast, clear error instead, and forgets the cached
 * browser handle so the next call reconnects rather than reusing a handle
 * that still looks connected.
 */
export const TOOL_CALL_TIMEOUT_MS = 60_000;

class ToolCallTimeoutError extends Error {}

function buildDisabledMessage(
  toolName: string,
  flag: string,
  categoryLabel?: string,
): string {
  const reason = categoryLabel
    ? `is in category ${categoryLabel} which`
    : `requires ${flag.startsWith('--experimental') ? 'experimental feature' : 'flag'} ${flag} and`;

  return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}

function getToolStatusInfo(
  tool: AnyToolDefinition,
  serverArgs: ParsedArguments,
): {disabled: boolean; reason?: string; unavailableInMode?: boolean} {
  if (!isAvailableInMode(tool, serverArgs)) {
    return {
      disabled: true,
      unavailableInMode: true,
      reason: isSlimTool(tool)
        ? `Tool ${tool.name} is only available with --slim.`
        : `Tool ${tool.name} is not available with --slim.`,
    };
  }

  const category = tool.annotations.category;
  if (category) {
    const flag = categoryToFlagName(category);
    if (!serverArgs[flag]) {
      return {
        disabled: true,
        reason: buildDisabledMessage(tool.name, `--${flag}`, labels[category]),
      };
    }
  }

  for (const condition of tool.annotations.conditions || []) {
    if (!serverArgs[condition]) {
      return {
        disabled: true,
        reason: buildDisabledMessage(tool.name, `--${condition}`),
      };
    }
  }

  return {disabled: false};
}

interface PathValidator {
  validatePath(filePath: string): Promise<string>;
}

async function validateAndResolvePathOrUrl(
  filePathOrUrl: string,
  validator: PathValidator,
): Promise<string | undefined> {
  if (filePathOrUrl.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(filePathOrUrl);
    if (url.protocol === 'file:') {
      return pathToFileURL(await validator.validatePath(fileURLToPath(url)))
        .href;
    }
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      return filePathOrUrl;
    }
  } catch {
    // Suppress parsing errors for regular file paths.
  }
  return await validator.validatePath(filePathOrUrl);
}

function isLocalBrowser(context: McpContext): boolean {
  if (context.browser.process()) {
    return true;
  }
  const wsEndpoint = context.browser.wsEndpoint();
  if (wsEndpoint && isLocalhost(wsEndpoint)) {
    return true;
  }
  return false;
}

function shouldValidateFile(
  option: FileVerificationOption | undefined,
  isLocal: boolean,
): boolean {
  if (option === true) {
    return true;
  }
  if (typeof option === 'object' && option !== null) {
    if (isLocal) {
      return Boolean(option.local);
    }
    return Boolean(option.remote);
  }
  return false;
}

/**
 * `isLocal` tells whether files are accessed on the machine the server runs on,
 * which is always the case for browserless tools.
 */
async function validateToolFiles(
  tool: AnyToolDefinition,
  params: Record<string, unknown>,
  validator: PathValidator,
  isLocal: boolean,
): Promise<void> {
  for (const [key, option] of Object.entries(tool.verifyFilesSchema)) {
    if (shouldValidateFile(option, isLocal)) {
      const val = params[key];
      if (typeof val === 'string') {
        params[key] = await validateAndResolvePathOrUrl(val, validator);
      } else if (Array.isArray(val)) {
        const updated: unknown[] = [];
        for (const item of val) {
          if (typeof item === 'string') {
            const resolved = await validateAndResolvePathOrUrl(item, validator);
            if (resolved !== undefined) {
              updated.push(resolved);
            }
          } else {
            throw new Error(
              'Unexpected non-string value as a file path or URL',
            );
          }
        }
        params[key] = updated;
      }
    }
  }
}

export class ToolHandler {
  readonly inputSchema: zod.ZodRawShape;
  readonly registeredInputSchema: zod.ZodObject<
    zod.ZodRawShape,
    zod.core.$strict
  >;
  readonly disabled: boolean;
  private readonly disabledReason?: string;

  constructor(
    private readonly tool: AnyToolDefinition,
    private readonly serverArgs: ParsedArguments,
    private readonly getContext: () => Promise<McpContext>,
    private readonly getServerContext: () => Promise<ServerContext>,
    private readonly toolMutex: Mutex,
    private readonly forgetBrowserOnTimeout: (browser: Browser) => void,
    private readonly abandonPendingBrowserAttemptOnTimeout: () => void,
  ) {
    const {disabled, reason, unavailableInMode} = getToolStatusInfo(
      tool,
      serverArgs,
    );
    this.disabledReason = reason;
    this.disabled =
      disabled && (Boolean(unavailableInMode) || !serverArgs.viaCli);

    this.inputSchema = tool.schema;
    this.registeredInputSchema = zod.object(this.inputSchema).strict();
  }

  /**
   * Races a promise against TOOL_CALL_TIMEOUT_MS, calling onTimeout() if the
   * timer wins. The loser of the race is left running — there is no way to
   * cancel a pending Puppeteer call — but since nothing is left awaiting it,
   * it cannot block subsequent tool calls.
   */
  async #raceWithTimeout<T>(
    promise: Promise<T>,
    onTimeout: () => void,
  ): Promise<T> {
    const timeoutError = new ToolCallTimeoutError(
      `Tool "${this.tool.name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms waiting on the browser connection. The connection may have been lost (for example, the debugged browser or app restarted). It will be re-established automatically on the next tool call.`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), TOOL_CALL_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch (err) {
      if (err === timeoutError) {
        onTimeout();
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  #dataFormat(): DataFormat {
    // --experimentalDataFormat takes precedence over the legacy
    // --experimentalToonFormat.
    return (
      this.serverArgs.experimentalDataFormat ??
      (this.serverArgs.experimentalToonFormat ? 'toon' : 'default')
    );
  }

  /**
   * Browserless tools never wait on the browser connection, so they neither
   * establish one nor run under TOOL_CALL_TIMEOUT_MS, which exists to detect
   * dead browser connections and would otherwise also cut off long-running
   * local work such as parsing a large heap snapshot.
   */
  async #runBrowserlessTool(
    tool: BrowserlessToolDefinition,
    params: Record<string, unknown>,
    response: McpResponse,
  ): ReturnType<McpResponse['handle']> {
    const serverContext = await this.getServerContext();
    try {
      await validateToolFiles(tool, params, serverContext, true);
      await tool.handler({params}, response, serverContext);
    } catch (err) {
      response.setError(err);
    }
    return await response.handle(undefined, this.#dataFormat());
  }

  async #runBrowserTool(
    tool: ToolDefinition | DefinedPageTool,
    params: Record<string, unknown>,
    response: McpResponse,
    onTelemetryData: (
      devToolsData: DevToolsData | undefined,
      pageUrl: string | undefined,
    ) => void,
  ): ReturnType<McpResponse['handle']> {
    // ensureBrowser() has no cancellation mechanism, so this timeout only
    // stops us from waiting — the attempt itself keeps running abandoned.
    // abandonPendingBrowserAttemptOnTimeout() tells BrowserManager to
    // discard that attempt if it succeeds later instead of handing it to a
    // subsequent caller — see BrowserManager#abandonPendingAttempt()'s doc
    // comment for the full mechanism.
    const context = await this.#raceWithTimeout(this.getContext(), () =>
      this.abandonPendingBrowserAttemptOnTimeout(),
    );
    logger?.(`${tool.name} context: resolved`);
    if (context.consumeReconnectNotice()) {
      response.setReconnectNotice();
    }
    // Shares one budget with tool.handler(): several tools' actual CDP
    // calls happen in response.handle() instead (take_snapshot,
    // list_pages, get_network_request, list_extensions), so it needs
    // covering too. The closure below isn't cancelled on timeout — it
    // keeps running abandoned — but nothing after this point observes its
    // result.
    return await this.#raceWithTimeout(
      (async () => {
        let page: McpPage | undefined;
        try {
          await validateToolFiles(
            tool,
            params,
            context,
            isLocalBrowser(context),
          );
          if (isPageScopedTool(tool)) {
            const pageId =
              typeof params.pageId === 'number' ? params.pageId : undefined;
            page =
              this.serverArgs.pageIdRouting &&
              pageId !== undefined &&
              !isSlimTool(tool)
                ? context.getPageById(pageId)
                : context.getSelectedMcpPage();
            await page?.init();
            response.setPage(page);
            if (tool.blockedByDialog) {
              page.throwIfDialogOpen();
            }
            await tool.handler(
              {
                params,
                page,
              },
              response,
              context,
            );
          } else {
            await tool.handler(
              {
                params,
              },
              response,
              context,
            );
          }
        } catch (err) {
          response.setError(err);
        }
        onTelemetryData(
          await context.getDevToolsData(page),
          context.getSelectedMcpPageUrl(page),
        );
        return await response.handle(context, this.#dataFormat());
      })(),
      () => this.forgetBrowserOnTimeout(context.browser),
    );
  }

  handle = async (params: Record<string, unknown>): Promise<CallToolResult> => {
    using guard = await this.toolMutex.acquire();

    if (this.disabledReason) {
      return {
        content: [
          {
            type: 'text',
            text: this.disabledReason,
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();
    let success = false;
    let devToolsData: DevToolsData | undefined;
    let pageUrl: string | undefined;
    try {
      logger?.(
        `${this.tool.name} request: ${JSON.stringify(params, null, '  ')}`,
      );
      const response = this.serverArgs.slim
        ? new SlimMcpResponse(this.serverArgs)
        : new McpResponse(this.serverArgs);
      response.setRedactNetworkHeaders(this.serverArgs.redactNetworkHeaders);

      const {content, structuredContent} = isBrowserlessTool(this.tool)
        ? await this.#runBrowserlessTool(this.tool, params, response)
        : await this.#runBrowserTool(
            this.tool,
            params,
            response,
            (data, url) => {
              devToolsData = data;
              pageUrl = url;
            },
          );
      const result: CallToolResult & {
        structuredContent?: Record<string, unknown>;
      } = {
        content,
      };
      if (response.error) {
        result.isError = true;
      }
      success = true;
      if (this.serverArgs.experimentalStructuredContent) {
        result.structuredContent = structuredContent as Record<string, unknown>;
      }
      return result;
    } catch (err) {
      logger?.(`${this.tool.name} error:`, err, err?.stack);
      let errorText = err && 'message' in err ? err.message : String(err);
      if ('cause' in err && err.cause) {
        errorText += `\nCause: ${err.cause.message}`;
      }
      return {
        content: [
          {
            type: 'text',
            text: errorText,
          },
        ],
        isError: true,
      };
    } finally {
      void ClearcutLogger.get()?.logToolInvocation({
        toolName: this.tool.name,
        params,
        schema: this.inputSchema,
        success,
        latencyMs: Date.now() - startTime,
        devToolsData,
        pageUrl,
      });
    }
  };
}
