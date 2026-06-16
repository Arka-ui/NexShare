/* NexShare Transfer Engine — WebRTC P2P via PeerJS */

const DEFAULT_CHUNK_SIZE = 65536;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_PREFIX = 'nxs-';
const EXPIRY_MS   = 30 * 60 * 1000;

const BLOCKED_EXTS = new Set([
    '.exe','.bat','.cmd','.sh','.ps1','.vbs','.jar',
    '.msi','.app','.scr','.pif','.com','.cpl','.reg',
]);
const BLOCKED_TYPES = new Set([
    'application/x-msdownload','application/x-executable',
    'application/x-sh','application/x-bat','application/x-msdos-program',
]);

class NexTransfer extends EventTarget {
    constructor(options) {
        super();
        options = options || {};
        this.peer = null; this.conn = null; this.role = null;
        this.files = []; this.receivedMeta = null;
        this.recvBuffers = []; this.recvReceived = [];
        this._recvFileLimit = []; this._recvMaxChunks = [];
        this.recvTotalSize = 0; this.recvStartAt = 0;
        this.pendingDownloadUrls = [];
        this._expiryTimer = null; this._expiryStart = null;
        this._transferDone = false;
        this.compatibilityMode = !!options.compatibilityMode;
        this.chunkSize = this.compatibilityMode ? 16384 : NexTransfer.recommendedChunkSize();
        this.maxBuffer = this.compatibilityMode ? 512 * 1024 : NexTransfer.recommendedMaxBuffer();
        this.networkProfile = NexTransfer.buildNetworkProfile(this.chunkSize, this.maxBuffer, this.compatibilityMode);
    }

    static buildNetworkProfile(chunkSize, maxBuffer, compatibilityMode) {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const downlink = conn && typeof conn.downlink === 'number' ? conn.downlink : 0;
        const saveData = !!(conn && conn.saveData);
        const effectiveType = conn && conn.effectiveType ? conn.effectiveType : 'unknown';
        const memory = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 4;

        let quality = 'medium';
        if (compatibilityMode || saveData || (downlink > 0 && downlink < 2) || /2g/.test(effectiveType) || memory <= 2) quality = 'low';
        else if (downlink >= 8 && /4g|5g/.test(effectiveType) && memory >= 4) quality = 'good';

        return {
            chunkSize,
            maxBuffer,
            compatibilityMode,
            downlink,
            effectiveType,
            saveData,
            memory,
            quality,
        };
    }

    static recommendedChunkSize() {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const downlink = conn && typeof conn.downlink === 'number' ? conn.downlink : 0;
        const saveData = !!(conn && conn.saveData);
        const memory = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 4;

        if (saveData || downlink > 0 && downlink < 2 || memory <= 2) return 16384;
        if (downlink > 0 && downlink < 5) return 32768;
        return DEFAULT_CHUNK_SIZE;
    }

    static recommendedMaxBuffer() {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        const saveData = !!(conn && conn.saveData);
        const memory = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 4;

        if (saveData || memory <= 2) return 1 * 1024 * 1024;
        if (memory <= 4) return 2 * 1024 * 1024;
        return DEFAULT_MAX_BUFFER;
    }

    static generateCode() {
        const arr = new Uint8Array(6);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    }

    static formatBytes(n) {
        n = Math.max(0, n || 0);
        if (n < 1024)       return n + ' B';
        if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }

