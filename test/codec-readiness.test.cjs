'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the full application with controllable browser dependencies. Only the
// ESM import is replaced; the codec-loading promise and UI handlers are real.
const source = fs.readFileSync(process.env.LOOPBACK_SOURCE ||
    path.join(__dirname, '../loopback.js'), 'utf8')
    .replace("import Module from './webassembly_codec_wrapper.js';", '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function makeApp() {
  const moduleLoad = deferred();
  const microphone = deferred();
  const elements = Object.fromEntries([
    'startButton', 'codecSelect', 'callButton', 'hangupButton',
    'audioOutput', 'bitrateSpan', 'historyTBody',
  ].map(id => [id, { disabled: false }]));
  elements.callButton.disabled = true;
  elements.hangupButton.disabled = true;
  elements.codecSelect.value = 'lyra';
  const track = {};
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const peers = [];
  const pipelines = [];
  const frames = [];
  const memory = new Uint8Array(8192);
  let allocation = 0;
  const codec = {
    HEAPU8: memory,
    _malloc(size) { const pointer = allocation; allocation += size; return pointer; },
    _free() {},
    encode(input, size, sampleRate, output) {
      assert.equal(size, 640);
      assert.equal(sampleRate, 16000);
      memory.set([1, 2, 3], output);
      return 3;
    },
  };
  class PeerConnection {
    constructor() { peers.push(this); }
    addTrack() {}
    getSenders() {
      return [{ createEncodedStreams() {
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue({ data: new ArrayBuffer(640) });
            controller.close();
          },
        });
        return {
          readable: { pipeThrough(transform) {
            const transformed = readable.pipeThrough(transform);
            return { pipeTo(writable) {
              const result = transformed.pipeTo(writable);
              pipelines.push(result);
              // Preserve rejection for assertions without an unhandled promise.
              result.catch(() => {});
              return result;
            } };
          } },
          writable: new WritableStream({ write(frame) { frames.push(frame); } }),
        };
      } }];
    }
    getTransceivers() {
      return [{ sender: { track }, setCodecPreferences() {} }];
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    Module: () => moduleLoad.promise,
    console: { log() {} },
    document: { getElementById: id => elements[id] },
    navigator: { mediaDevices: { getUserMedia: () => microphone.promise } },
    RTCPeerConnection: PeerConnection,
    RTCRtpSender: { getCapabilities: () => ({ codecs: [
      { mimeType: 'audio/opus' }, { mimeType: 'audio/PCMA' },
    ] }) },
    TransformStream, Uint8Array, ArrayBuffer,
    setInterval: () => 1,
    clearInterval() {},
  });
  vm.runInContext(source, context, { filename: 'loopback.js' });
  return {
    elements, peers, pipelines, frames,
    async start() {
      await elements.startButton.onclick();
      microphone.resolve(stream);
      await settle();
    },
    async loadCodec() { moduleLoad.resolve(codec); await settle(); },
    async failCodec() { moduleLoad.reject(new Error('WASM unavailable')); await settle(); },
    selectCodec(value) {
      elements.codecSelect.value = value;
      elements.codecSelect.onchange?.();
    },
    call: () => elements.callButton.onclick(),
    hangup: () => elements.hangupButton.onclick(),
  };
}

test('Lyra remains disabled when microphone permission beats codec loading', async () => {
  const app = makeApp();
  await app.start();
  assert.equal(app.elements.callButton.disabled, true);
  await app.loadCodec();
  assert.equal(app.elements.callButton.disabled, false);
});

test('codec readiness does not enable Call before microphone acquisition', async () => {
  const app = makeApp();
  await app.loadCodec();
  assert.equal(app.elements.callButton.disabled, true);
  await app.start();
  assert.equal(app.elements.callButton.disabled, false);
});

test('an early Call cannot create a transform against an uninitialized codec', async () => {
  const app = makeApp();
  await app.start();
  await app.call();
  await settle();
  assert.equal(app.peers.length, 0);
  assert.equal(app.pipelines.length, 0);
});

test('a ready Lyra call encodes its first frame', async () => {
  const app = makeApp();
  await app.start();
  await app.loadCodec();
  await app.call();
  await Promise.all(app.pipelines);
  assert.equal(app.peers.length, 2);
  assert.equal(app.frames.length, 1);
  assert.deepEqual([...new Uint8Array(app.frames[0].data)], [1, 2, 3]);
  assert.equal(app.elements.callButton.disabled, true);
});

for (const codec of ['pcm', 'opus', 'g711']) {
  test(`${codec} can call while Lyra loads; returning to Lyra waits`, async () => {
    const app = makeApp();
    await app.start();
    app.selectCodec(codec);
    assert.equal(app.elements.callButton.disabled, false);
    app.selectCodec('lyra');
    assert.equal(app.elements.callButton.disabled, true);
    app.selectCodec(codec);
    await app.call();
    await settle();
    assert.equal(app.peers.length, 2);
    assert.equal(app.pipelines.length, 0);
  });
}

test('loading Lyra during a PCM call does not enable a second call', async () => {
  const app = makeApp();
  await app.start();
  app.selectCodec('pcm');
  await app.call();
  await app.loadCodec();
  assert.equal(app.elements.callButton.disabled, true);
  await app.call();
  assert.equal(app.peers.length, 2);
});

test('hangup and codec selection recompute readiness without a reload', async () => {
  const app = makeApp();
  await app.start();
  app.selectCodec('pcm');
  await app.call();
  await settle();
  await app.hangup();
  assert.ok(app.peers.every(peer => peer.closed));
  assert.equal(app.elements.callButton.disabled, false);
  app.selectCodec('lyra');
  assert.equal(app.elements.callButton.disabled, true);
  await app.loadCodec();
  assert.equal(app.elements.callButton.disabled, false);
  await app.call();
  await Promise.all(app.pipelines);
  assert.equal(app.peers.length, 4);
});

test('failed Lyra loading keeps Lyra disabled but leaves other codecs usable', async () => {
  const app = makeApp();
  await app.start();
  await app.failCodec();
  assert.equal(app.elements.callButton.disabled, true);
  app.selectCodec('opus');
  assert.equal(app.elements.callButton.disabled, false);
  await app.call();
  await settle();
  assert.equal(app.peers.length, 2);
});

test('switching codecs before microphone acquisition does not enable Call', async () => {
  const app = makeApp();
  app.selectCodec('pcm');
  assert.equal(app.elements.callButton.disabled, true);
  await app.call();
  assert.equal(app.peers.length, 0);
});
