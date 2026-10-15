/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {overrideDevToolsGlobals} from './devtools/DevtoolsUtils.js';
import {McpPage} from './McpPage.js';
import {type UncaughtError} from './collectors/PageCollector.js';
import {ServiceWorkerConsoleCollector} from './collectors/ServiceWorkerCollector.js';
import {
  Locator,
  type Browser,
  type BrowserContext,
  type Connection,
  type ConsoleMessage,
  type GetPWAStateOptions,
  type InstallPWAOptions,
  type LaunchPWAOptions,
  type Page,
  type Protocol,
  type PWAState,
  type Target,
  type UninstallPWAOptions,
  type Extension,
  type Root,
} from './third_party/index.js';
import type {ServerContext} from './ServerContext.js';
import {CLOSE_PAGE_ERROR} from './tools/ToolDefinition.js';
import type {
  Context,
  DevToolsData,
  SupportedExtensions,
} from './tools/ToolDefinition.js';
import type {TraceResult} from './processors/PerformanceTrace.js';
import type {Logger} from './types.js';
import {McpWorker} from './McpWorker.js';
import {getTempFilePath} from './utils/files.js';
import {escapeForLog} from './utils/logger.js';
import {isAllowedUrl} from './utils/url.js';
interface McpContextOptions {
  // Whether the DevTools windows are exposed as pages for debugging of DevTools.
  experimentalDevToolsDebugging: boolean;
  // Whether all page-like targets are exposed as pages.
  experimentalIncludeAllPages?: boolean;
  // Whether CrUX data should be fetched.
  performanceCrux: boolean;
  // Whether source maps are enabled in DevTools.
  sourceMaps?: boolean;
  // The allow list of URL patterns to allow loading resources.
  allowlist?: string[];
  // The block list of URL patterns to block loading resources.
  blocklist?: string[];
  // Whether this context replaces a previous one after a browser reconnect.
  // Surfaces a one-time note in the next response.
  reconnected?: boolean;
  // Custom navigation timeout in milliseconds to override default.
  navigationTimeout?: number;
  // Whether extension tools and targets are enabled.
  categoryExtensions?: boolean;
  // Callback when a notification should be emitted to MCP client.
  onNotification?: (message: string) => void;
  // Browser-independent server state (roots, heap snapshots) that is preserved
  // across browser reconnects.
  serverContext: ServerContext;
}

// Page ids are handed out from a process-wide counter so they stay unique
// across all contexts, in particular across browser reconnects. An id issued
// before a reconnect then fails to resolve instead of hitting an unrelated
// page of the reconnected browser.
let nextPageId = 1;

export class McpContext implements Context {
  browser: Browser;
  logger: Logger;

  // Maps LLM-provided isolatedContext name → Puppeteer BrowserContext.
  #isolatedContexts = new Map<string, BrowserContext>();
  // Auto-generated name counter for when no name is provided.
  #nextIsolatedContextId = 1;

  // Cached McpWorker per target, reused across snapshots (mirrors #mcpPages) so
  // referential identity holds and workers can carry per-worker state later.
  #workers = new Map<Target, McpWorker>();

  #mcpPages = new Map<Target, McpPage>();
  #selectedPage?: McpPage;
  #selectedPageFallback?: {wasClosed: boolean};

  #serviceWorkerConsoleCollector: ServiceWorkerConsoleCollector;

  #isRunningTrace = false;

  #reconnectNotice = false;

  #traceResults: TraceResult[] = [];

  #locatorClass: typeof Locator;
  #options: McpContextOptions;
  #serverContext: ServerContext;