    static formatTime(sec) {
        if (!isFinite(sec) || sec < 0) return '--:--';
        const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    static isBlocked(name, type) {
        const ext = '.' + (String(name == null ? '' : name).split('.').pop() || '').toLowerCase();
        return BLOCKED_EXTS.has(ext) || BLOCKED_TYPES.has(type);
    }

    // Coerce a remote-supplied size to a safe non-negative integer.
    static _safeSize(n) {
        return (typeof n === 'number' && isFinite(n) && n >= 0) ? Math.floor(n) : 0;
    }

    // Strip path components, control chars and Unicode bidi overrides (used for
    // extension spoofing, e.g. U+202E RIGHT-TO-LEFT OVERRIDE) from a peer-supplied
    // filename before it is displayed or used as a download name. Ordinary
    // filenames — including legitimate RTL scripts — pass through unchanged.
    static sanitizeFilename(name) {
        const raw = String(name == null ? '' : name).replace(/^.*[\\/]/, '');
        let out = '';
        for (let i = 0; i < raw.length; i++) {
            const c = raw.charCodeAt(i);
            if (c < 0x20 || c === 0x7F) continue;                 // C0 controls + DEL
            if (c >= 0x202A && c <= 0x202E) continue;             // bidi embeddings/overrides
            if (c >= 0x2066 && c <= 0x2069) continue;             // bidi isolates
            if (c === 0x200E || c === 0x200F) continue;           // LRM / RLM
            out += raw[i];
        }
        out = out.trim().slice(0, 255);
        if (!out || /^\.+$/.test(out)) out = 'fichier';
        return out;
    }

    static validateFiles(files) {
        const errors = [];
        for (const f of files) {
            if (NexTransfer.isBlocked(f.name, f.type))
                errors.push('"' + f.name + '" est bloqué pour des raisons de sécurité.');
        }
        return errors;
    }

    _emit(type, detail) {
        const e = new Event(type);
        e.detail = detail || {};
        this.dispatchEvent(e);
    }

    /* ── SENDER ── */
    initSender(files) {
        this.role = 'sender'; this.files = Array.from(files);
        const code = NexTransfer.generateCode();
        this.peer = new Peer(PEER_PREFIX + code, this._cfg());
        this.peer.on('open', () => {
            this._emit('network-profile', this.networkProfile);
            this._emit('code', { code });
            this._startExpiry();
        });
        this.peer.on('connection', conn => {
            if (this.conn) { conn.close(); return; }
            this.conn = conn; this._onSenderConn(conn);
        });
        this.peer.on('error', err => {
            if (err.type === 'unavailable-id') { this.peer.destroy(); this.peer = null; this.initSender(files); }
            else this._emit('error', { message: this._fmtErr(err) });
        });
    }

    _onSenderConn(conn) {
        conn.on('open', () => {
            this._clearExpiry();
            this._emit('status', { state: 'connected', message: 'Pair connecté' });
            this._emit('network-profile', this.networkProfile);
            conn.send({
                type: 'meta',
                files: this.files.map(f => ({ name: f.name, size: f.size, fileType: f.type })),
                totalSize: this.files.reduce((s, f) => s + f.size, 0),
            });
        });
        conn.on('data', msg => {
            if (msg && msg.type === 'accept') this._doSend();
            if (msg && msg.type === 'reject') { this._emit('status', { state: 'rejected', message: 'Refusé par le destinataire' }); this.destroy(); }
        });
        conn.on('close', () => {
            this.conn = null;
            if (!this._transferDone) {
                this._emit('status', { state: 'disconnected', message: 'Connexion interrompue, nouvelle connexion possible.' });
            }
        });
        conn.on('error', err => this._emit('error', { message: this._fmtErr(err) }));
    }

    async _doSend() {
        const totalSize = this.files.reduce((s, f) => s + f.size, 0);
        const tStart = Date.now(); let totalSent = 0;
        this._emit('transfer-start', { role: 'sender', fileCount: this.files.length });
        for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i];
            this._emit('file-start', { index: i, name: file.name, size: file.size });
            this.conn.send({ type: 'file-start', index: i, name: file.name, size: file.size, fileType: file.type });
            const buffer = await file.arrayBuffer();
            const totalChunks = Math.ceil(buffer.byteLength / this.chunkSize);
            for (let c = 0; c < totalChunks; c++) {
                await this._awaitBuf();
                const slice = buffer.slice(c * this.chunkSize, (c + 1) * this.chunkSize);
                this.conn.send({ type: 'chunk', index: i, chunkIndex: c, totalChunks, data: new Uint8Array(slice) });
                totalSent += slice.byteLength;
                const elapsed = (Date.now() - tStart) / 1000 || 0.001;
                const speed = totalSent / elapsed;
                this._emit('progress', {
                    sent: totalSent, total: totalSize,
                    percent: Math.round(totalSent / totalSize * 100),
                    speed, remaining: (totalSize - totalSent) / speed,
                    fileIndex: i, fileName: file.name,
                });
            }
            this.conn.send({ type: 'file-end', index: i });
            this._emit('file-done', { index: i, name: file.name });
        }
        this.conn.send({ type: 'done' });
        this._transferDone = true;
        this._emit('complete', { role: 'sender' });
    }

    _awaitBuf() {
        return new Promise(resolve => {
            const check = () => {
                const dc = this.conn && this.conn.dataChannel;
                // Resolve if the channel is gone or no longer open, otherwise we would
                // busy-wait forever on a stalled/closed channel.
                if (!dc || dc.readyState !== 'open' || dc.bufferedAmount < this.maxBuffer) return resolve();
                setTimeout(check, 50);
            };
            check();
        });
    }

    /* ── RECEIVER ── */
    initReceiver(code) {
        this.role = 'receiver';
        this.peer = new Peer(this._cfg());
        this.peer.on('open', () => {
            this._emit('status', { state: 'connecting', message: 'Connexion en cours…' });
            this._emit('network-profile', this.networkProfile);
            this.conn = this.peer.connect(PEER_PREFIX + code.trim().toUpperCase(), { reliable: true });
            this._onReceiverConn(this.conn);
        });
        this.peer.on('error', err => this._emit('error', { message: this._fmtErr(err) }));
    }

    _onReceiverConn(conn) {
        conn.on('open', () => this._emit('status', { state: 'connected', message: 'Connecté — attente des données…' }));
        conn.on('data', msg => this._handleData(msg));
        conn.on('close', () => { if (!this._transferDone) this._emit('status', { state: 'disconnected', message: 'Connexion interrompue' }); });
        conn.on('error', err => this._emit('error', { message: this._fmtErr(err) }));
    }

    _handleData(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'meta') {
            // Untrusted peer input: require a sane file array and coerce every field.
            if (!Array.isArray(msg.files) || msg.files.length === 0 || msg.files.length > 4096) {
                this._emit('error', { message: 'Métadonnées de transfert invalides.' });
                return;
            }
            const files = msg.files.map(f => ({
                name: NexTransfer.sanitizeFilename(f && f.name),
                size: NexTransfer._safeSize(f && f.size),
                fileType: (f && typeof f.fileType === 'string') ? f.fileType.slice(0, 255) : '',
            }));
            this.receivedMeta   = files;
            this.recvBuffers    = files.map(() => []);
            this.recvReceived   = files.map(() => 0);
            this._recvFileLimit = files.map(f => f.size);
            // Bound the per-file chunk index so a hostile chunkIndex cannot create a
            // giant sparse array (generous: allows chunks down to ~1 KiB + slack).
            this._recvMaxChunks = files.map(f => Math.ceil(f.size / 1024) + 16);
            this.recvTotalSize = NexTransfer._safeSize(msg.totalSize) || files.reduce((a, f) => a + f.size, 0);
            this.recvStartAt = 0;
            this._emit('incoming', { files: files, totalSize: this.recvTotalSize });
        } else if (msg.type === 'file-start') {
            this._emit('file-start', { index: msg.index, name: msg.name, size: msg.size });
        } else if (msg.type === 'chunk') {
            const { index, chunkIndex } = msg;
            // Validate peer-supplied indices and payload before indexing/allocating.
            if (!this.receivedMeta || !Number.isInteger(index) || index < 0 || index >= this.recvBuffers.length) return;
            if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= this._recvMaxChunks[index]) return;
            let data = msg.data;
            if (data instanceof ArrayBuffer) data = new Uint8Array(data);
            if (!(data instanceof Uint8Array)) return;
            const prev = this.recvBuffers[index][chunkIndex];
            const delta = data.byteLength - (prev ? prev.byteLength : 0);
            // Never accept more bytes for a file than the sender declared (and the
            // user accepted) — blocks "declare 1 KB, stream gigabytes" memory DoS.
            if (this.recvReceived[index] + delta > this._recvFileLimit[index]) return;
            if (!this.recvStartAt) this.recvStartAt = Date.now();
            this.recvBuffers[index][chunkIndex] = data;
            this.recvReceived[index] += delta;
            const totalReceived = this.recvReceived.reduce((a, b) => a + b, 0);
            const totalSize     = this.recvTotalSize || this.receivedMeta.reduce((a, f) => a + f.size, 0);
            const elapsed       = Math.max(0.001, (Date.now() - this.recvStartAt) / 1000);
            const speed         = totalReceived / elapsed;
            this._emit('progress', {
                sent: totalReceived, total: totalSize,
                percent: totalSize ? Math.round(totalReceived / totalSize * 100) : 0,
                speed,
                remaining: Math.max(0, totalSize - totalReceived) / Math.max(speed, 1),
                fileIndex: index, fileName: this.receivedMeta[index] && this.receivedMeta[index].name,
            });
        } else if (msg.type === 'file-end') {
            const index = msg.index;
            if (!this.receivedMeta || !Number.isInteger(index) || index < 0 || index >= this.receivedMeta.length) return;
            try {
                const meta = this.receivedMeta[index];
                const blob = new Blob(this.recvBuffers[index], { type: meta.fileType || 'application/octet-stream' });
                const autoDownload = this._shouldAutoDownload(meta);
                const dl = this._download(blob, meta.name, autoDownload);
                // Release per-file chunks immediately to avoid mobile memory spikes.
                this.recvBuffers[index] = [];
                this._emit('file-ready', {
                    index: index,
                    name: meta.name,
                    size: meta.size,
                    url: dl.url,
                    autoDownloaded: dl.autoTriggered,
                });
                this._emit('file-done', { index: index, name: meta.name });
            } catch (err) {
                this._emit('error', { message: 'Échec de finalisation du fichier reçu (mémoire insuffisante).' });
            }
        } else if (msg.type === 'done') {
            this._transferDone = true;
            this._emit('complete', { role: 'receiver' });
        }
    }

    accept() { if (this.conn) this.conn.send({ type: 'accept' }); }
    reject()  { if (this.conn) this.conn.send({ type: 'reject' }); this.destroy(); }

    _shouldAutoDownload(meta) {
        // Defense in depth: the block-list is enforced sender-side, but a malicious
        // peer can run a modified client. Never SILENTLY auto-download a blocked /
        // executable type — route it through the manual (explicit click) path instead.
        if (NexTransfer.isBlocked(meta && meta.name, meta && meta.fileType)) return false;
        const ua = navigator.userAgent || '';
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
        const isVideo = !!(meta && meta.fileType && /^video\//i.test(meta.fileType));
        const size = meta && typeof meta.size === 'number' ? meta.size : 0;
        const heavy = size >= 20 * 1024 * 1024;
        return !(isMobile && (isVideo || heavy));
    }

    _download(blob, name, autoTrigger) {
        autoTrigger = autoTrigger !== false;
        const url = URL.createObjectURL(blob);
        this.pendingDownloadUrls.push(url);

        if (autoTrigger) {
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => this._revokeDownloadUrl(url), 120000);
        }

        return { url, autoTriggered: autoTrigger };
    }

    _revokeDownloadUrl(url) {
        try { URL.revokeObjectURL(url); } catch (_) {}
        this.pendingDownloadUrls = this.pendingDownloadUrls.filter(u => u !== url);
    }

    _startExpiry() {
        this._expiryStart = Date.now();
        this._expiryTimer = setInterval(() => {
            const elapsed = Date.now() - this._expiryStart;
            const pct  = Math.max(0, 100 - elapsed / EXPIRY_MS * 100);
            const left = Math.max(0, Math.ceil((EXPIRY_MS - elapsed) / 1000));
            this._emit('expiry', { percent: pct, secondsLeft: left });
            if (elapsed >= EXPIRY_MS) { this._emit('expired', {}); this.destroy(); }
        }, 1000);
    }

    _clearExpiry() { clearInterval(this._expiryTimer); this._expiryTimer = null; }

    _cfg() {
        return { config: { iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
        ]}};
    }

    _fmtErr(err) {
        const map = {
            'peer-unavailable': 'Code invalide ou expiré.',
            'network':          'Erreur réseau — vérifiez votre connexion.',
            'server-error':     'Serveur de signalisation indisponible.',
            'socket-error':     'Connexion WebSocket perdue.',
            'unavailable-id':   "Code déjà pris, génération d'un nouveau…",
        };
        return map[err.type] || err.message || 'Erreur inconnue.';
    }

    destroy() {
        this._clearExpiry();
        (this.pendingDownloadUrls || []).forEach(url => this._revokeDownloadUrl(url));
        try { if (this.conn) this.conn.close(); } catch(_) {}
        try { if (this.peer) this.peer.destroy(); } catch(_) {}
        this.conn = null; this.peer = null;
    }
}
