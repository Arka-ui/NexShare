/*
 * NexShare security unit tests — Node built-in runner, zero dependencies.
 *   run with:  node --test   (Node >= 18)
 *
 * transfer.js is a browser script (no module exports), so it is evaluated in a
 * vm context seeded with the test realm's intrinsics (so `instanceof Uint8Array`
 * matches across the boundary) plus a controllable `navigator` stub. esc() is
 * extracted from app.js and evaluated directly. Both test the REAL shipped source.
 * Special characters are built with String.fromCharCode so the source stays ASCII.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RLO = String.fromCharCode(0x202E);  // RIGHT-TO-LEFT OVERRIDE
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const ARABIC = String.fromCharCode(0x0645, 0x0644, 0x0641); // a normal RTL word

function hasBidiControl(s) {
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if ((c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069) || c === 0x200E || c === 0x200F) return true;
    }
    return false;
}

/* ---- load transfer.js into a realm that shares this file's intrinsics ---- */
const sandbox = {
    Set, Map, Array, Object, Number, String, Boolean, Symbol, Math, Date, JSON,
    RegExp, isFinite, isNaN, parseInt, parseFloat, Error, TypeError,
    Uint8Array, ArrayBuffer, DataView,
    EventTarget, Event, Blob, crypto,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    setTimeout, clearTimeout, console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(root, 'js', 'transfer.js'), 'utf8') +
    '\n;globalThis.__NexTransfer = NexTransfer;', sandbox);
const NexTransfer = sandbox.__NexTransfer;

/* ---- extract esc() from app.js and evaluate it standalone ---- */
const appSrc = readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const escMatch = appSrc.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/);
const esc = new Function('return (' + escMatch[0] + ')')();

const meta = (files, totalSize) => {
    const t = new NexTransfer({});
    t._handleData({ type: 'meta', files, totalSize });
    return t;
};

/* ================= session code (entropy / charset / bias) ================= */
test('generateCode: 6 chars from the 32-symbol alphabet, no modulo bias', () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    assert.equal(alphabet.length, 32);
    assert.equal(256 % alphabet.length, 0, '256 is a multiple of 32 -> uniform mapping, no bias');
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
        const code = NexTransfer.generateCode();
        assert.equal(code.length, 6);
        for (const ch of code) assert.ok(alphabet.includes(ch), `unexpected char ${ch}`);
        seen.add(code);
    }
    assert.ok(seen.size > 1900, 'codes should be overwhelmingly unique (CSPRNG)');
});