  private constructor(
    browser: Browser,
    logger: Logger,
    options: McpContextOptions,
    locatorClass: typeof Locator,
  ) {
    overrideDevToolsGlobals({
      loadResource: (url: string) => {
        return this.loadResource(url);
      },
    });

    this.browser = browser;
    this.logger = logger;
    this.#locatorClass = locatorClass;
    this.#options = options;
    this.#serverContext = options.serverContext;
    this.#reconnectNotice = options.reconnected ?? false;

    this.#serviceWorkerConsoleCollector = new ServiceWorkerConsoleCollector(
      this.browser,
    );
  }

  async #init(): Promise<void> {
    await this.createPagesSnapshot();
    const workers = this.createWorkersSnapshot();

    await this.#serviceWorkerConsoleCollector.init(workers);
    this.browser.on('targetcreated', this.#onTargetCreated);
    this.browser.on('targetdestroyed', this.#onTargetDestroyed);
  }

  dispose(): void {
    this.browser.off('targetcreated', this.#onTargetCreated);
    this.browser.off('targetdestroyed', this.#onTargetDestroyed);

    this.#serviceWorkerConsoleCollector.dispose();
    for (const mcpPage of this.#mcpPages.values()) {
      mcpPage.dispose();
    }
    this.#selectedPage?.dispose();
    this.#mcpPages.clear();
    this.#workers.clear();
    // Isolated contexts are intentionally not closed here.
    // Either the entire browser will be closed or we disconnect
    // without destroying browser state.
    this.#isolatedContexts.clear();
  }

  #onTargetCreated = (target: Target): void => {
    try {
      if (!this.#isPageTarget(target)) {
        return;
      }
      this.#createMcpPage(target);
    } catch (err) {
      this.logger?.('Error handling targetcreated', err);
    }
  };

  #onTargetDestroyed = (target: Target): void => {
    try {
      const mcpPage = this.#mcpPages.get(target);
      if (mcpPage) {
        mcpPage.dispose();
        this.#mcpPages.delete(target);
      }
      this.#workers.delete(target);
    } catch (err) {
      this.logger?.('Error handling targetdestroyed', err);
    }
  };

  static async from(
    browser: Browser,
    logger: Logger,
    opts: McpContextOptions,
    /* Let tests use unbundled Locator class to avoid overly strict checks within puppeteer that fail when mixing bundled and unbundled class instances */
    locatorClass: typeof Locator = Locator,
  ): Promise<McpContext> {
    const context = new McpContext(browser, logger, opts, locatorClass);
    await context.#init();
    return context;
  }

  static resetPageIdsForTesting(): void {
    nextPageId = 1;
  }

  static resetWorkerIdsForTesting(): void {
    McpWorker.resetIdsForTesting();
  }

  roots(): Root[] {
    return this.#serverContext.roots();
  }

  setRoots(roots: Root[] | undefined): void {
    this.#serverContext.setRoots(roots);
  }

  /**
   * Validates that the filePath is allowed according to the roots
   * configuration. See {@link ServerContext.validatePath}.
   */
  async validatePath(filePath: string): Promise<string>;
  async validatePath(filePath?: undefined): Promise<undefined>;
  async validatePath(filePath?: string): Promise<string | undefined>;
  async validatePath(filePath?: string): Promise<string | undefined> {
    return await this.#serverContext.validatePath(filePath);
  }

  async ensureExtension<Extension extends `.${string}`>(
    filePath: string,
    extension: Extension,
  ): Promise<`${string}${Extension}`> {
    const resolved = await this.validatePath(filePath);
    const currentExtension = path.extname(resolved);
    const outputPath: `${string}${Extension}` = `${resolved.slice(
      0,
      resolved.length - currentExtension.length,
    )}${extension}`;
    return outputPath;
  }

  async newPage(
    background?: boolean,
    isolatedContextName?: string,
  ): Promise<McpPage> {
    let page: Page;
    if (isolatedContextName !== undefined) {
      let ctx = this.#isolatedContexts.get(isolatedContextName);
      if (!ctx) {
        ctx = await this.browser.createBrowserContext();
        this.#isolatedContexts.set(isolatedContextName, ctx);
      }
      page = await ctx.newPage({background});
    } else {
      page = await this.browser.newPage({background});
    }
    const mcpPage = this.#createMcpPage(page.target());
    await mcpPage.init();
    this.selectPage(mcpPage);
    await this.createPagesSnapshot();
    return mcpPage;
  }
  async closePage(pageId: number): Promise<void> {
    const page = this.getPageById(pageId);
    if (this.#mcpPages.size === 1) {
      throw new Error(CLOSE_PAGE_ERROR);
    }
    this.#mcpPages.delete(page.target);
    await page.close();
  }

  get #hasNetworkBlockOrAllowlist(): boolean {
    return !!(this.#options.allowlist || this.#options.blocklist);
  }

  async installPWA(options: InstallPWAOptions): Promise<string> {
    try {
      return await this.browser.installPWA(options);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Couldn't fetch install info")
      ) {
        return await this.browser.installPWA(options);
      }
      throw error;
    }
  }

  uninstallPWA(options: UninstallPWAOptions): Promise<void> {
    return this.browser.uninstallPWA(options);
  }

  async launchPWA(options: LaunchPWAOptions): Promise<Page> {
    const page = await this.browser.launchPWA(options);
    if (!page.url() || page.url() === 'about:blank') {
      await page
        .waitForNavigation({
          timeout: this.#options.navigationTimeout ?? 10_000,
        })
        .catch(() => {
          // Ignore timeout if navigation already completed or failed.
        });
    }
    return page;
  }

  getPWAState(options: GetPWAStateOptions): Promise<PWAState> {
    return this.browser.getPWAState(options);
  }

  setIsRunningPerformanceTrace(x: boolean): void {
    this.#isRunningTrace = x;
  }

  isRunningPerformanceTrace(): boolean {
    return this.#isRunningTrace;
  }

  isCruxEnabled(): boolean {
    return this.#options.performanceCrux;
  }

  getPages(): McpPage[] {
    return Array.from(this.#mcpPages.values());
  }

  /**
   * Fetches current target info for all targets from the browser, keyed by
   * target id. Unlike Puppeteer's cached target info, this reflects title
   * changes, which Chrome does not report via `Target.targetInfoChanged`.
   * Returns an empty map if the browser cannot be queried.
   */
  async getTargetInfos(): Promise<Map<string, Protocol.Target.TargetInfo>> {
    try {
      // @ts-expect-error use existing browser connection (internal Puppeteer API).
      const connection: Connection = this.browser._connection;
      const {targetInfos} = await connection.send('Target.getTargets');
      return new Map(targetInfos.map(info => [info.targetId, info]));
    } catch (err) {
      this.logger?.('Failed to fetch target infos', err);
      return new Map();
    }
  }

  getSelectedMcpPage(): McpPage {
    const page = this.#selectedPage;
    if (!page) {
      throw new Error('No page selected');
    }
    if (page.isClosed()) {
      throw new Error(
        'The selected page has been closed. Call list_pages to see open pages.',
      );
    }
    return page;
  }

  getSelectedMcpPageUrl(page?: McpPage): string | undefined {
    let targetPage = page;
    if (!targetPage) {
      try {
        targetPage = this.getSelectedMcpPage();
      } catch {
        return undefined;
      }
    }
    if (targetPage && !targetPage.isClosed()) {
      return targetPage.url();
    }
    return undefined;
  }

  async getDevToolsData(page?: McpPage): Promise<DevToolsData | undefined> {
    const targetPage = page ?? this.#selectedPage;
    if (!targetPage) {
      return undefined;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>(resolve => {
      timeoutId = setTimeout(() => resolve(undefined), 500);
    });
    const dataPromise = targetPage.getDevToolsData();
    try {
      return await Promise.race([dataPromise, timeoutPromise]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Returns true once if this context was created by reconnecting after the
   * previous browser connection was lost, so the next response can surface a
   * note. Cleared on first call.
   */
  consumeReconnectNotice(): boolean {
    const notice = this.#reconnectNotice;
    this.#reconnectNotice = false;
    return notice;
  }

  getPageById(pageId: number): McpPage {
    const page = this.#mcpPages.values().find(mcpPage => mcpPage.id === pageId);
    if (!page) {
      throw new Error('No page found');
    }
    return page;
  }

  isPageSelected(page: McpPage): boolean {
    return this.#selectedPage === page;
  }

  selectPage(newPage: McpPage): void {
    if (
      this.#selectedPage &&
      this.#selectedPage !== newPage &&
      !this.#mcpPages.has(this.#selectedPage.target)
    ) {
      this.#selectedPage.dispose();
    }
    this.#selectedPage = newPage;
    newPage.updateTimeouts();
  }

  /**
   * Returns details about the last page snapshot automatically replacing the
   * selection because the selected page disappeared from the page list, or
   * `undefined` if the snapshot left the selection intact. Recomputed on every
   * createPagesSnapshot() call.
   */
  getSelectedPageFallback(): {wasClosed: boolean} | undefined {
    return this.#selectedPageFallback;
  }

  /**
   * Creates a snapshot of the tracked workers. Today this is limited to
   * extension service workers; the McpWorker abstraction lets dedicated and
   * shared workers join the same snapshot later without changing consumers.
   */
  createWorkersSnapshot(): McpWorker[] {
    const serviceWorkers = this.browser.targets().filter(target => {
      return (
        target.type() === 'service_worker' &&
        target.url().includes('chrome-extension://')
      );
    });

    // Reuse the existing McpWorker for a target; only mint one (and an id) for
    // targets seen for the first time.
    for (const target of serviceWorkers) {
      if (!this.#workers.has(target)) {
        this.#workers.set(target, McpWorker.create('service_worker', target));
      }
    }

    // Prune workers whose target is gone (mirrors #mcpPages pruning).
    const currentTargets = new Set(serviceWorkers);
    for (const target of this.#workers.keys()) {
      if (!currentTargets.has(target)) {
        this.#workers.delete(target);
      }
    }

    return Array.from(this.#workers.values());
  }

  getServiceWorkerConsoleData(
    extensionId: string,
  ): Array<ConsoleMessage | UncaughtError> {
    return this.#serviceWorkerConsoleCollector.getData(extensionId);
  }

  #getBrowserContextToNameMap(): Map<BrowserContext, string> {
    // Build a reverse lookup from BrowserContext instance → name.
    const contextToName = new Map<BrowserContext, string>();
    for (const [name, ctx] of this.#isolatedContexts) {
      contextToName.set(ctx, name);
    }
    const defaultCtx = this.browser.defaultBrowserContext();
    // Auto-discover BrowserContexts not in our mapping (e.g., externally
    // created incognito contexts) and assign generated names.
    const knownContexts = new Set(this.#isolatedContexts.values());
    for (const ctx of this.browser.browserContexts()) {
      if (ctx !== defaultCtx && !ctx.closed && !knownContexts.has(ctx)) {
        const name = `isolated-context-${this.#nextIsolatedContextId++}`;
        this.#isolatedContexts.set(name, ctx);
        contextToName.set(ctx, name);
      }
    }
    return contextToName;
  }

  #createMcpPage(target: Target): McpPage {
    let mcpPage =
      this.#mcpPages.get(target) ??
      (this.#selectedPage?.target === target ? this.#selectedPage : undefined);
    if (!mcpPage) {
      mcpPage = new McpPage(target, nextPageId++, {
        locatorClass: this.#locatorClass,
        hasNetworkBlockOrAllowlist: this.#hasNetworkBlockOrAllowlist,
        isolatedContextName: this.#getBrowserContextToNameMap().get(
          target.browserContext(),
        ),
        navigationTimeout: this.#options.navigationTimeout,
        sourceMaps: this.#options.sourceMaps,
        onNotification: this.#options.onNotification,
      });
    }
    this.#mcpPages.set(target, mcpPage);
    return mcpPage;
  }

  async createPagesSnapshot(): Promise<McpPage[]> {
    const allTargets = this.#fetchPageTargets();

    for (const target of allTargets) {
      this.#createMcpPage(target);
    }

    // Prune orphaned #mcpPages entries (targets that no longer exist).
    const currentTargets = new Set(allTargets);
    for (const [target, mcpPage] of this.#mcpPages) {
      if (!currentTargets.has(target)) {
        if (mcpPage !== this.#selectedPage || mcpPage.isClosed()) {
          mcpPage.dispose();
        }
        this.#mcpPages.delete(target);
      }
    }

    const pages = Array.from(this.#mcpPages.values());

    // Only fall back when the selected page is actually gone. Gating on
    // `isClosed()` instead of `pages` membership avoids silently swapping a
    // live page that is momentarily missing from the snapshot.
    this.#selectedPageFallback = undefined;
    if ((!this.#selectedPage || this.#selectedPage.isClosed()) && pages[0]) {
      // Record the automatic change so the response can surface it. Skipped on
      // first connect, when there was no prior selection to replace.
      if (this.#selectedPage) {
        this.#selectedPageFallback = {
          wasClosed: this.#selectedPage.isClosed(),
        };
      }
      this.selectPage(pages[0]);
    }

    if (this.#selectedPage && !this.#selectedPage.isClosed()) {
      await this.#selectedPage.init();
    }

    return pages;
  }

  #isPageTarget(target: Target): boolean {
    const existingMcpPage = this.#mcpPages.get(target);
    const url = existingMcpPage ? existingMcpPage.url() : target.url();
    if (
      !this.#options.experimentalDevToolsDebugging &&
      url.startsWith('devtools://')
    ) {
      return false;
    }
    if (
      !isAllowedUrl(url, {
        categoryExtensions: this.#options.categoryExtensions,
      })
    ) {
      return false;
    }
    const type = target.type();
    if (type === 'page') {
      return true;
    }
    if (
      this.#options.experimentalIncludeAllPages &&
      (type === 'background_page' || type === 'webview')
    ) {
      return true;
    }
    if (
      this.#options.experimentalDevToolsDebugging &&
      type === 'other' &&
      url.startsWith('devtools://')
    ) {
      return true;
    }
    return false;
  }

  #fetchPageTargets(): Target[] {
    return this.browser.targets().filter(target => this.#isPageTarget(target));
  }

  getWorkers(): McpWorker[] {
    return Array.from(this.#workers.values());
  }

  getWorkerById(id: string): McpWorker | undefined {
    return this.#workers.values().find(worker => worker.id === id);
  }

  async #writeFile(
    filepath: string,
    data: Uint8Array<ArrayBufferLike>,
  ): Promise<void> {
    const resolved = await this.validatePath(filepath);

    try {
      await fs.mkdir(path.dirname(resolved), {recursive: true});
      // Open the file with flags to:
      // - O_WRONLY: Write-only
      // - O_CREAT: Create if it doesn't exist
      // - O_TRUNC: Truncate to zero length if it exists
      // - O_NOFOLLOW: DO NOT follow symlinks.
      // - 0o600: Permissions: read/write for owner, no permissions for others.
      await fs.writeFile(resolved, data, {
        flag:
          fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_NOFOLLOW,
        mode: 0o600,
      });
    } catch (err) {
      throw new Error(`Could not write ${escapeForLog(filepath)}`, {
        cause: err,
      });
    }
  }

  async saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filepath: string}> {
    const filepath = await getTempFilePath(filename);
    await this.#writeFile(filepath, data);
    return {filepath};
  }

  async saveFile(
    data: Uint8Array<ArrayBufferLike>,
    clientProvidedFilePath: string,
    extension: SupportedExtensions,
  ): Promise<{filename: string}> {
    const filePath = await this.ensureExtension(
      clientProvidedFilePath,
      extension,
    );
    await this.#writeFile(filePath, data);
    return {filename: filePath};
  }

  storeTraceRecording(result: TraceResult): void {
    // Clear the trace results because we only consume the latest trace currently.
    this.#traceResults = [];
    this.#traceResults.push(result);
  }

  recordedTraces(): TraceResult[] {
    return this.#traceResults;
  }

  async installExtension(extensionPath: string): Promise<string> {
    const id = await Promise.race([
      this.browser.installExtension(extensionPath),
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error('Timeout installing extension')), 30000),
      ),
    ]);
    return id;
  }

  async uninstallExtension(id: string): Promise<void> {
    await Promise.race([
      this.browser.uninstallExtension(id),
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error('Timeout uninstalling extension')),
          30000,
        ),
      ),
    ]);
  }

  async triggerExtensionAction(id: string): Promise<void> {
    const extensions = await this.browser.extensions();
    const extension = extensions.get(id);
    if (!extension) {
      throw new Error(`Extension with ID ${id} not found.`);
    }
    const page = this.getSelectedMcpPage().pptrPage;
    await extension.triggerAction(page);
  }

  listExtensions(): Promise<Map<string, Extension>> {
    return this.browser.extensions();
  }

  async getExtension(id: string): Promise<Extension | undefined> {
    const pptrExtensions = await this.browser.extensions();
    return pptrExtensions.get(id);
  }

  #validateUrlNotBlocked(url: URL): void {
    if (!this.#options.blocklist) {
      return;
    }
    for (const block of this.#options.blocklist) {
      const pattern = new URLPattern(block);
      if (pattern.test(url)) {
        throw new Error(`Blocked by blocklist: ${url}`);
      }
    }
  }

  #validateUrlAllowed(url: URL): void {
    if (!this.#options.allowlist) {
      return;
    }
    for (const allow of this.#options.allowlist) {
      const pattern = new URLPattern(allow);
      if (pattern.test(url)) {
        return;
      }
    }
    throw new Error(`Not allowed by allowlist: ${url}`);
  }

  async #loadNetworkResource(url: URL): Promise<string> {
    const redirectStatuses = new Set([301, 302, 303, 307, 308]);
    const maxRedirects = 20;
    let currentUrl = url;

    for (let redirectCount = 0; ; redirectCount++) {
      this.#validateUrlNotBlocked(currentUrl);
      this.#validateUrlAllowed(currentUrl);

      const response = await fetch(currentUrl, {redirect: 'manual'});
      if (!redirectStatuses.has(response.status)) {
        if (!response.ok) {
          throw new Error(`Failed to load resource: ${currentUrl}`);
        }
        return await response.text();
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Failed to load resource: ${currentUrl}`);
      }
      if (redirectCount >= maxRedirects) {
        throw new Error(`Too many redirects loading resource: ${url}`);
      }

      await response.body?.cancel();
      currentUrl = new URL(location, currentUrl);
      if (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:') {
        throw new Error(`Unsupported protocol for: ${currentUrl}`);
      }
    }
  }

  async loadResource(path: string): Promise<string> {
    const url = new URL(path);

    this.#validateUrlNotBlocked(url);

    switch (url.protocol) {
      case 'https:':
      case 'http:': {
        return await this.#loadNetworkResource(url);
      }

      case 'file:': {
        const resolved = await this.validatePath(fileURLToPath(url));
        return await fs.readFile(resolved, 'utf-8');
      }

      default:
        throw new Error(`Unsupported protocol for: ${url}`);
    }
  }
}
