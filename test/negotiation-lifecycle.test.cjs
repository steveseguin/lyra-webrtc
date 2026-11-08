'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.LOOPBACK_SOURCE ||
    path.join(__dirname, '../loopback.js'), 'utf8')
    .replace("import Module from './webassembly_codec_wrapper.js';", '');
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const stages = [
  'createOffer', 'caller.setLocalDescription', 'callee.setRemoteDescription',
  'createAnswer', 'callee.setLocalDescription', 'caller.setRemoteDescription',
];

async function makeApp(pausedStage) {
  const pending = deferred();
  const reached = deferred();
  const elements = Object.fromEntries([
    'startButton', 'codecSelect', 'callButton', 'hangupButton',
    'audioOutput', 'bitrateSpan', 'historyTBody',
  ].map(id => [id, {}]));
  elements.codecSelect.value = 'pcm';
  const track = {};
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const peers = [];
  const operations = [];
  const timers = new Set();
  let timerId = 0;
  function operation(peer, name, value) {
    operations.push({ peer: peer.id, name, closed: !!peer.closed });
    if (peer.id < 2 && name === pausedStage) {
      reached.resolve();
      return pending.promise.then(() => value);
    }
    return Promise.resolve(value);
  }
  class PeerConnection {
    constructor() {
      this.id = peers.length;
      this.role = this.id % 2 ? 'callee' : 'caller';
      peers.push(this);
    }
    addTrack() {}
    createOffer() {
      return operation(this, 'createOffer', { type: 'offer', sdp: '' });
    }
    createAnswer() {
      return operation(this, 'createAnswer', { type: 'answer', sdp: '' });
    }
    setLocalDescription() { return operation(this, `${this.role}.setLocalDescription`); }
    setRemoteDescription() { return operation(this, `${this.role}.setRemoteDescription`); }
    addIceCandidate() { return operation(this, 'addIceCandidate'); }
    close() { this.closed = true; }
  }
  vm.runInNewContext(source, {
    Module: () => Promise.resolve({}),
    console: { log() {} },
    document: { getElementById: id => elements[id] },
    navigator: { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } },
    RTCPeerConnection: PeerConnection,
    setInterval() { timers.add(++timerId); return timerId; },
    clearInterval(id) { timers.delete(id); },
  }, { filename: 'loopback.js' });
  await elements.startButton.onclick();
  await settle();
  return {
    pending, reached, elements, peers, operations, timers,
    call: () => elements.callButton.onclick(),
    hangup: () => elements.hangupButton.onclick(),
  };
}

for (const stage of stages) {
  test(`hangup stops negotiation after ${stage} resolves`, async () => {
    const app = await makeApp(stage);
    const call = app.call();
    await app.reached.promise;
    await app.hangup();
    const count = app.operations.length;
    app.pending.resolve();
    await call;
    await settle();
    assert.equal(app.operations.length, count);
    assert.ok(app.peers.every(peer => peer.closed));
    assert.equal(app.elements.callButton.disabled, false);
    assert.equal(app.timers.size, 0);
  });

  test(`hangup absorbs cancellation rejection from ${stage}`, async () => {
    const app = await makeApp(stage);
    const call = app.call();
    await app.reached.promise;
    await app.hangup();
    app.pending.reject(new Error('connection closed'));
    await call;
    await settle();
    assert.equal(app.timers.size, 0);
  });

  test(`old ${stage} completion cannot negotiate a restarted call`, async () => {
    const app = await makeApp(stage);
    const oldCall = app.call();
    await app.reached.promise;
    await app.hangup();
    const newCall = app.call();
    await newCall;
    await settle();
    const count = app.operations.length;
    app.pending.resolve();
    await oldCall;
    await settle();
    assert.equal(app.operations.length, count);
    assert.equal(app.peers.length, 4);
    assert.ok(app.peers.slice(2).every(peer => !peer.closed));
    assert.equal(app.timers.size, 1);
  });

  test(`active negotiation failure at ${stage} closes the failed call`, async () => {
    const app = await makeApp(stage);
    const call = app.call();
    await app.reached.promise;
    app.pending.reject(new Error('negotiation failed'));
    await call;
    await settle();
    assert.ok(app.peers.every(peer => peer.closed));
    assert.equal(app.elements.callButton.disabled, false);
    assert.equal(app.elements.codecSelect.disabled, false);
    assert.equal(app.timers.size, 0);
  });

  test(`old ${stage} rejection cannot close a restarted call`, async () => {
    const app = await makeApp(stage);
    const oldCall = app.call();
    await app.reached.promise;
    await app.hangup();
    await app.call();
    await settle();
    app.pending.reject(new Error('old connection closed'));
    await oldCall;
    await settle();
    assert.ok(app.peers.slice(2).every(peer => !peer.closed));
    assert.equal(app.elements.callButton.disabled, true);
    assert.equal(app.timers.size, 1);
  });
}

test('closed-call ICE and track callbacks cannot affect a restarted call', async () => {
  const app = await makeApp('createOffer');
  const oldCall = app.call();
  await app.reached.promise;
  await app.hangup();
  await app.call();
  await settle();
  const count = app.operations.length;
  app.peers[0].onicecandidate({ candidate: {} });
  app.peers[1].onicecandidate({ candidate: {} });
  app.peers[1].ontrack({ streams: [{}] });
  await settle();
  assert.equal(app.operations.length, count);
  assert.equal(app.elements.audioOutput.srcObject, undefined);
  app.pending.resolve();
  await oldCall;
});

test('normal negotiation sets both local and remote descriptions', async () => {
  const app = await makeApp();
  await app.call();
  await settle();
  assert.deepEqual(app.operations.map(operation => operation.name), stages);
  assert.equal(app.elements.hangupButton.disabled, false);
  assert.equal(app.timers.size, 1);
  await app.hangup();
  assert.equal(app.timers.size, 0);
});

test('late ICE rejection cannot close a restarted call', async () => {
  const app = await makeApp('addIceCandidate');
  await app.call();
  await settle();
  app.peers[0].onicecandidate({ candidate: {} });
  await app.reached.promise;
  await app.hangup();
  await app.call();
  await settle();
  app.pending.reject(new Error('old connection closed'));
  await settle();
  assert.ok(app.peers.slice(2).every(peer => !peer.closed));
  assert.equal(app.timers.size, 1);
});

test('active ICE rejection does not tear down the entire call', async () => {
  const app = await makeApp('addIceCandidate');
  await app.call();
  await settle();
  app.peers[0].onicecandidate({ candidate: {} });
  await app.reached.promise;
  app.pending.reject(new Error('candidate rejected'));
  await settle();
  assert.ok(app.peers.every(peer => !peer.closed));
  assert.equal(app.timers.size, 1);
});
