/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  type ContextAnalysisReport,
  HeapSnapshotFormatter,
} from '../../src/formatters/HeapSnapshotFormatter.js';
import {DevTools} from '../../src/third_party/index.js';
import {stableIdSymbol} from '../../src/utils/id.js';

const {formatBytesToKb} = DevTools.I18n.ByteUtilities;

describe('HeapSnapshotFormatter', () => {
  DevTools.I18n.DevToolsLocale.DevToolsLocale.instance({
    create: true,
    data: {
      navigatorLanguage: 'en-US',
      settingLanguage: 'en-US',
      lookupClosestDevToolsLocale: l => l,
    },
  });
  DevTools.I18n.i18n.registerLocaleDataForTest('en-US', {});
  const mockAggregates: Record<
    string,
    DevTools.HeapSnapshotModel.HeapSnapshotModel.AggregatedInfo
  > = {
    ObjectA: {
      name: 'ObjectA',
      count: 10,
      self: 100,
      maxRet: 1000,
      distance: 1,
      idxs: [],
      [stableIdSymbol]: 1,
    } as unknown as DevTools.HeapSnapshotModel.HeapSnapshotModel.AggregatedInfo,
    ObjectB: {
      name: 'ObjectB',
      count: 5,
      self: 50,
      maxRet: 500,
      distance: 2,
      idxs: [],
      [stableIdSymbol]: 2,
    } as unknown as DevTools.HeapSnapshotModel.HeapSnapshotModel.AggregatedInfo,
  };

  describe('toString', () => {
    it('formats data as CSV and sorts by retained size', t => {
      const formatter = new HeapSnapshotFormatter(mockAggregates);
      const result = formatter.toString();
      t.assert.snapshot(result);
    });
  });

  describe('toJSON', () => {
    it('returns structured data sorted by retained size', () => {
      const formatter = new HeapSnapshotFormatter(mockAggregates);
      const result = formatter.toJSON();
      assert.deepStrictEqual(result, [
        {
          id: 1,
          className: 'ObjectA',
          count: 10,
          selfSize: formatBytesToKb(100),
          retainedSize: formatBytesToKb(1000),
        },
        {
          id: 2,
          className: 'ObjectB',
          count: 5,
          selfSize: formatBytesToKb(50),
          retainedSize: formatBytesToKb(500),
        },
      ]);
    });
  });

  describe('formatNodes', () => {
    it('formats edges correctly', () => {
      const mockEdges = [
        {
          name: 'edge1',
          type: 'property',
          edgeIndex: 0,
          isAddedNotRemoved: null,
          node: {
            id: 1,
            name: 'NodeA',
            distance: 0,
            nodeIndex: 0,
            retainedSize: 0,
            selfSize: 0,
            type: 'object',
            canBeQueried: false,
            detachedDOMTreeNode: false,
            ignored: false,
            isAddedNotRemoved: null,
          },
        },
        {
          name: 'edge2',
          type: 'element',
          edgeIndex: 1,
          isAddedNotRemoved: null,
          node: {
            id: 2,
            name: 'NodeB',
            distance: 0,
            nodeIndex: 0,
            retainedSize: 0,
            selfSize: 0,
            type: 'object',
            canBeQueried: false,
            detachedDOMTreeNode: false,
            ignored: false,
            isAddedNotRemoved: null,
          },
        },
      ];

      const result = HeapSnapshotFormatter.formatNodes(mockEdges);
      const expected = [
        'name,type,nodeId,nodeName,selfSize,retainedSize',
        'edge1,property,1,NodeA,0.0 kB,0.0 kB',
        'edge2,element,2,NodeB,0.0 kB,0.0 kB',
      ].join('\n');

      assert.strictEqual(result, expected);
    });
  });

  describe('formatDiffSummary', () => {
    it('includes classes with balanced added and removed objects', () => {
      const summarized = [
        {
          className: 'Balanced',
          addedCount: 1,
          removedCount: 1,
          countDelta: 0,
          addedSize: 100,
          removedSize: 100,
          sizeDelta: 0,
        },
      ];
      const result = HeapSnapshotFormatter.formatDiffSummary(summarized);
      const expected = [
        'index,className,addedCount,removedCount,countDelta,addedSize,removedSize,sizeDelta',
        `0,Balanced,1,1,0,${formatBytesToKb(100)},${formatBytesToKb(100)},${formatBytesToKb(0)}`,
      ].join('\n');

      assert.strictEqual(result, expected);

      const summarizedJson = JSON.stringify(summarized);
      assert.ok(summarizedJson);
      assert.equal(summarizedJson.includes('addedIndexes'), false);
      assert.equal(summarizedJson.includes('deletedIndexes'), false);
    });
  });

  describe('formatDiffDetails', () => {
    it('formats detailed diffs correctly', () => {
      const details = {
        className: 'MyClass',
        addedCount: 2,
        removedCount: 1,
        countDelta: 1,
        addedSize: 120,
        removedSize: 60,
        sizeDelta: 60,
        addedIds: [101, 102],
        addedSelfSizes: [60, 60],
        deletedIds: [201],
        deletedSelfSizes: [60],
      };

      const formatted = HeapSnapshotFormatter.formatDiffDetails(details);
      const formatted120 = formatBytesToKb(120);
      const formatted60 = formatBytesToKb(60);

      const expected = [
        `MyClass: # new: 2, # deleted: 1, # delta: +1, alloc size: +${formatted120}, freed size: +${formatted60}, size delta: +${formatted60}`,
        'Objects:',
        `  + @101 (self_size: ${formatted60})`,
        `  + @102 (self_size: ${formatted60})`,
        `  - @201 (self_size: ${formatted60})`,
      ].join('\n');

      assert.strictEqual(formatted, expected);
    });
  });

  describe('sort', () => {
    it('sorts aggregates by retained size descending', () => {
      const unsortedAggregates: Record<
        string,
        DevTools.HeapSnapshotModel.HeapSnapshotModel.AggregatedInfo
      > = {
        ObjectB: {
          name: 'ObjectB',
          self: 50,
          maxRet: 500,
        },
        ObjectA: {
          name: 'ObjectA',
          self: 100,
          maxRet: 1000,
        },
      } as unknown as Record<
        string,
        DevTools.HeapSnapshotModel.HeapSnapshotModel.AggregatedInfo
      >;

      const result = HeapSnapshotFormatter.sort(unsortedAggregates);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0][0], 'ObjectA');
      assert.strictEqual(result[1][0], 'ObjectB');
    });
  });

  describe('formatRetainingPaths', () => {
    it('formats retaining paths correctly', () => {
      const mockRetainingPaths = [
        {
          edgeIndex: 0,
          edgeName: 'foo',
          edgeType: 'property',
          nodeId: 10,
          nodeIndex: 1,
          nodeName: 'ClassA',
          distance: 2,
          children: [
            {
              edgeIndex: 0,
              edgeName: 'bar',
              edgeType: 'element',
              nodeId: 20,
              nodeIndex: 2,
              nodeName: 'ClassB',
              distance: 1,
              children: [],
            },
          ],
        },
      ] as unknown as DevTools.HeapSnapshotModel.HeapSnapshotModel.RetainingEdge[];

      const result =
        HeapSnapshotFormatter.formatRetainingPaths(mockRetainingPaths);
      const expected = [
        '<- @10 ClassA via property foo (distance: 2)',
        '  <- @20 ClassB via element bar (distance: 1)',
      ].join('\n');

      assert.strictEqual(result, expected);
    });
  });

  describe('formatDominators', () => {
    it('formats dominator chain correctly', () => {
      const mockDominators: DevTools.HeapSnapshotModel.HeapSnapshotModel.DominatorChain =
        [
          {
            nodeId: 10,
            nodeIndex: 1,
            nodeName: 'ClassA',
            retainedSize: 1000,
            selfSize: 100,
          },
          {
            nodeId: 20,
            nodeIndex: 2,
            nodeName: 'ClassB',
            retainedSize: 500,
            selfSize: 50,
          },
        ];

      const result = HeapSnapshotFormatter.formatDominators(mockDominators);
      const expected = [
        'nodeId,nodeName,selfSize,retainedSize',
        `10,ClassA,${formatBytesToKb(100)},${formatBytesToKb(1000)}`,
        `20,ClassB,${formatBytesToKb(50)},${formatBytesToKb(500)}`,
      ].join('\n');

      assert.strictEqual(result, expected);
    });

    it('formats empty dominator chain correctly', () => {
      const mockDominators: DevTools.HeapSnapshotModel.HeapSnapshotModel.DominatorChain =
        [];
      const result = HeapSnapshotFormatter.formatDominators(mockDominators);
      const expected = 'nodeId,nodeName,selfSize,retainedSize';
      assert.strictEqual(result, expected);
    });
  });

  describe('formatNativeContextSizes', () => {
    it('formats native context sizes as CSV with summary lines', () => {
      const mockSizes: DevTools.HeapSnapshotModel.HeapSnapshotModel.NativeContextSizes =
        {
          nativeContexts: [
            {
              nodeId: 10,
              nodeIndex: 1,
              nodeName: 'system / NativeContext',
              attributedSize: 500,
              retainedSize: 1000,
              selfSize: 100,
            },
            {
              nodeId: 20,
              nodeIndex: 2,
              nodeName: 'system / NativeContext / https://example.com',
              attributedSize: 2000,
              retainedSize: 5000,
              selfSize: 200,
            },
          ],
          sharedSize: 300,
          noAttributionSize: 400,
        };

      const result = HeapSnapshotFormatter.formatNativeContextSizes(mockSizes);
      const expected = [
        'nodeId,nodeName,selfSize,retainedSize,attributedSize',
        `20,system / NativeContext / https://example.com,${formatBytesToKb(200)},${formatBytesToKb(5000)},${formatBytesToKb(2000)}`,
        `10,system / NativeContext,${formatBytesToKb(100)},${formatBytesToKb(1000)},${formatBytesToKb(500)}`,
        `Shared Size: ${formatBytesToKb(300)}`,
        `Unattributed Size: ${formatBytesToKb(400)}`,
      ].join('\n');

      assert.strictEqual(result, expected);
    });
  });

  describe('formatRetainedByContextSummary', () => {
    it('formats retained by context summary correctly', () => {
      const mockSummary = {
        contextCount: 2,
        retainedByContextSize: 5000,
        retainedByContextCount: 10,
        notRetainedByContextSize: 1000,
        notRetainedByContextCount: 5,
        totalSize: 6000,
      };

      const result =
        HeapSnapshotFormatter.formatRetainedByContextSummary(mockSummary);
      const expected = [
        'Context count: 2',
        `Retained by context size: ${formatBytesToKb(5000)} (10 objects)`,
        `Not retained by context size: ${formatBytesToKb(1000)} (5 objects)`,
        `Total size: ${formatBytesToKb(6000)}`,
      ].join('\n');

      assert.strictEqual(result, expected);
    });
  });

  describe('formatContextAnalysis', () => {
    it('formats candidate contexts in analysis order', () => {
      const report: ContextAnalysisReport = {
        summary: {
          totalContextCount: 2,
          totalScopeCount: 1,
          totalUnusedFieldsRetainedSizeSum: 5000,
          unmatchedContextCount: 2,
          unmatchedContextReasonCounts: [
            {reason: 'missing-scope-info', count: 1},
            {reason: 'unparseable-source', count: 1},
          ],
        },
        scopes: [
          {
            scopeInfoNodeIndex: 30,
            scopeInfoNodeId: 303,
            scriptId: 7,
            scriptNodeId: 301,
            scriptName: 'test.js',
            scopeStart: 14,
            scopeEnd: 104,
            contextFieldCount: 4,
            contexts: [
              {
                contextNodeIndex: 11,
                contextNodeId: 102,
                retainedSize: 6000,
                unusedFieldsRetainedSizeSum: 3000,
                unusedFields: [
                  {
                    name: 'unused',
                    valueNodeIndex: 80,
                    valueNodeId: 204,
                    valueName: 'LargeCache',
                    valueType: 'object',
                    selfSize: 300,
                    retainedSize: 3000,
                  },
                ],
              },
              {
                contextNodeIndex: 10,
                contextNodeId: 101,
                retainedSize: 5000,
                unusedFieldsRetainedSizeSum: 2000,
                unusedFields: [
                  {
                    name: 'unused',
                    valueNodeIndex: 50,
                    valueNodeId: 202,
                    valueName: 'stale value',
                    valueType: 'string',
                    selfSize: 200,
                    retainedSize: 2000,
                  },
                ],
              },
            ],
            unusedFieldsRetainedSizeSum: 5000,
          },
        ],
      };

      const result = HeapSnapshotFormatter.formatContextAnalysis(report);
      const expected = [
        'Found 2 live contexts with unused fields across 1 source scope.',
        `Unused-field retained-size score: ${formatBytesToKb(5000)}`,
        'The score ranks investigation candidates; it is not an estimate of reclaimable memory.',
        '',
        '#### Scope in `test.js`',
        'Script @301, ScopeInfo @303, offsets 14-104',
        '',
        '##### Context @102',
        '1 of 4 context fields unused',
        `Unused-field score: ${formatBytesToKb(3000)}`,
        `- \`unused\` — ${formatBytesToKb(3000)}; value \`LargeCache\` (object, @204)`,
        '',
        '##### Context @101',
        '1 of 4 context fields unused',
        `Unused-field score: ${formatBytesToKb(2000)}`,
        `- \`unused\` — ${formatBytesToKb(2000)}; value \`stale value\` (string, @202)`,
        '',
        'Unmatched contexts: 2 (missing scope metadata: 1, unparseable source text: 1).',
      ].join('\n');

      assert.strictEqual(result, expected);
    });

    it('reports when there are no contexts with unused fields', () => {
      const report: ContextAnalysisReport = {
        summary: {
          totalContextCount: 0,
          totalScopeCount: 0,
          totalUnusedFieldsRetainedSizeSum: 0,
          unmatchedContextCount: 0,
          unmatchedContextReasonCounts: [],
        },
        scopes: [],
      };

      const result = HeapSnapshotFormatter.formatContextAnalysis(report);

      assert.strictEqual(
        result,
        'No live contexts with unused fields were found.',
      );
    });
  });
});
