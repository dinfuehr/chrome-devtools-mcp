// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

// Run from the repository root with:
// $V8/out/x64.release/d8 --allow-natives-syntax -e \
//   "load('tests/fixtures/unused-context-fields.js'); %TakeHeapSnapshot('tests/fixtures/unused-context-fields.heapsnapshot')"

function createClosureWithUnusedContextField() {
  const used = {label: 'used'};
  const unused = {data: new Array(1024).fill(0)};

  // A direct eval forces both locals into context slots. The returned closure
  // keeps that context alive, even though it only reads used.
  eval('');
  return function closure() {
    return used;
  };
}

globalThis.closure = createClosureWithUnusedContextField();
