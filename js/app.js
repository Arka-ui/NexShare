/* NexShare — UI orchestration (no ES modules, works on file://) */

/* ── Star background ── */
new SpaceStars('star-canvas');

if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('sw.js').catch(function() {});
    });
}

/* ── Header scroll ── */
window.addEventListener('scroll', () => {
    document.querySelector('header').classList.toggle('scrolled', window.scrollY > 20);
});

/* ── Toast ── */
function toast(msg, type, duration) {
    type     = type     || 'info';
    duration = duration || 4000;
    var icons = { success: 'bi-check-circle-fill', error: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };
    var tc = document.getElementById('toast-container');
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    // Build via DOM + textContent so the message can never be parsed as HTML.
    var ic = document.createElement('i');
    ic.className = 'bi ' + (icons[type] || icons.info);
    var span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(ic);
    el.appendChild(span);
    tc.appendChild(el);
    setTimeout(function() {
        el.style.transition = 'all .3s ease';
        el.style.opacity    = '0';
        el.style.transform  = 'translateX(20px)';
        setTimeout(function() { el.remove(); }, 300);
    }, duration);
}

var diagKey = 'nexshare-diag-v1';
var diagnostics = { startedAt: new Date().toISOString(), events: [] };
try {
    var previous = localStorage.getItem(diagKey);
    if (previous) {
        var parsed = JSON.parse(previous);
        // Only adopt a well-formed value; otherwise keep the default so later
        // diagnostics.events.push() can never throw on a corrupted/foreign value.
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) diagnostics = parsed;
    }
} catch (_) {}

function pushDiag(level, message, data) {
    diagnostics.events.push({
        at: new Date().toISOString(),
        level: level,
        message: message,
        data: data || null,
    });
    if (diagnostics.events.length > 120) diagnostics.events = diagnostics.events.slice(-120);
    try { localStorage.setItem(diagKey, JSON.stringify(diagnostics)); } catch (_) {}
    if (debugPanel && !debugPanel.classList.contains('hidden')) renderDebugPanel();
}

window.addEventListener('error', function(e) {
    pushDiag('error', e.message || 'window-error', { source: e.filename, line: e.lineno, col: e.colno });
});

window.addEventListener('unhandledrejection', function(e) {
    pushDiag('error', 'unhandled-rejection', { reason: String(e.reason || '') });
});

var sessionBanner = document.getElementById('session-banner');
var sessionBadge = document.getElementById('session-badge');
var sessionText = document.getElementById('session-text');
var sessionHint = document.getElementById('session-hint');
var copyDiagBtn = document.getElementById('copy-diagnostics-btn');
var networkQuality = document.getElementById('network-quality');
var networkQualityLabel = networkQuality ? networkQuality.querySelector('.network-quality-label') : null;
var networkQualityInfo = document.getElementById('network-quality-info');
var compatToggle = document.getElementById('compat-mode-toggle');
var reconnectNowBtn = document.getElementById('reconnect-now-btn');
var sessionMenuBtn = document.getElementById('session-menu-btn');
var sessionMenuClose = document.getElementById('session-menu-close');
var sessionMenuPanel = document.getElementById('session-menu-panel');
var sessionMenuOverlay = document.getElementById('session-menu-overlay');
var debugPanel = document.getElementById('debug-panel');
var debugClose = document.getElementById('debug-close');
var debugSummary = document.getElementById('debug-summary');
var debugList = document.getElementById('debug-list');
var debugThroughputCanvas = document.getElementById('debug-throughput-chart');
var debugThroughputMeta = document.getElementById('debug-throughput-meta');
var debugCopy = document.getElementById('debug-copy');
var debugClear = document.getElementById('debug-clear');

var compatModeEnabled = localStorage.getItem('nexshare-compat-mode') === '1';
var reconnectNowCallback = null;
var throughputSamples = [];

function bytesPerSecLabel(v) {
    return NexTransfer.formatBytes(v || 0) + '/s';
}

function explainNetworkProfile(profile) {
    if (!profile) return 'Qualité réseau détectée automatiquement.';
    var reasons = [];
    if (profile.compatibilityMode) reasons.push('Mode compatibilité activé manuellement');
    if (profile.saveData) reasons.push('Option économie de données active');
    if (profile.effectiveType && /2g|3g/.test(profile.effectiveType)) reasons.push('Type de réseau ' + profile.effectiveType);
    if (typeof profile.downlink === 'number' && profile.downlink > 0 && profile.downlink < 2) reasons.push('Débit descendant faible (' + profile.downlink + ' Mbps)');
    if (typeof profile.memory === 'number' && profile.memory <= 2) reasons.push('Mémoire appareil limitée (' + profile.memory + ' Go)');
    return reasons.length ? reasons.join(' · ') : 'Profil réseau standard.';
}

function pushThroughputSample(speed) {
    var now = Date.now();
    var sec = Math.floor(now / 1000);
    if (throughputSamples.length && throughputSamples[throughputSamples.length - 1].sec === sec) {
        throughputSamples[throughputSamples.length - 1].speed = speed || 0;
    } else {
        throughputSamples.push({ sec: sec, speed: speed || 0 });
    }
    var minSec = sec - 29;
    throughputSamples = throughputSamples.filter(function(p) { return p.sec >= minSec; });
    if (debugPanel && !debugPanel.classList.contains('hidden')) renderThroughputChart();
}

