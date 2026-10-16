// Screen recording. MediaRecorder is a DOM API, so it has to live in the renderer — but this file
// never touches the token or the network. The main process hands us a desktop source id and the
// clip length; we record fixed-length, self-contained clips (stop + restart each cycle, so every
// clip is independently playable) and ship each finished clip's bytes back to main, which uploads
// them through Pebbles. Everything is best-effort: any failure is reported and recording simply
// stops, leaving the screenshot flow untouched.
(() => {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let segmentTimer = null;
  let active = false;
  let opts = null;
  let mimeType = '';
  let ext = 'webm';

  // Prefer real MP4 (plays everywhere, incl. Safari); fall back to WebM where the runtime can't mux
  // MP4. Both play in the gallery's <video> element.
  function pickMime() {
    const prefs = [
      ['video/mp4;codecs=avc1.42E01E', 'mp4'],
      ['video/mp4', 'mp4'],
      ['video/webm;codecs=vp9', 'webm'],
      ['video/webm;codecs=vp8', 'webm'],
      ['video/webm', 'webm'],
    ];
    for (const [type, e] of prefs) {
      try { if (window.MediaRecorder && window.MediaRecorder.isTypeSupported(type)) return { type, ext: e }; }
      catch { /* isTypeSupported can throw on odd strings — try the next */ }
    }
    return { type: '', ext: 'webm' }; // let MediaRecorder choose its own default
  }

  async function begin(payload) {
    if (active) return;
    opts = payload || {};
    const picked = pickMime();
    mimeType = picked.type;
    ext = picked.ext;

    try {
      // Legacy constraint form: capture the specific desktop source main picked, with no picker.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: opts.sourceId,
            maxFrameRate: 10, // proof-of-work doesn't need smooth motion; keeps clips small
          },
        },
      });
    } catch (e) {
      report(`screen capture failed: ${e && e.message ? e.message : e}`);
      return;
    }

    active = true;
    startSegment();
  }

  function startSegment() {
    if (!active || !stream) return;
    chunks = [];

    try {
      const recOpts = { videoBitsPerSecond: opts.bitsPerSecond || 2500000 };
      if (mimeType) recOpts.mimeType = mimeType;
      recorder = new window.MediaRecorder(stream, recOpts);
    } catch (e) {
      report(`recorder init failed: ${e && e.message ? e.message : e}`);
      teardown();
      return;
    }

    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.onstop = async () => {
      const parts = chunks;
      chunks = [];
      const wasActive = active;
      // Roll straight into the next clip so coverage is continuous; the just-finished clip ships below.
      if (wasActive) startSegment();

      if (parts.length === 0) return;
      const blob = new Blob(parts, { type: mimeType || 'video/webm' });
      if (blob.size === 0) return;
      try {
        const buffer = await blob.arrayBuffer();
        await window.cw.sendVideoSegment({
          buffer,
          mimeType: mimeType || 'video/webm',
          ext,
          capturedAt: new Date().toISOString(),
        });
      } catch (e) {
        report(`could not send clip: ${e && e.message ? e.message : e}`);
      }
    };

    try { recorder.start(); }
    catch (e) { report(`recorder start failed: ${e && e.message ? e.message : e}`); teardown(); return; }

    segmentTimer = setTimeout(() => {
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    }, opts.segmentMs || 300000);
  }

  // Stop the current clip (its onstop ships it) without starting another, then release the camera/
  // screen tracks a moment later so the final dataavailable/onstop can fire first.
  function end() {
    active = false;
    if (segmentTimer) { clearTimeout(segmentTimer); segmentTimer = null; }
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    setTimeout(releaseStream, 1500);
  }

  function teardown() {
    active = false;
    if (segmentTimer) { clearTimeout(segmentTimer); segmentTimer = null; }
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    recorder = null;
    releaseStream();
  }

  function releaseStream() {
    if (stream) {
      stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      stream = null;
    }
    recorder = null;
  }

  function report(msg) {
    try { window.cw.reportVideoError(msg); } catch { /* bridge missing — nothing to do */ }
  }

  if (window.cw && window.cw.onStartVideo) {
    window.cw.onStartVideo(begin);
    window.cw.onStopVideo(end);
  }
})();
