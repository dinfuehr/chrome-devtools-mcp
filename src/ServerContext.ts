/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
  HeapSnapshotManager,
  type HeapSnapshotAggregateData,
  type HeapSnapshotClassDiff,
  type HeapSnapshotDetailedClassDiff,
  type DuplicateStringGroup,
  type HeapEdgesQueryOptions,
  type HeapQueryOptions,
} from './processors/HeapSnapshotManager.js';
import type {DevTools, Root} from './third_party/index.js';
import type {BrowserlessContext} from './tools/ToolDefinition.js';
import {resolveCanonicalPath} from './utils/files.js';
import {escapeForLog} from './utils/logger.js';

export interface ServerContextOptions {
  // Whether to skip path validation when the client did not negotiate the roots
  // capability. When false (default), tools that read or write local files are
  // restricted to the OS temp directory. When true, the previous permissive
  // behavior is restored.
  allowUnrestrictedPaths?: boolean;
}

/**
 * State that lives as long as the MCP server and does not depend on a browser
 * connection: the workspace roots used for path validation and the loaded
 * heap snapshots. It survives browser reconnects and backs the tools that
 * do not need a browser at all.
 */
export class ServerContext implements BrowserlessContext {
  #heapSnapshotManager = new HeapSnapshotManager();
  #roots: Root[] | undefined = undefined;
  #allowUnrestrictedPaths: boolean;

  constructor(options: ServerContextOptions = {}) {
    this.#allowUnrestrictedPaths = options.allowUnrestrictedPaths ?? false;
  }

  dispose(): void {
    this.#heapSnapshotManager.dispose();
  }