function renderThroughputChart() {
    if (!debugThroughputCanvas) return;
    var ctx = debugThroughputCanvas.getContext('2d');
    var rect = debugThroughputCanvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var width = Math.max(220, Math.round(rect.width));
    var height = Math.max(80, Math.round(rect.height));
    debugThroughputCanvas.width = Math.round(width * dpr);
    debugThroughputCanvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    var nowSec = Math.floor(Date.now() / 1000);
    var values = [];
    for (var i = 29; i >= 0; i--) {
        var sec = nowSec - i;
        var found = throughputSamples.find(function(p) { return p.sec === sec; });
        values.push(found ? found.speed : 0);
    }

    var peak = values.reduce(function(m, v) { return Math.max(m, v); }, 0);
    var current = values[values.length - 1] || 0;
    if (debugThroughputMeta) {
        debugThroughputMeta.textContent = 'Actuel ' + bytesPerSecLabel(current) + ' · Pic ' + bytesPerSecLabel(peak);
    }

    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    for (var g = 1; g <= 3; g++) {
        var gy = Math.round((height / 4) * g) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
    }

    if (!peak) return;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(6,182,212,.95)';
    ctx.beginPath();
    for (var j = 0; j < values.length; j++) {
        var x = (j / (values.length - 1)) * width;
        var y = height - (values[j] / peak) * (height - 8) - 4;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function showReconnectNowButton(onClick) {
    reconnectNowCallback = onClick || null;
    if (!reconnectNowBtn) return;
    reconnectNowBtn.classList.toggle('hidden', !reconnectNowCallback);
}

function setNetworkQualityIndicator(profile) {
    if (!networkQuality || !networkQualityLabel) return;
    var quality = (profile && profile.quality) || 'medium';
    var text = quality === 'good' ? 'bon' : quality === 'low' ? 'faible' : 'moyen';
    if (profile && profile.compatibilityMode) text = 'compatibilité';
    networkQuality.classList.remove('quality-low', 'quality-medium', 'quality-good');
    networkQuality.classList.add(quality === 'good' ? 'quality-good' : quality === 'low' ? 'quality-low' : 'quality-medium');
    networkQualityLabel.textContent = 'Réseau: ' + text;
    if (networkQualityInfo) {
        var reason = explainNetworkProfile(profile);
        networkQualityInfo.title = reason;
        networkQualityInfo.classList.toggle('hidden', quality !== 'low' && !profile.compatibilityMode);
    }
}

function renderDebugPanel() {
    if (!debugList || !debugSummary) return;
    var events = diagnostics.events || [];
    debugSummary.textContent = events.length
        ? events.length + ' événement(s) enregistrés.'
        : 'Aucun événement enregistré.';
    debugList.innerHTML = events.slice().reverse().map(function(ev) {
        var meta = ev.data ? Object.keys(ev.data).map(function(k) {
            return k + ': ' + String(ev.data[k]);
        }).join(' · ') : '';
        return '<article class="debug-row">' +
            '<div class="debug-row-top">' +
                '<span>' + new Date(ev.at).toLocaleTimeString('fr-FR') + '</span>' +
                '<span class="debug-level ' + esc(ev.level) + '">' + esc(ev.level) + '</span>' +
            '</div>' +
            '<div class="debug-msg">' + esc(ev.message) + '</div>' +
            (meta ? '<div class="debug-meta">' + esc(meta) + '</div>' : '') +
        '</article>';
    }).join('');
}

function openDebugPanel() {
    if (!debugPanel) return;
    renderDebugPanel();
    renderThroughputChart();
    debugPanel.classList.remove('hidden');
    debugPanel.setAttribute('aria-hidden', 'false');
}

function closeDebugPanel() {
    if (!debugPanel) return;
    debugPanel.classList.add('hidden');
    debugPanel.setAttribute('aria-hidden', 'true');
}

function openSessionMenu() {
    if (!sessionMenuPanel || !sessionMenuOverlay) return;
    sessionMenuPanel.classList.remove('hidden');
    sessionMenuOverlay.classList.remove('hidden');
    sessionMenuPanel.setAttribute('aria-hidden', 'false');
    sessionMenuOverlay.setAttribute('aria-hidden', 'false');
}

function closeSessionMenu() {
    if (!sessionMenuPanel || !sessionMenuOverlay) return;
    sessionMenuPanel.classList.add('hidden');
    sessionMenuOverlay.classList.add('hidden');
    sessionMenuPanel.setAttribute('aria-hidden', 'true');
    sessionMenuOverlay.setAttribute('aria-hidden', 'true');
}

function setSessionBanner(state, badge, text, hint) {
    if (!sessionBanner) return;
    sessionBanner.className = 'session-banner state-' + state;
    if (sessionBadge) sessionBadge.textContent = badge;
    if (sessionText) sessionText.textContent = text;
    if (sessionHint) sessionHint.textContent = hint || '';
}

if (copyDiagBtn) copyDiagBtn.addEventListener('click', openDebugPanel);
if (sessionMenuBtn) sessionMenuBtn.addEventListener('click', openSessionMenu);
if (sessionMenuClose) sessionMenuClose.addEventListener('click', closeSessionMenu);
if (sessionMenuOverlay) sessionMenuOverlay.addEventListener('click', closeSessionMenu);
if (debugClose) debugClose.addEventListener('click', closeDebugPanel);
if (debugPanel) {
    debugPanel.addEventListener('click', function(e) {
        if (e.target === debugPanel) closeDebugPanel();
    });
}
window.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeDebugPanel();
    if (e.key === 'Escape') closeSessionMenu();
});
if (debugCopy) {
    debugCopy.addEventListener('click', function() {
        var payload = {
            app: 'NexShare',
            userAgent: navigator.userAgent,
            href: location.href,
            online: navigator.onLine,
            compatibilityMode: compatModeEnabled,
            diagnostics: diagnostics,
        };
        copyToClipboard(JSON.stringify(payload, null, 2)).then(function() {
            toast('Diagnostics copiés.', 'success');
        });
    });
}
if (reconnectNowBtn) {
    reconnectNowBtn.addEventListener('click', function() {
        if (typeof reconnectNowCallback === 'function') reconnectNowCallback();
    });
}
if (debugClear) {
    debugClear.addEventListener('click', function() {
        diagnostics.events = [];
        throughputSamples = [];
        try { localStorage.setItem(diagKey, JSON.stringify(diagnostics)); } catch (_) {}
        renderDebugPanel();
        renderThroughputChart();
        toast('Diagnostics vidés.', 'info');
    });
}

