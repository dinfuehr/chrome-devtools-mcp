// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

// Run from the repository root with:
// $V8/out/x64.release/d8 --allow-natives-syntax -e \
//   "load('tests/fixtures/dead-closure-context-fields.js'); %TakeHeapSnapshot('tests/fixtures/dead-closure-context-fields.heapsnapshot')"

function createClosureWithDeadSibling() {
  const usedByLiveClosure = {label: 'live'};
  const usedOnlyByDeadClosure = {data: new Array(1024).fill(0)};

  function liveClosure() {
    return usedByLiveClosure;
  }

  function deadClosure() {
    return usedOnlyByDeadClosure;
  }

  // Ensure the sibling closure is instantiated and run, but do not retain it.
  deadClosure();
  return liveClosure;
}

globalThis.closure = createClosureWithDeadSibling();