  roots(): Root[] {
    return [
      ...(this.#roots ?? []),
      {
        uri: pathToFileURL(os.tmpdir()).href,
        name: 'temp',
      },
    ];
  }

  setRoots(roots: Root[] | undefined): void {
    this.#roots = roots;
  }

  /**
   * Validates that the filePath is allowed according to the roots configuration.
   * Tolerates if parts of the filePath do not exist yet but the file access to
   * the resolved should only be allowed without following symlinks.
   */
  async validatePath(filePath: string): Promise<string>;
  async validatePath(filePath?: undefined): Promise<undefined>;
  async validatePath(filePath?: string): Promise<string | undefined>;
  async validatePath(filePath?: string): Promise<string | undefined> {
    if (filePath === undefined) {
      return undefined;
    }

    let canonicalPath: string;

    try {
      canonicalPath = await resolveCanonicalPath(filePath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[MCP Context] Error resolving real path for ${escapeForLog(filePath)}: ${escapeForLog(errMsg)}`,
      );
      throw new Error(
        `Access denied: Cannot resolve base path for ${escapeForLog(filePath)}.`,
      );
    }

    // If the client never negotiated roots and the operator has explicitly
    // opted into unrestricted access via --allow-unrestricted-paths, restore
    // the previous permissive behavior and skip validation.
    if (this.#roots === undefined && this.#allowUnrestrictedPaths) {
      // Canonical path might not exist yet so we fallback to
      // path.resolve(filePath). Consumers should not follow symlinks.
      return canonicalPath || path.resolve(filePath);
    }
    // roots() always returns at least the temp directory, even if the
    // connecting client never negotiated the optional `roots` capability.
    // Path validation must not be skipped just because no workspace roots
    // were configured.
    const roots = this.roots();

    let allowed = false;
    const resolvedRoots = await Promise.allSettled(
      roots.map(async root => {
        const rootPathUri = root.uri;
        const rootPath = path.resolve(fileURLToPath(rootPathUri));
        return await fs.realpath(rootPath);
      }),
    );

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const result = resolvedRoots[i];

      if (result.status === 'fulfilled') {
        const canonicalRoot = result.value;
        if (
          canonicalPath === canonicalRoot ||
          canonicalPath.startsWith(canonicalRoot + path.sep)
        ) {
          allowed = true;
          break;
        }
      } else {
        const rootErr = result.reason;
        const errMsg =
          rootErr instanceof Error ? rootErr.message : String(rootErr);
        console.warn(
          `[MCP Context] Could not resolve configured root ${escapeForLog(root.uri)}: ${escapeForLog(errMsg)}`,
        );
        // Skip this root if it cannot be resolved.
      }
    }

    if (!allowed) {
      throw new Error(
        `Access denied: path ${escapeForLog(filePath)} (canonical: ${escapeForLog(canonicalPath)}) is not within any of the configured workspace roots.`,
      );
    }

    return canonicalPath || path.resolve(filePath);
  }

  async getHeapSnapshotAggregates(
    filePath: string,
    filterName?: string,
    objectId?: number,
  ): Promise<HeapSnapshotAggregateData> {
    return await this.#heapSnapshotManager.getAggregates(
      filePath,
      filterName,
      objectId,
    );
  }

  async getHeapSnapshotDuplicateStrings(
    filePath: string,
  ): Promise<DuplicateStringGroup[]> {
    return await this.#heapSnapshotManager.getDuplicateStrings(filePath);
  }

  async queryHeapSnapshotObjects(
    filePath: string,
    options: HeapQueryOptions,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.queryObjects(filePath, options);
  }

  async getHeapSnapshotStats(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.Statistics> {
    return await this.#heapSnapshotManager.getStats(filePath);
  }

  async getHeapSnapshotStaticData(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.StaticData | null> {
    return await this.#heapSnapshotManager.getStaticData(filePath);
  }

  async getHeapSnapshotNativeContextSizes(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.NativeContextSizes> {
    return await this.#heapSnapshotManager.getNativeContextSizes(filePath);
  }

  async getHeapSnapshotRetainedByContextSummary(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.RetainedByContextSummary> {
    return await this.#heapSnapshotManager.getRetainedByContextSummary(
      filePath,
    );
  }

  async getHeapSnapshotNodesById(
    filePath: string,
    id: number,
    filterName?: string,
    objectId?: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.getNodesById(
      filePath,
      id,
      filterName,
      objectId,
    );
  }

  async getHeapSnapshotRetainers(
    filePath: string,
    nodeId: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.getRetainers(filePath, nodeId);
  }

  async getHeapSnapshotObjectDetails(
    filePath: string,
    nodeId: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ObjectInfo> {
    return await this.#heapSnapshotManager.getObjectInfo(filePath, nodeId);
  }

  async analyzeHeapSnapshotContexts(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ContextAnalysisResult> {
    return await this.#heapSnapshotManager.analyzeContexts(filePath);
  }

  async closeHeapSnapshot(filePath: string): Promise<boolean> {
    return await this.#heapSnapshotManager.disposeSnapshot(filePath);
  }

  async getHeapSnapshotRetainingPaths(
    filePath: string,
    nodeId: number,
    maxDepth?: number,
    maxNodes?: number,
    maxSiblings?: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.RetainingPaths> {
    return await this.#heapSnapshotManager.getRetainingPaths(
      filePath,
      nodeId,
      maxDepth,
      maxNodes,
      maxSiblings,
    );
  }

  async getHeapSnapshotDominators(
    filePath: string,
    nodeId: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.DominatorChain> {
    return await this.#heapSnapshotManager.getDominatorsOf(filePath, nodeId);
  }

  async getHeapSnapshotEdges(
    filePath: string,
    nodeId: number,
    options?: HeapEdgesQueryOptions,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.getEdges(filePath, nodeId, options);
  }

  async getHeapSnapshotClassDiffs(
    baseFilePath: string,
    currentFilePath: string,
  ): Promise<HeapSnapshotClassDiff[]> {
    return await this.#heapSnapshotManager.getClassDiffs(
      baseFilePath,
      currentFilePath,
    );
  }

  async getHeapSnapshotDetailedClassDiff(
    baseFilePath: string,
    currentFilePath: string,
    classIndex: number,
  ): Promise<HeapSnapshotDetailedClassDiff> {
    return await this.#heapSnapshotManager.getDetailedClassDiff(
      baseFilePath,
      currentFilePath,
      classIndex,
    );
  }
}