if (compatToggle) {
    compatToggle.checked = compatModeEnabled;
    compatToggle.addEventListener('change', function() {
        compatModeEnabled = !!compatToggle.checked;
        localStorage.setItem('nexshare-compat-mode', compatModeEnabled ? '1' : '0');
        pushDiag('info', 'compat-mode', { enabled: compatModeEnabled });
        toast(compatModeEnabled ? 'Mode compatibilité activé.' : 'Mode compatibilité désactivé.', 'info');
        setNetworkQualityIndicator({ quality: compatModeEnabled ? 'low' : 'medium', compatibilityMode: compatModeEnabled });
    });
}
if (networkQualityInfo) {
    networkQualityInfo.addEventListener('click', function() {
        toast(networkQualityInfo.title || 'Qualité réseau détectée automatiquement.', 'info', 5000);
    });
}

/* ── File icon ── */
function fileIcon(name) {
    var ext = (String(name == null ? '' : name).split('.').pop() || '').toLowerCase();
    if (['jpg','jpeg','png','gif','webp','svg','avif'].indexOf(ext) > -1) return 'bi-file-image';
    if (['mp4','mov','avi','mkv','webm'].indexOf(ext) > -1)               return 'bi-file-play';
    if (['mp3','ogg','flac','wav','aac'].indexOf(ext) > -1)               return 'bi-file-music';
    if (ext === 'pdf')                                                     return 'bi-file-pdf';
    if (['zip','rar','7z','tar','gz','bz2'].indexOf(ext) > -1)            return 'bi-file-zip';
    if (['js','ts','py','go','rs','c','cpp','java','html','css'].indexOf(ext) > -1) return 'bi-file-code';
    if (['doc','docx','odt'].indexOf(ext) > -1)                            return 'bi-file-word';
    if (['xls','xlsx','csv'].indexOf(ext) > -1)                            return 'bi-file-excel';
    return 'bi-file-earmark';
}

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
}

function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    // Fallback for file://
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch(_) {}
    document.body.removeChild(ta);
    return Promise.resolve();
}

/* ══════════════════════════════════════════
 *  SENDER PANEL
 * ══════════════════════════════════════════ */
var dropZone   = document.getElementById('drop-zone');
var fileInput  = document.getElementById('file-input');
var fileListEl = document.getElementById('file-list');
var fileFooter = document.getElementById('file-footer');
var fileCount  = document.getElementById('file-count');
var sendBtn    = document.getElementById('send-btn');
var clearBtn   = document.getElementById('clear-btn');
var sharePanel = document.getElementById('share-panel');
var sharePanelBody = document.getElementById('share-panel-body');
var sharePanelDone = document.getElementById('share-panel-done');
var senderCard = document.querySelector('.sender-card');
var senderFingerprint = document.getElementById('session-fingerprint');
var sendTransferStats = document.getElementById('send-transfer-stats');
var sendTransferPercent = document.getElementById('send-transfer-percent');
var sendTransferSpeed = document.getElementById('send-transfer-speed');
var sendTransferEta = document.getElementById('send-transfer-eta');
var recvFingerprint = document.getElementById('recv-fingerprint');
var transferSection = document.querySelector('.transfer-section');
var tabSend = document.getElementById('tab-send');
var tabReceive = document.getElementById('tab-receive');

var selectedFiles = [];
var senderXfer    = null;
var senderAutoResetTimer = null;
var recvAutoResetTimer = null;
var recvReconnectTimer = null;
var recvReconnectAttempts = 0;
var lastReceiverCode = '';

function clearSenderAutoReset() {
    if (senderAutoResetTimer) {
        clearTimeout(senderAutoResetTimer);
        senderAutoResetTimer = null;
    }
}

function clearReceiverAutoReset() {
    if (recvAutoResetTimer) {
        clearTimeout(recvAutoResetTimer);
        recvAutoResetTimer = null;
    }
}

function resetSenderTransferStats() {
    if (!sendTransferStats) return;
    sendTransferStats.classList.add('hidden');
    if (sendTransferPercent) sendTransferPercent.textContent = '0%';
    if (sendTransferSpeed) sendTransferSpeed.textContent = '0 B/s';
    if (sendTransferEta) sendTransferEta.textContent = 'ETA --:--';
}

function updateSenderTransferStats(d) {
    if (!sendTransferStats) return;
    sendTransferStats.classList.remove('hidden');
    if (sendTransferPercent) sendTransferPercent.textContent = (d.percent || 0) + '%';
    if (sendTransferSpeed) sendTransferSpeed.textContent = NexTransfer.formatBytes(d.speed || 0) + '/s';
    if (sendTransferEta) sendTransferEta.textContent = 'ETA ' + NexTransfer.formatTime(d.remaining);
}

/* Drag & drop */
dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', function()  { dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', function(e) {
    e.preventDefault(); dropZone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', function() {
    addFiles(fileInput.files);
    fileInput.value = '';
});

