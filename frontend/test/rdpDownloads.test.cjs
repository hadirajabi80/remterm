const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('../node_modules/typescript');

const sourcePath = path.resolve(__dirname, '../src/rdpDownloads.ts');
const compiled = new Module(sourcePath, module);
compiled.filename = sourcePath;
compiled.paths = Module._nodeModulePaths(path.dirname(sourcePath));
compiled._compile(
  ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  sourcePath,
);
const { RDP_DOWNLOAD_CHUNK_BYTES, RdpDownloadLifecycle, RdpStallGuard, streamRdpDownload } = compiled.exports;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('stale save dialogs cannot reserve or close a replacement session', () => {
  const lifecycle = new RdpDownloadLifecycle();
  const first = lifecycle.start();
  const firstList = [{ name: 'a.txt' }];
  lifecycle.publishFiles(first, firstList);
  assert.equal(lifecycle.reserve(first, firstList), true);

  const second = lifecycle.start();
  assert.equal(lifecycle.reserve(first, firstList), false);
  assert.equal(lifecycle.end(first), false);
  const secondList = [{ name: 'b.txt' }];
  lifecycle.publishFiles(second, secondList);
  assert.equal(lifecycle.currentFiles(second), secondList);
  assert.equal(lifecycle.reserve(second, secondList), true);
  lifecycle.release(second);
  assert.equal(lifecycle.reserve(second, secondList), true);
});

test('native writes receive bounded base64 chunks and finish only after the last write', async () => {
  const bytes = Uint8Array.from({ length: RDP_DOWNLOAD_CHUNK_BYTES + 19 }, (_, i) => i % 251);
  const writes = [];
  let finished = false;
  const bridge = {
    async write(id, chunk) {
      assert.equal(id, 'save-1');
      const decoded = Buffer.from(chunk, 'base64');
      assert.ok(decoded.byteLength <= RDP_DOWNLOAD_CHUNK_BYTES);
      writes.push(decoded);
    },
    async finish(id) {
      assert.equal(id, 'save-1');
      finished = true;
    },
    async cancel() {
      assert.fail('successful stream should not cancel');
    },
  };
  await streamRdpDownload(new Blob([bytes]), 'save-1', bridge, () => true, () => {});
  assert.equal(finished, true);
  assert.equal(writes.length, 2);
  assert.deepEqual(Buffer.concat(writes), Buffer.from(bytes));
});

test('a disconnected stream cancels its staged native file', async () => {
  let cancelled = false;
  const bridge = {
    async write() {},
    async finish() { assert.fail('stale transfer must not finish'); },
    async cancel(id) { cancelled = id === 'save-2'; },
  };
  await assert.rejects(
    streamRdpDownload(new Blob([new Uint8Array([1, 2, 3])]), 'save-2', bridge, () => false, () => {}),
    /session ended/,
  );
  assert.equal(cancelled, true);
});

test('a failed native finish rejects the save and cancels the staged file', async () => {
  let cancelled = null;
  const bridge = {
    async write() {},
    async finish() { throw new Error('disk full'); },
    async cancel(id) { cancelled = id; },
  };
  await assert.rejects(
    streamRdpDownload(new Blob([new Uint8Array([9])]), 'save-3', bridge, () => true, () => {}),
    /disk full/,
  );
  assert.equal(cancelled, 'save-3');
});

test('an empty file finishes without any write', async () => {
  let finished = false;
  const bridge = {
    async write() { throw new Error('empty file must not send chunks'); },
    async finish() { finished = true; },
    async cancel() { assert.fail('empty file should not cancel'); },
  };
  await streamRdpDownload(new Blob([]), 'save-4', bridge, () => true, () => {});
  assert.equal(finished, true);
});

test('stall watchdog fires after inactivity and progress keeps it waiting', async () => {
  let stalls = 0;
  const guard = new RdpStallGuard(30, () => stalls++);
  guard.activity();
  await sleep(15);
  guard.activity(); // progress arrived: the stall deadline moves forward
  await sleep(20);
  assert.equal(stalls, 0);
  await sleep(30);
  assert.equal(stalls, 1);
  guard.clear();
  guard.activity(); // stale progress after cleanup must not re-arm the watchdog
  await sleep(50);
  assert.equal(stalls, 1);
});

test('a cleared watchdog never fires', async () => {
  let stalls = 0;
  const guard = new RdpStallGuard(20, () => stalls++);
  guard.activity();
  guard.clear();
  await sleep(45);
  assert.equal(stalls, 0);
});
