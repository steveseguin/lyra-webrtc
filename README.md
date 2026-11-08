# Lyra on WebRTC

This sample shows [Lyra](https://ai.googleblog.com/2021/02/lyra-new-very-low-bitrate-codec-for.html) on WebRTC MediaChannel.

Chrome can use L16 (16-bit PCM BigEndian) by changing SDP. In this sample, L16 is set in PeerConnection, and L16 is extracted in TransformStream of EncodedStream and encoded in Lyra by WASM.

## Try It

https://meeting.dev/lab/lyra-webrtc/loopback.html

## How to use 

In this directory, run the following command. Lyra WASM uses SharedArrayBuffer. Therefore, you need to set specific HTTP Headers, which are included in server.py.

> python3 server.py

And Open the following URL

http://localhost:8000/loopback.html

## Tests

Run the codec-readiness regression tests with Node.js 18 or newer:

```sh
node --test test/codec-readiness.test.cjs
```

These tests use controlled browser and codec dependencies. They do not replace
testing real WebRTC audio and the WASM codec in a browser.

## Acknowledgments

Thanks to [the team that developed Lyra](https://ai.googleblog.com/2021/02/lyra-new-very-low-bitrate-codec-for.html) and to [mayitayew for making it work with WASM](https://github.com/mayitayew/soundstream-wasm).

We are using a modified Lyra WASM. It is available [here](https://github.com/Flash-Meeting/lyra-wasm).