function fingerprintForCode(code) {
    var src = String(code || '').toUpperCase();
    var h = 2166136261;
    for (var i = 0; i < src.length; i++) {
        h ^= src.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    var out = (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
    return out.slice(0, 4) + ' ' + out.slice(4, 8);
}

function updateFingerprints(code) {
    var fp = code ? fingerprintForCode(code) : '---- ----';
    if (senderFingerprint) senderFingerprint.textContent = 'Empreinte session: ' + fp;
    if (recvFingerprint) {
        recvFingerprint.textContent = 'Empreinte session: ' + fp;
        recvFingerprint.classList.toggle('hidden', !code);
    }
}

function setMobilePanel(panel) {
    if (!transferSection) return;
    transferSection.classList.remove('mobile-send', 'mobile-receive');
    transferSection.classList.add(panel === 'receive' ? 'mobile-receive' : 'mobile-send');
    if (tabSend && tabReceive) {
        var sendActive = panel !== 'receive';
        tabSend.classList.toggle('active', sendActive);
        tabReceive.classList.toggle('active', !sendActive);
        tabSend.setAttribute('aria-selected', sendActive ? 'true' : 'false');
        tabReceive.setAttribute('aria-selected', sendActive ? 'false' : 'true');
    }
}

if (tabSend) tabSend.addEventListener('click', function() { setMobilePanel('send'); });
if (tabReceive) tabReceive.addEventListener('click', function() { setMobilePanel('receive'); });

setMobilePanel('send');
setSessionBanner('idle', 'Inactif', 'Prêt à lancer un transfert.', 'Choisissez Envoyer ou Recevoir.');
setNetworkQualityIndicator({ quality: compatModeEnabled ? 'low' : 'medium', compatibilityMode: compatModeEnabled });
showReconnectNowButton(null);

function addFiles(list) {
    var incoming = Array.from(list);
    var errors   = NexTransfer.validateFiles(incoming);
    if (errors.length) { errors.forEach(function(m) { toast(m, 'error', 6000); }); return; }
    incoming.forEach(function(f) {
        if (!selectedFiles.find(function(x) { return x.name === f.name && x.size === f.size; }))
            selectedFiles.push(f);
    });
    renderFileList();
}

function renderFileList() {
    fileListEl.innerHTML = '';
    selectedFiles.forEach(function(f, i) {
        var div = document.createElement('div');
        div.className = 'file-item';
        div.innerHTML =
            '<i class="bi ' + fileIcon(f.name) + ' file-icon"></i>' +
            '<div class="file-info">' +
                '<div class="file-name">' + esc(f.name) + '</div>' +
                '<div class="file-size">' + NexTransfer.formatBytes(f.size) + '</div>' +
            '</div>' +
            '<button class="file-remove" data-i="' + i + '" title="Retirer"><i class="bi bi-x"></i></button>';
        fileListEl.appendChild(div);
    });

    var has = selectedFiles.length > 0;
    fileListEl.classList.toggle('hidden', !has);
    fileFooter.classList.toggle('hidden', !has);
    dropZone.classList.toggle('has-files', has);
    if (!has) sharePanel.classList.add('hidden');

    if (has) {
        var total = selectedFiles.reduce(function(s, f) { return s + f.size; }, 0);
        fileCount.textContent = selectedFiles.length + ' fichier' + (selectedFiles.length > 1 ? 's' : '') + ' · ' + NexTransfer.formatBytes(total);
        setSessionBanner('idle', 'Prêt', 'Fichiers prêts à être envoyés.', 'Générez un code puis partagez le lien/QR.');
    } else {
        setSessionBanner('idle', 'Inactif', 'Aucun transfert actif.', 'Déposez des fichiers pour commencer.');
    }
    showReconnectNowButton(null);
}

fileListEl.addEventListener('click', function(e) {
    var btn = e.target.closest('.file-remove');
    if (!btn) return;
    selectedFiles.splice(parseInt(btn.dataset.i), 1);
    renderFileList();
});

clearBtn.addEventListener('click', function() {
    clearSenderAutoReset();
    resetSenderTransferStats();
    selectedFiles = [];
    if (senderXfer) { senderXfer.destroy(); senderXfer = null; }
    senderCard.classList.remove('transfer-mode');
    sharePanel.classList.add('hidden');
    sharePanelBody.classList.remove('hidden');
    sharePanelDone.classList.add('hidden');
    sharePanelDone.innerHTML = '';
    updateFingerprints('');
    pushDiag('info', 'sender-clear');
    renderFileList();
});

sendBtn.addEventListener('click', function() {
    if (!selectedFiles.length) { toast('Ajoutez au moins un fichier.', 'error'); return; }
    clearSenderAutoReset();
    if (senderXfer) { senderXfer.destroy(); }
    pushDiag('info', 'sender-init', { fileCount: selectedFiles.length });
    senderXfer = buildSender(selectedFiles);
    senderXfer.initSender(selectedFiles);
});

function buildSender(files) {
    var xfer = new NexTransfer({ compatibilityMode: compatModeEnabled });

    xfer.addEventListener('code', function(e) {
        var code = e.detail.code;
        resetSenderTransferStats();
        sharePanelDone.classList.add('hidden');
        sharePanelBody.classList.remove('hidden');
        document.getElementById('share-code').textContent = code;
        updateFingerprints(code);
        sharePanel.classList.remove('hidden');
        senderCard.classList.add('transfer-mode');
        senderCard.setAttribute('aria-busy', 'true');
        setSessionBanner('waiting', 'Code actif', 'Session créée, en attente du destinataire.', 'Partagez le lien ou le QR puis laissez cet écran ouvert.');
        setStatus('waiting', 'En attente de connexion…');
        pushDiag('info', 'sender-code', { code: code });

        var shareUrl = location.origin + location.pathname + '?code=' + code;
        var canvas = document.getElementById('qr-canvas');
        if (typeof QRCode !== 'undefined') {
            QRCode.toCanvas(canvas, shareUrl, { width: 150, margin: 4,
                color: { dark: '#e2d9f3', light: '#03001400' } }, function() {});
        }

        updateExpiry(100);
        toast('Code généré ! Partagez-le avec le destinataire.', 'info');
    });

    xfer.addEventListener('status', function(e) {
        var s = e.detail.state, m = e.detail.message;
        setStatus(s === 'connected' ? 'connected' : s === 'rejected' ? 'error' : 'waiting', m);
        if (s === 'connected') {
            setSessionBanner('connected', 'Connecté', 'Destinataire connecté.', 'Le transfert démarre après acceptation.');
            showReconnectNowButton(null);
        }
        if (s === 'disconnected') {
            setSessionBanner('error', 'Reconnexion', 'Connexion interrompue.', 'Le destinataire peut se reconnecter avec le même lien.');
            showReconnectNowButton(null);
        }
        if (s === 'connected') toast('Pair connecté !', 'success');
        if (s === 'rejected')  toast('Transfert refusé.', 'error');
        pushDiag('info', 'sender-status', { state: s, message: m });
    });

    xfer.addEventListener('network-profile', function(e) {
        var profile = e.detail || {};
        setNetworkQualityIndicator(profile);
        pushDiag('info', 'network-profile', profile);
    });

    xfer.addEventListener('transfer-start', function() {
        senderCard.classList.add('transfer-mode');
        setStatus('transfer', 'Transfert en cours…');
        setSessionBanner('transfer', 'Transfert', 'Envoi en cours…', 'Gardez les deux appareils actifs.');
        updateSenderTransferStats({ percent: 0, speed: 0, remaining: 0 });
        if (window.matchMedia('(min-width: 769px)').matches) {
            openProgress('Envoi en cours…', files.map(function(f) { return { name: f.name, size: f.size }; }));
        }
    });

    xfer.addEventListener('file-start', function(e) { markPF(e.detail.index, 'active'); });
    xfer.addEventListener('file-done',  function(e) { markPF(e.detail.index, 'done'); });
    xfer.addEventListener('progress',   function(e) {
        updateProgress(e.detail);
        updateSenderTransferStats(e.detail);
    });

    xfer.addEventListener('complete', function() {
        closeProgress();
        toast('Transfert terminé !', 'success');
        clearSenderAutoReset();
        senderCard.classList.add('transfer-mode');
        senderCard.setAttribute('aria-busy', 'false');
        sharePanelBody.classList.add('hidden');
        sharePanelDone.classList.remove('hidden');
        setSessionBanner('connected', 'Terminé', 'Transfert terminé avec succès.', 'Vous pouvez relancer un nouveau transfert.');
        showReconnectNowButton(null);
        pushDiag('info', 'sender-complete');

        var doneHandled = false;
        function resetSenderAfterDone() {
            if (doneHandled) return;
            doneHandled = true;
            clearSenderAutoReset();
            selectedFiles = [];
            renderFileList();
            resetSenderTransferStats();
            senderCard.classList.remove('transfer-mode');
            sharePanel.classList.add('hidden');
            sharePanelBody.classList.remove('hidden');
            sharePanelDone.classList.add('hidden');
            sharePanelDone.innerHTML = '';
            updateFingerprints('');
            senderXfer = null;
        }

        sharePanelDone.innerHTML = doneBanner('Transfert réussi !', 'Tous les fichiers ont été envoyés.', function() {
            resetSenderAfterDone();
        });

        senderAutoResetTimer = setTimeout(function() {
            resetSenderAfterDone();
        }, 2400);
    });

    xfer.addEventListener('expiry', function(e) { updateExpiry(e.detail.percent, e.detail.secondsLeft); });

    xfer.addEventListener('expired', function() {
        clearSenderAutoReset();
        resetSenderTransferStats();
        toast('Session expirée (30 min). Regénérez un code.', 'error', 6000);
        senderCard.classList.remove('transfer-mode');
        senderCard.setAttribute('aria-busy', 'false');
        sharePanelBody.classList.remove('hidden');
        sharePanelDone.classList.add('hidden');
        sharePanelDone.innerHTML = '';
        sharePanel.classList.add('hidden');
        updateFingerprints('');
        setSessionBanner('error', 'Expiré', 'Session expirée.', 'Générez un nouveau code pour recommencer.');
        showReconnectNowButton(null);
        pushDiag('warn', 'sender-expired');
        selectedFiles = []; renderFileList(); senderXfer = null;
    });

    xfer.addEventListener('error', function(e) {
        resetSenderTransferStats();
        toast(e.detail.message, 'error', 6000);
        setSessionBanner('error', 'Erreur', e.detail.message, 'Consultez les diagnostics si le problème persiste.');
        pushDiag('error', 'sender-error', { message: e.detail.message });
    });

    return xfer;
}

document.getElementById('copy-link-btn').addEventListener('click', function() {
    var code = document.getElementById('share-code').textContent;
    var url  = location.origin + location.pathname + '?code=' + code;
    copyToClipboard(url).then(function() { toast('Lien copié !', 'success'); });
});

document.getElementById('copy-code-btn').addEventListener('click', function() {
    var code = document.getElementById('share-code').textContent;
    copyToClipboard(code).then(function() { toast('Code copié !', 'success'); });
});

/* ══════════════════════════════════════════
 *  RECEIVER PANEL
 * ══════════════════════════════════════════ */
var codeInput  = document.getElementById('code-input');
var connectBtn = document.getElementById('connect-btn');
var recvArea   = document.getElementById('recv-area');
var recvTransferStats = document.getElementById('recv-transfer-stats');
var recvTransferPercent = document.getElementById('recv-transfer-percent');
var recvTransferSpeed = document.getElementById('recv-transfer-speed');
var recvTransferEta = document.getElementById('recv-transfer-eta');
var recvXfer   = null;
var receiverPendingDownloads = [];

function resetReceiverTransferStats() {
    if (!recvTransferStats) return;
    recvTransferStats.classList.add('hidden');
    if (recvTransferPercent) recvTransferPercent.textContent = '0%';
    if (recvTransferSpeed) recvTransferSpeed.textContent = '0 B/s';
    if (recvTransferEta) recvTransferEta.textContent = 'ETA --:--';
}

function showReceiverTransferStats() {
    if (!recvTransferStats) return;
    recvTransferStats.classList.remove('hidden');
}

function updateReceiverTransferStats(d) {
    if (!recvTransferStats) return;
    showReceiverTransferStats();
    if (recvTransferPercent) recvTransferPercent.textContent = (d.percent || 0) + '%';
    if (recvTransferSpeed) recvTransferSpeed.textContent = NexTransfer.formatBytes(d.speed || 0) + '/s';
    if (recvTransferEta) recvTransferEta.textContent = 'ETA ' + NexTransfer.formatTime(d.remaining);
}

resetReceiverTransferStats();

connectBtn.addEventListener('click', startReceiver);
codeInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') startReceiver(); });
codeInput.addEventListener('input', function() {
    updateFingerprints(codeInput.value.trim().toUpperCase());
});

function startReceiver() {
    var raw = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.length !== 6) { toast('Le code doit contenir 6 caractères.', 'error'); return; }
    clearReceiverAutoReset();
    resetReceiverTransferStats();
    receiverPendingDownloads = [];
    lastReceiverCode = raw;
    if (recvReconnectTimer) {
        clearTimeout(recvReconnectTimer);
        recvReconnectTimer = null;
    }
    showReconnectNowButton(null);
    if (recvXfer) { recvXfer.destroy(); }
    setSessionBanner('waiting', 'Connexion', 'Tentative de connexion au pair…', 'Attendez la liste des fichiers entrants.');
    pushDiag('info', 'receiver-init', { code: raw });
    recvXfer = buildReceiver();
    recvXfer.initReceiver(raw);
}

function buildReceiver() {
    var xfer = new NexTransfer({ compatibilityMode: compatModeEnabled });

    showRecvUI('<div class="spinner"></div><div class="text-muted" style="text-align:center;margin-top:.5rem">Connexion…</div>');

    xfer.addEventListener('incoming', function(e) {
        var files = e.detail.files, totalSize = e.detail.totalSize;
        recvReconnectAttempts = 0;
        setSessionBanner('connected', 'Entrant', 'Demande de transfert reçue.', 'Acceptez ou refusez les fichiers.');
        var listHtml = files.map(function(f) {
            return '<div class="file-item">' +
                '<i class="bi ' + fileIcon(f.name) + ' file-icon"></i>' +
                '<div class="file-info">' +
                    '<div class="file-name">' + esc(f.name) + '</div>' +
                    '<div class="file-size">' + NexTransfer.formatBytes(f.size) + '</div>' +
                '</div></div>';
        }).join('');

        showRecvUI(
            '<div class="incoming-label">Fichiers entrants</div>' +
            '<div class="file-list" style="max-height:200px">' + listHtml + '</div>' +
            '<div class="incoming-total">' + files.length + ' fichier' + (files.length > 1 ? 's' : '') + ' · ' + NexTransfer.formatBytes(totalSize) + '</div>' +
            '<div class="incoming-actions">' +
                '<button class="btn btn-primary" id="accept-btn"><i class="bi bi-download"></i> Accepter</button>' +
                '<button class="btn btn-danger"  id="decline-btn"><i class="bi bi-x-lg"></i> Refuser</button>' +
            '</div>'
        );

        document.getElementById('accept-btn').addEventListener('click', function() {
            xfer.accept();
            showReceiverTransferStats();
            updateReceiverTransferStats({ percent: 0, speed: 0, remaining: 0 });

            var transferListHtml = files.map(function(f) {
                return '<div class="file-item">' +
                    '<i class="bi ' + fileIcon(f.name) + ' file-icon"></i>' +
                    '<div class="file-info">' +
                        '<div class="file-name">' + esc(f.name) + '</div>' +
                        '<div class="file-size">' + NexTransfer.formatBytes(f.size) + '</div>' +
                    '</div></div>';
            }).join('');

            showRecvUI(
                '<div class="incoming-label">Réception en cours</div>' +
                '<div class="file-list" style="max-height:200px">' + transferListHtml + '</div>' +
                '<div class="incoming-total">' + files.length + ' fichier' + (files.length > 1 ? 's' : '') + ' · ' + NexTransfer.formatBytes(totalSize) + '</div>' +
                '<div class="recv-inline-stats" aria-live="polite">' +
                    '<span id="recv-popup-percent" class="recv-transfer-pill">0%</span>' +
                    '<span id="recv-popup-speed">0 B/s</span>' +
                    '<span id="recv-popup-eta">ETA --:--</span>' +
                '</div>'
            );

            setSessionBanner('transfer', 'Réception', 'Réception en cours…', 'Laissez la page ouverte jusqu à la fin.');
            if (window.matchMedia('(min-width: 769px)').matches) {
                openProgress('Réception en cours…', files);
            }
        });
        document.getElementById('decline-btn').addEventListener('click', function() {
            xfer.reject(); showRecvUI('');
            if (recvXfer) { recvXfer.destroy(); recvXfer = null; }
            resetReceiverTransferStats();
            toast('Transfert refusé.', 'info');
            setSessionBanner('idle', 'Inactif', 'Transfert refusé.', 'Vous pouvez entrer un autre code.');
        });
    });

    xfer.addEventListener('status', function(e) {
        var state = e.detail && e.detail.state;
        if (state === 'connecting') {
            setSessionBanner('waiting', 'Connexion', 'Connexion en cours…', 'Vérification du code et du pair.');
        }
        if (state === 'connected') {
            setSessionBanner('connected', 'Connecté', 'Connecté au pair expéditeur.', 'Attente de la liste des fichiers.');
            recvReconnectAttempts = 0;
            showReconnectNowButton(null);
        }
        if (state === 'disconnected' && !xfer._transferDone) {
            recvReconnectAttempts += 1;
            if (recvReconnectAttempts <= 4) {
                var delay = Math.min(8000, 1000 * Math.pow(2, recvReconnectAttempts));
                setSessionBanner('error', 'Reconnexion', 'Connexion perdue, nouvelle tentative…', 'Tentative ' + recvReconnectAttempts + '/4 dans ' + Math.round(delay / 1000) + 's.');
                toast('Reconnexion automatique…', 'info', 2500);
                showReconnectNowButton(function() {
                    if (recvReconnectTimer) {
                        clearTimeout(recvReconnectTimer);
                        recvReconnectTimer = null;
                    }
                    if (lastReceiverCode) {
                        codeInput.value = lastReceiverCode;
                        startReceiver();
                    }
                });
                recvReconnectTimer = setTimeout(function() {
                    if (lastReceiverCode) {
                        codeInput.value = lastReceiverCode;
                        startReceiver();
                    }
                }, delay);
            } else {
                setSessionBanner('error', 'Échec', 'Impossible de reconnecter automatiquement.', 'Relancez manuellement la connexion.');
                showReconnectNowButton(function() {
                    if (lastReceiverCode) {
                        codeInput.value = lastReceiverCode;
                        startReceiver();
                    }
                });
            }
        }
        pushDiag('info', 'receiver-status', { state: state, message: e.detail && e.detail.message });
    });

    xfer.addEventListener('network-profile', function(e) {
        var profile = e.detail || {};
        setNetworkQualityIndicator(profile);
        pushDiag('info', 'receiver-network-profile', profile);
    });

    xfer.addEventListener('file-ready', function(e) {
        var info = e.detail || {};
        if (!info.autoDownloaded && info.url) {
            receiverPendingDownloads.push({
                name: info.name || 'fichier',
                url: info.url,
                size: info.size || 0,
            });
            pushDiag('warn', 'receiver-manual-download-required', {
                name: info.name,
                size: info.size || 0,
            });
        }
    });

    xfer.addEventListener('file-start', function(e) { markPF(e.detail.index, 'active'); });
    xfer.addEventListener('file-done',  function(e) { markPF(e.detail.index, 'done'); });
    xfer.addEventListener('progress',   function(e) {
        updateProgress(e.detail);
        updateReceiverTransferStats(e.detail);

        var recvPopupPercent = document.getElementById('recv-popup-percent');
        var recvPopupSpeed = document.getElementById('recv-popup-speed');
        var recvPopupEta = document.getElementById('recv-popup-eta');
        if (recvPopupPercent) recvPopupPercent.textContent = (e.detail.percent || 0) + '%';
        if (recvPopupSpeed) recvPopupSpeed.textContent = NexTransfer.formatBytes(e.detail.speed || 0) + '/s';
        if (recvPopupEta) recvPopupEta.textContent = 'ETA ' + NexTransfer.formatTime(e.detail.remaining);
    });

    xfer.addEventListener('complete', function() {
        closeProgress();
        toast('Fichiers reçus !', 'success');
        clearReceiverAutoReset();
        if (recvReconnectTimer) {
            clearTimeout(recvReconnectTimer);
            recvReconnectTimer = null;
        }
        recvReconnectAttempts = 0;
        showReconnectNowButton(null);
        var manualMode = receiverPendingDownloads.length > 0;
        setSessionBanner('connected', 'Terminé', manualMode ? 'Réception terminée.' : 'Réception terminée.', manualMode ? 'Touchez pour télécharger les fichiers.' : 'Les téléchargements ont démarré.');
        pushDiag('info', 'receiver-complete');

        var doneHandled = false;
        function resetReceiverAfterDone() {
            if (doneHandled) return;
            doneHandled = true;
            clearReceiverAutoReset();
            showRecvUI('');
            resetReceiverTransferStats();
            codeInput.value = '';
            if (recvXfer) { recvXfer.destroy(); recvXfer = null; }
            receiverPendingDownloads = [];
            updateFingerprints('');
            setSessionBanner('idle', 'Inactif', 'Aucun transfert actif.', 'Entrez un code pour recevoir des fichiers.');
        }

        if (manualMode) {
            var linksHtml = receiverPendingDownloads.map(function(file, idx) {
                return '<a class="btn btn-secondary manual-dl-link" href="' + esc(file.url) + '" download="' + esc(file.name) + '" data-i="' + idx + '"><i class="bi bi-download"></i> ' + esc(file.name) + ' · ' + NexTransfer.formatBytes(file.size) + '</a>';
            }).join('');

            showRecvUI(
                '<div style="text-align:center;padding:.5rem 0">' +
                    '<i class="bi bi-check-circle-fill done-icon"></i>' +
                    '<div class="done-title">Fichiers prêts</div>' +
                    '<div class="done-sub">Le navigateur mobile a désactivé le téléchargement automatique. Touchez chaque fichier ci-dessous.</div>' +
                    '<div class="manual-dl-list">' + linksHtml + '</div>' +
                    '<button class="btn btn-secondary mt-sm" id="recv-done-reset"><i class="bi bi-arrow-clockwise"></i> Terminer</button>' +
                '</div>'
            );

            var resetBtn = document.getElementById('recv-done-reset');
            if (resetBtn) resetBtn.addEventListener('click', resetReceiverAfterDone);
            return;
        }

        showRecvUI(doneBanner('Fichiers reçus !', 'Les téléchargements ont démarré.', function() {
            resetReceiverAfterDone();
        }, "Recevoir d'autres fichiers"));

        recvAutoResetTimer = setTimeout(function() {
            resetReceiverAfterDone();
        }, 2400);
    });

    xfer.addEventListener('error', function(e) {
        clearReceiverAutoReset();
        toast(e.detail.message, 'error', 6000);
        showRecvUI('');
        resetReceiverTransferStats();
        if (recvXfer) { recvXfer.destroy(); recvXfer = null; }
        setSessionBanner('error', 'Erreur', e.detail.message, 'Vérifiez le code puis réessayez.');
        showReconnectNowButton(null);
        pushDiag('error', 'receiver-error', { message: e.detail.message });
    });

    return xfer;
}

function showRecvUI(html) {
    recvArea.innerHTML = html ? '<div class="incoming-card">' + html + '</div>' : '';
}

/* ══════════════════════════════════════════
 *  PROGRESS OVERLAY
 * ══════════════════════════════════════════ */
var overlay    = document.getElementById('progress-overlay');
var pBar       = document.getElementById('progress-bar');
var pPct       = document.getElementById('progress-pct');
var pSpeed     = document.getElementById('progress-speed');
var pEta       = document.getElementById('progress-eta');
var pTitle     = document.getElementById('progress-title');
var pFilesList = document.getElementById('progress-files');

function openProgress(title, files) {
    pTitle.textContent  = title;
    pBar.style.width    = '0%';
    pPct.textContent    = '0%';
    pSpeed.textContent  = '0 B/s';
    pEta.textContent    = '--:--';
    pFilesList.innerHTML = (files || []).map(function(f, i) {
        return '<div class="prog-file-row" id="pf-' + i + '">' +
            '<i class="bi ' + fileIcon(f.name || '') + '"></i>' +
            '<span>' + esc(f.name || '') + '</span></div>';
    }).join('');
    overlay.classList.remove('hidden');
}

function updateProgress(d) {
    pBar.style.width   = (d.percent || 0) + '%';
    pPct.textContent   = (d.percent || 0) + '%';
    pSpeed.textContent = NexTransfer.formatBytes(d.speed || 0) + '/s';
    pEta.textContent   = NexTransfer.formatTime(d.remaining);
    pushThroughputSample(d.speed || 0);
}

function markPF(i, state) {
    var el = document.getElementById('pf-' + i);
    if (!el) return;
    el.className = 'prog-file-row ' + state;
    if (state === 'done') el.querySelector('i').className = 'bi bi-check-lg';
}

function closeProgress() {
    pBar.style.width = '100%';
    setTimeout(function() { overlay.classList.add('hidden'); }, 800);
}

/* ══════════════════════════════════════════
 *  HELPERS
 * ══════════════════════════════════════════ */
function setStatus(dotClass, message) {
    var d = document.getElementById('status-dot');
    var t = document.getElementById('status-text');
    if (d) d.className = 'status-dot ' + dotClass;
    if (t) t.textContent = message;
}

function updateExpiry(pct, secondsLeft) {
    var fill  = document.getElementById('expiry-fill');
    var label = document.getElementById('expiry-label');
    if (fill)  fill.style.width = pct + '%';
    if (label && secondsLeft !== undefined) {
        var m = Math.floor(secondsLeft / 60), s = secondsLeft % 60;
        label.textContent = 'Expire dans ' + m + ':' + String(s).padStart(2, '0');
    }
}

var _doneBtnCounter = 0;
function doneBanner(title, sub, onReset, btnLabel) {
    btnLabel = btnLabel || 'Nouveau transfert';
    var id = 'done-btn-' + (++_doneBtnCounter);
    setTimeout(function() {
        var el = document.getElementById(id);
        if (el) el.addEventListener('click', onReset);
    }, 0);
    return '<div style="text-align:center;padding:.5rem 0">' +
        '<i class="bi bi-check-circle-fill done-icon"></i>' +
        '<div class="done-title">' + title + '</div>' +
        '<div class="done-sub">' + sub + '</div>' +
        '<button class="btn btn-secondary mt-sm" id="' + id + '"><i class="bi bi-arrow-clockwise"></i> ' + btnLabel + '</button>' +
        '</div>';
}

/* ── Auto-fill code from URL ── */
(function() {
    var urlCode = new URLSearchParams(location.search).get('code');
    if (urlCode) {
        codeInput.value = urlCode.toUpperCase();
        updateFingerprints(codeInput.value);
        setMobilePanel('receive');
        var transfer = document.querySelector('.transfer-section');
        if (transfer) transfer.scrollIntoView({ behavior: 'smooth' });
        setTimeout(startReceiver, 700);
    } else {
        setMobilePanel('send');
    }
})();