/* ============================ filename sanitizer ============================ */
test('sanitizeFilename: ordinary names pass through unchanged', () => {
    assert.equal(NexTransfer.sanitizeFilename('photo.jpg'), 'photo.jpg');
    assert.equal(NexTransfer.sanitizeFilename('My Report (final) v2.pdf'), 'My Report (final) v2.pdf');
    assert.equal(NexTransfer.sanitizeFilename('cafe_resume.txt'), 'cafe_resume.txt');
    assert.equal(NexTransfer.sanitizeFilename(ARABIC + '.txt'), ARABIC + '.txt', 'legitimate RTL letters preserved');
});
test('sanitizeFilename: strips path components (traversal)', () => {
    assert.equal(NexTransfer.sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(NexTransfer.sanitizeFilename('a/b/c.txt'), 'c.txt');
    assert.equal(NexTransfer.sanitizeFilename('C:\\Windows\\system32\\evil.dll'), 'evil.dll');
});
test('sanitizeFilename: removes U+202E bidi override (extension spoofing)', () => {
    const spoof = 'photo' + RLO + 'gpj.exe';   // renders to a human as "photoexe.jpg"
    const out = NexTransfer.sanitizeFilename(spoof);
    assert.equal(hasBidiControl(out), false, 'no bidi controls remain');
    assert.equal(out, 'photogpj.exe');
});
test('sanitizeFilename: strips control chars, caps length, has a fallback', () => {
    assert.equal(NexTransfer.sanitizeFilename('a' + BEL + 'bcd' + NUL + '.txt'), 'abcd.txt');
    assert.equal(NexTransfer.sanitizeFilename(''), 'fichier');
    assert.equal(NexTransfer.sanitizeFilename('...'), 'fichier');
    assert.equal(NexTransfer.sanitizeFilename('/'), 'fichier');
    assert.equal(NexTransfer.sanitizeFilename(null), 'fichier');
    assert.ok(NexTransfer.sanitizeFilename('x'.repeat(5000)).length <= 255);
});

/* ============================ block-list (H1) ============================== */
test('isBlocked: executables blocked by extension or MIME, normal files allowed', () => {
    assert.equal(NexTransfer.isBlocked('setup.exe', ''), true);
    assert.equal(NexTransfer.isBlocked('run.BAT', ''), true, 'case-insensitive');
    assert.equal(NexTransfer.isBlocked('x', 'application/x-msdownload'), true);
    assert.equal(NexTransfer.isBlocked('photo.jpg', 'image/jpeg'), false);
    assert.equal(NexTransfer.isBlocked('notes.txt', 'text/plain'), false);
    assert.equal(NexTransfer.isBlocked(null, null), false);
});
test('_shouldAutoDownload: never auto-downloads a blocked type (drive-by guard)', () => {
    const t = new NexTransfer({});
    assert.equal(t._shouldAutoDownload({ name: 'invoice.exe', fileType: 'application/x-msdownload', size: 1000 }), false);
    assert.equal(t._shouldAutoDownload({ name: 'doc.pdf', fileType: 'application/pdf', size: 1000 }), true,
        'ordinary file on desktop still auto-downloads (behavior preserved)');
});

/* ===================== safe size coercion ===================== */
test('_safeSize: clamps to a non-negative integer', () => {
    assert.equal(NexTransfer._safeSize(100), 100);
    assert.equal(NexTransfer._safeSize(3.9), 3);
    assert.equal(NexTransfer._safeSize(-5), 0);
    assert.equal(NexTransfer._safeSize('abc'), 0);
    assert.equal(NexTransfer._safeSize(NaN), 0);
    assert.equal(NexTransfer._safeSize(Infinity), 0);
    assert.equal(NexTransfer._safeSize(undefined), 0);
});

/* ===================== malicious-peer meta validation (H2) ===================== */
test('meta: rejects non-array / empty / oversized file lists', () => {
    for (const bad of [undefined, null, 42, 'x', {}, []]) {
        const t = new NexTransfer({});
        let errored = false;
        t.addEventListener('error', () => { errored = true; });
        assert.doesNotThrow(() => t._handleData({ type: 'meta', files: bad }));
        assert.equal(errored, true, `files=${JSON.stringify(bad)} should emit error`);
        assert.equal(t.receivedMeta, null, 'receivedMeta must not be set on invalid meta');
    }
    const tBig = new NexTransfer({});
    let big = false; tBig.addEventListener('error', () => { big = true; });
    tBig._handleData({ type: 'meta', files: new Array(4097).fill({ name: 'a', size: 0 }) });
    assert.equal(big, true, '>4096 files rejected');
});
test('meta: coerces/sanitizes each entry and emits sanitized incoming', () => {
    const t = new NexTransfer({});
    let detail = null;
    t.addEventListener('incoming', (e) => { detail = e.detail; });
    t._handleData({ type: 'meta', files: [
        { name: '../../secret' + RLO + 'gpj.exe', size: 10, fileType: 'text/plain' },
        { name: 'ok.txt', size: '50', fileType: 12345 },
    ], totalSize: 'lots' });
    assert.equal(t.receivedMeta.length, 2);
    assert.equal(t.receivedMeta[0].name, 'secretgpj.exe', 'path + bidi stripped');
    assert.equal(t.receivedMeta[1].size, 0, 'non-number size coerced to 0');
    assert.equal(t.receivedMeta[1].fileType, '', 'non-string fileType coerced to empty');
    assert.equal(t.recvTotalSize, 10, 'bad totalSize -> sum of safe sizes');
    assert.equal(detail.files[0].name, 'secretgpj.exe', 'incoming carries sanitized names');
});

/* ===================== malicious-peer chunk validation (H2) ===================== */
test('chunk: out-of-range index is ignored without throwing', () => {
    const t = meta([{ name: 'a.bin', size: 100, fileType: '' }], 100);
    assert.doesNotThrow(() => t._handleData({ type: 'chunk', index: 5, chunkIndex: 0, data: new Uint8Array(10) }));
    assert.doesNotThrow(() => t._handleData({ type: 'chunk', index: -1, chunkIndex: 0, data: new Uint8Array(10) }));
    assert.equal(t.recvReceived[0], 0);
});
test('chunk: non-typed-array payload is ignored (no NaN, no throw)', () => {
    const t = meta([{ name: 'a.bin', size: 100, fileType: '' }], 100);
    for (const bad of ['xxx', 123, null, undefined, {}]) {
        assert.doesNotThrow(() => t._handleData({ type: 'chunk', index: 0, chunkIndex: 0, data: bad }));
    }
    assert.equal(t.recvReceived[0], 0, 'recvReceived stays 0 (never becomes NaN)');
    assert.ok(!Number.isNaN(t.recvReceived[0]));
});
test('chunk: accepts valid chunks but never exceeds the declared file size (DoS cap)', () => {
    const t = meta([{ name: 'a.bin', size: 100, fileType: '' }], 100);
    t._handleData({ type: 'chunk', index: 0, chunkIndex: 0, data: new Uint8Array(50) });
    t._handleData({ type: 'chunk', index: 0, chunkIndex: 1, data: new Uint8Array(50) });
    assert.equal(t.recvReceived[0], 100, 'two 50-byte chunks accepted');
    t._handleData({ type: 'chunk', index: 0, chunkIndex: 2, data: new Uint8Array(10) });
    assert.equal(t.recvReceived[0], 100, 'bytes beyond declared size are rejected');
});
test('chunk: a hostile huge chunkIndex is bounded (no giant sparse array)', () => {
    const t = meta([{ name: 'a.bin', size: 100, fileType: '' }], 100);
    assert.doesNotThrow(() => t._handleData({ type: 'chunk', index: 0, chunkIndex: 1e9, data: new Uint8Array(1) }));
    assert.equal(t.recvBuffers[0].length, 0, 'oversized chunkIndex not stored');
});
test('chunk: ArrayBuffer payload is normalized to Uint8Array and counted', () => {
    const t = meta([{ name: 'a.bin', size: 100, fileType: '' }], 100);
    t._handleData({ type: 'chunk', index: 0, chunkIndex: 0, data: new ArrayBuffer(20) });
    assert.equal(t.recvReceived[0], 20);
    assert.ok(t.recvBuffers[0][0] instanceof Uint8Array);
});

/* ============================ HTML escaping (esc) ============================ */
test('esc: escapes &, <, >, " and now single quotes', () => {
    assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(esc('"&\''), '&quot;&amp;&#39;');
    assert.equal(esc("a'b"), 'a&#39;b');
    assert.equal(esc('plain text'), 'plain text');
});
