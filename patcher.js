/* Hydra-Sequenced patcher.
 *
 * Builds the sequencer firmware from the user's own copy of the official
 * Explorer 2.2.0 .dat, in the browser. Nothing is uploaded, and this site hosts
 * no ASM firmware: patch-v5.3.json carries only our code, our hook words, our
 * descriptor edits, offsets, lengths and checksums.
 *
 *   1  check the stock file (size + SHA-256)
 *   2  extract the A5 section (length field, Region$$Table)
 *   3  decompress its RW data (armlink LZ)
 *   4  apply our descriptor edits
 *   5  re-encode the RW data (byte-exact port of re/flash/lz_armlink.py) into its slot
 *   6  write our code and hook words (sites checked to lie in the A5 code area)
 *   7  put the A5 section back into the container
 *   8  check the output SHA-256 against the tested build
 *
 * Any mismatch stops the build: no file is offered.
 *
 * One file, three roles: the page UI, its Web Worker, and a CommonJS module
 * (node), so the code proven under node (re/flash/patcher_node.js) is the code
 * the page runs.
 */
(function () {
  "use strict";

  var RELEASE = "v5.3";
  var STOCK_SHA256 = "1d64469cb8f22e25e0d6fb7f17f1222685fd3afe9f75e59ac0834e8030e6baaa";
  var STOCK_SIZE = 1433075;
  var OUTPUT_SHA256 = "6f8565f0dc25c708617e9571119a5fe49401326fb4484d610b7c445f176d5339";
  var OUTPUT_NAME = "Hydra-Sequenced_v5.3_Explorer_2.2.0.dat";
  var PATCH_URL = "patch-v5.3.json";
  var PATCH_SHA256 = "0813813b773cca26c7e9ef7020406761fbc9e7cd833c8362eb3c3575253fe13b";   // written by re/flash/make_patch_data.py
  var STEPS = 8;

  // ------------------------------------------------------------------ helpers
  function PatchError(step, msg) {
    var e = new Error(msg);
    e.step = step;
    return e;
  }

  function hex(buf) {
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  function unhex(s) {
    if (typeof s !== "string" || s.length % 2 || /[^0-9a-f]/.test(s)) throw new Error("bad hex");
    var b = new Uint8Array(s.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(s.substr(2 * i, 2), 16);
    return b;
  }

  function unb64(s) {
    var t = atob(s), b = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
    return b;
  }

  function sha256(bytes) {
    var c = (typeof globalThis !== "undefined" ? globalThis : self).crypto;
    if (!c || !c.subtle) return Promise.reject(new Error("SHA-256 is not available here (open the page over https or localhost)"));
    return c.subtle.digest("SHA-256", bytes).then(hex);
  }

  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function eqBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ------------------------------------------------------------------ armlink LZ codec
  // Port of re/flash/lz_armlink.py.  Tag byte:
  //   tag & 3        literal count + 1 (1..3); 0 -> next byte L, count = L - 1
  //   (tag>>2) & 3   high byte of distance (0..2); 3 -> next byte
  //   tag >> 4       match length - 2 (1..15); 0 -> next byte M, len M + 2, M == 0: no match
  // Token: tag [litbyte] [mlenbyte] literals... [lo] [hibyte]
  var MIN_MATCH = 3, MAX_MATCH = 257, MAX_DIST = 0xFFFF;

  function decompress(src, outSize) {
    var dst = new Uint8Array(outSize + 600), d = 0, p = 0, n = src.length;
    while (d < outSize) {
      if (p >= n) throw new Error("RW stream ends early");
      var tag = src[p++];
      var lit = tag & 3;
      if (lit === 0) lit = src[p++];
      var mlen = tag >> 4;
      if (mlen === 0) mlen = src[p++];
      var nl = lit - 1;
      if (nl > 0) {
        if (p + nl > n) throw new Error("RW stream ends inside literals");
        dst.set(src.subarray(p, p + nl), d);
        d += nl; p += nl;
      }
      if (mlen) {
        var lo = src[p++], hi = (tag >> 2) & 3;
        if (hi === 3) hi = src[p++];
        var dist = lo + (hi << 8), st = d - dist;
        if (dist === 0 || st < 0) throw new Error("RW stream refers before its start");
        for (var k = 0; k < mlen + 2; k++) dst[d++] = dst[st + k];
      }
      if (p > n) throw new Error("RW stream ends inside a token");
    }
    return { out: dst.subarray(0, d), used: p };
  }

  function compress(data, maxchain, lazy) {
    if (maxchain === undefined) maxchain = 4096;
    if (lazy === undefined) lazy = true;
    var n = data.length;
    var out = new Uint8Array(n + 2 * Math.ceil(n / 254) + 64), o = 0;
    var head = new Map();
    var prev = new Int32Array(n).fill(-1);
    var fl = 0, fd = 0;

    function key(i) { return data[i] | (data[i + 1] << 8) | (data[i + 2] << 16); }

    function insert(i) {
      if (i + 2 < n) {
        var k = key(i), h = head.get(k);
        prev[i] = h === undefined ? -1 : h;
        head.set(k, i);
      }
    }

    function find(i) {
      fl = 0; fd = 0;
      if (i + MIN_MATCH > n) return;
      var cand = head.get(key(i));
      if (cand === undefined) cand = -1;
      var bl = 0, bd = 0, chain = 0, maxlen = Math.min(MAX_MATCH, n - i);
      while (cand >= 0 && chain < maxchain) {
        var dist = i - cand;
        if (dist > MAX_DIST) break;
        if (bl === 0 || (i + bl < n && data[cand + bl] === data[i + bl])) {
          var l = 0;
          while (l < maxlen && data[cand + l] === data[i + l]) l++;
          if (l > bl || (l === bl && dist < bd)) {
            bl = l; bd = dist;
            if (l >= maxlen) break;
          }
        }
        cand = prev[cand];
        chain++;
      }
      fl = bl; fd = bd;
    }

    // literals = data[ps .. ps+pn), match = (dist, len) or len 0 for none
    function emit(ps, pn, dist, len) {
      if (pn > 254) throw new Error("compressor: literal run > 254");
      var litField = pn + 1 <= 3 ? pn + 1 : 0, litExt = litField ? -1 : pn + 1;
      var mlenField = 0, mlenExt = 0, hiField = 0, hiExt = -1, lo = 0;
      if (len) {
        if (len < MIN_MATCH || len > MAX_MATCH || dist < 1 || dist > MAX_DIST) throw new Error("compressor: bad match");
        var m = len - 2;
        if (m <= 15) { mlenField = m; mlenExt = -1; } else { mlenField = 0; mlenExt = m; }
        lo = dist & 0xFF;
        var hv = dist >> 8;
        if (hv <= 2) hiField = hv; else { hiField = 3; hiExt = hv; }
      }
      if (o + pn + 6 > out.length) {          // grow: random data can expand past any fixed bound
        var bigger = new Uint8Array(out.length * 2 + pn + 6);
        bigger.set(out.subarray(0, o));
        out = bigger;
      }
      out[o++] = (mlenField << 4) | (hiField << 2) | litField;
      if (litExt >= 0) out[o++] = litExt;
      if (mlenExt >= 0) out[o++] = mlenExt;
      for (var k = 0; k < pn; k++) out[o++] = data[ps + k];
      if (len) {
        out[o++] = lo;
        if (hiExt >= 0) out[o++] = hiExt;
      }
    }

    var i = 0, ps = 0, pn = 0;   // pending literals: always the contiguous run data[ps .. ps+pn)
    function pend(at) {
      if (pn === 0) ps = at;
      pn++;
      if (pn === 254) { emit(ps, pn, 0, 0); pn = 0; }
    }
    function flushOver() {
      while (pn > 254) { emit(ps, 254, 0, 0); ps += 254; pn -= 254; }
    }

    while (i < n) {
      find(i);
      var bl = fl, bd = fd, end;
      if (lazy && bl >= MIN_MATCH && bl < MAX_MATCH && i + 1 < n) {
        insert(i);
        find(i + 1);
        if (fl > bl) {
          pend(i);
          i++;
          continue;
        }
        flushOver();
        emit(ps, pn, bd, bl);
        pn = 0;
        end = i + bl;
        i++;
        while (i < end) { insert(i); i++; }
        continue;
      }
      if (bl >= MIN_MATCH) {
        flushOver();
        emit(ps, pn, bd, bl);
        pn = 0;
        end = i + bl;
        while (i < end) { insert(i); i++; }
      } else {
        insert(i);
        pend(i);
        i++;
      }
    }
    flushOver();
    if (pn) emit(ps, pn, 0, 0);
    return out.slice(0, o);
  }

  // ------------------------------------------------------------------ patch data
  function loadPatch(bytes, expectSha) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return sha256(bytes).then(function (h) {
      if (expectSha !== null && h !== (expectSha || PATCH_SHA256))
        throw PatchError(0, "The patch data file doesn't match this release (SHA-256 " + h + "). Reload the page.");
      var P;
      try { P = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { throw PatchError(0, "The patch data file is not valid JSON."); }
      if (!P || P.format !== "hydra-sequenced-patch/1" || P.release !== RELEASE)
        throw PatchError(0, "The patch data file is for a different release.");
      return P;
    });
  }

  var LABELS = [
    "",
    "Checking the stock file",
    "Extracting the A5 section",
    "Decompressing the RW data",
    "Applying the descriptor edits",
    "Re-encoding the RW data",
    "Writing code and hook words",
    "Reassembling the file",
    "Verifying the result"
  ];

  // stockBuf: ArrayBuffer / Uint8Array of the official .dat; P: parsed patch data.
  // opts.progress(step, total, label, detail); opts.expect overrides the final
  // expectations (tests only).  Resolves to the output .dat (Uint8Array).
  function build(stockBuf, P, opts) {
    opts = opts || {};
    var expect = opts.expect || { stockSha: STOCK_SHA256, stockSize: STOCK_SIZE, outputSha: OUTPUT_SHA256 };
    var progress = opts.progress || function () {};
    var pause = opts.pause || function () { return Promise.resolve(); };
    var stock = stockBuf instanceof Uint8Array ? stockBuf : new Uint8Array(stockBuf);
    var L, C, img, rw0, rw, stream, out, step = 0, t0 = Date.now(), times = [];

    function go(n, detail) {
      if (step) times.push([step, Date.now() - t0]);
      t0 = Date.now();
      step = n;
      progress(n, STEPS, LABELS[n], detail || "");
      return pause();
    }
    function fail(msg) { throw PatchError(step, msg); }
    function num(x) { return typeof x === "number" && x >= 0 && Math.floor(x) === x; }

    return Promise.resolve().then(function () {
      return go(1);
    }).then(function () {
      L = P.layout; C = P.checks;
      if (!L || !C || !P.code || !P.hooks || !P.rw) fail("The patch data is incomplete.");
      ["a5_off", "a5_len", "a5_len_field", "region_table", "rw_load", "rw_exec", "rw_size", "rw_slot"].forEach(function (k) {
        if (!num(L[k])) fail("The patch data has a bad layout field (" + k + ").");
      });
      if (L.rw_load + L.rw_slot !== L.a5_len) fail("The patch data layout is inconsistent.");
      if (stock.length !== expect.stockSize)
        fail("Not the Explorer 2.2.0 file: expected " + expect.stockSize + " bytes, got " + stock.length + ".");
      return sha256(stock);
    }).then(function (h) {
      if (h !== expect.stockSha) fail("The file's SHA-256 isn't the official 2.2.0 one (" + h + ").");
      return go(2);
    }).then(function () {
      if (u32(stock, L.a5_len_field) !== L.a5_len) fail("The A5 section length field isn't the expected one.");
      if (L.a5_off + L.a5_len > stock.length) fail("The A5 section runs past the end of the file.");
      img = stock.slice(L.a5_off, L.a5_off + L.a5_len);
      var rt = L.region_table;
      if (u32(img, rt) !== L.rw_load || u32(img, rt + 4) !== L.rw_exec || u32(img, rt + 8) !== L.rw_size)
        fail("The RW region table isn't where it should be.");
      return go(3);
    }).then(function () {
      var r;
      try { r = decompress(img.subarray(L.rw_load), L.rw_size); } catch (e) { fail(e.message); }
      if (r.out.length !== L.rw_size) fail("The RW data decompressed to " + r.out.length + " bytes, expected " + L.rw_size + ".");
      rw0 = r.out;
      return sha256(rw0);
    }).then(function (h) {
      if (h !== C.stock_rw_sha256) fail("The decompressed RW data has the wrong SHA-256.");
      return go(4, P.rw.length + " edits");
    }).then(function () {
      rw = rw0.slice();
      P.rw.forEach(function (e) {
        var b, o = e[0] - L.rw_exec;
        try { b = unhex(e[1]); } catch (x) { fail("A descriptor edit is not valid hex."); }
        if (!num(e[0]) || o < 0 || o + b.length > L.rw_size) fail("A descriptor edit is out of range.");
        rw.set(b, o);
      });
      return sha256(rw);
    }).then(function (h) {
      if (h !== C.rw_sha256) fail("The edited RW data has the wrong SHA-256.");
      return go(5);
    }).then(function () {
      var cp = P.compressor || {};
      stream = compress(rw, cp.maxchain, cp.lazy);
      if (stream.length > L.rw_slot) fail("The re-encoded RW data (" + stream.length + " bytes) doesn't fit its " + L.rw_slot + "-byte slot.");
      if (stream.length !== C.stream_len) fail("The re-encoded RW data is " + stream.length + " bytes, expected " + C.stream_len + ".");
      var back = decompress(stream, L.rw_size).out;
      if (!eqBytes(back, rw)) fail("The re-encoded RW data doesn't decompress to the intended RW data.");
      return sha256(stream);
    }).then(function (h) {
      if (h !== C.stream_sha256) fail("The re-encoded RW data has the wrong SHA-256.");
      img.fill(0, L.rw_load);
      img.set(stream, L.rw_load);
      return go(6, P.hooks.length + " hook sites, " + P.code.chunks.length + " code sections");
    }).then(function () {
      // No original words in the patch data: the step-1 stock SHA-256 already fixes
      // every byte under a hook. Here only a non-content check: site in the A5 code area.
      P.hooks.forEach(function (hk) {
        var site = hk[0], w;
        if (!num(site) || site % 4 || site + 4 > L.rw_load)
          fail("A hook site is outside the A5 code area.");
        try { w = unhex(hk[1]); } catch (x) { fail("A hook word is not valid hex."); }
        if (w.length !== 4) fail("A hook word is not 4 bytes.");
        img.set(w, site);
      });
    }).then(function () {
      var blob;
      try { blob = unb64(P.code.blob); } catch (x) { fail("The code blob is not valid base64."); }
      var p = 0;
      P.code.chunks.forEach(function (c) {
        if (!num(c[0]) || !num(c[1]) || c[0] + c[1] > L.rw_load || p + c[1] > blob.length) fail("A code section is out of range.");
        img.set(blob.subarray(p, p + c[1]), c[0]);
        p += c[1];
      });
      if (p !== blob.length) fail("The code blob has " + (blob.length - p) + " unused bytes.");
      return sha256(blob);
    }).then(function (h) {
      if (h !== C.code_sha256) fail("The code blob has the wrong SHA-256.");
      return sha256(img);
    }).then(function (h) {
      if (h !== C.image_sha256) fail("The patched A5 section has the wrong SHA-256 (" + h + ").");
      return go(7);
    }).then(function () {
      out = stock.slice();
      out.set(img, L.a5_off);
      return go(8);
    }).then(function () {
      return sha256(out);
    }).then(function (h) {
      if (h !== expect.outputSha) fail("The result doesn't match the tested build (SHA-256 " + h + ").");
      times.push([step, Date.now() - t0]);
      return { dat: out, sha: h, times: times };
    });
  }

  var Core = {
    RELEASE: RELEASE, STOCK_SHA256: STOCK_SHA256, STOCK_SIZE: STOCK_SIZE,
    OUTPUT_SHA256: OUTPUT_SHA256, OUTPUT_NAME: OUTPUT_NAME, PATCH_SHA256: PATCH_SHA256,
    STEPS: STEPS, LABELS: LABELS,
    compress: compress, decompress: decompress, sha256: sha256,
    loadPatch: loadPatch, build: build
  };

  // ------------------------------------------------------------------ role: node module
  if (typeof module === "object" && module && module.exports) {
    module.exports = Core;
    return;
  }

  // ------------------------------------------------------------------ role: Web Worker
  if (typeof document === "undefined" && typeof self !== "undefined" && typeof self.postMessage === "function") {
    self.onmessage = function (ev) {
      var m = ev.data;
      loadPatch(m.patch).then(function (P) {
        return build(m.stock, P, {
          progress: function (n, total, label, detail) {
            self.postMessage({ type: "progress", step: n, total: total, label: label, detail: detail });
          }
        });
      }).then(function (r) {
        self.postMessage({ type: "done", dat: r.dat.buffer, sha: r.sha, times: r.times }, [r.dat.buffer]);
      }, function (e) {
        self.postMessage({ type: "error", step: e.step || 0, message: e.message });
      });
    };
    return;
  }

  // ------------------------------------------------------------------ role: page
  var SCRIPT = document.currentScript && document.currentScript.src;
  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), input = $("file"), status = $("status"), build_ = $("build");
  var buildStatus = $("buildStatus"), ack = $("ack");
  $("stockSha").textContent = STOCK_SHA256;
  $("ver").textContent = RELEASE;

  var stock = null, patchBytes = null, busy = false, lastUrl = null;

  function canBuild() { return !!stock && !!patchBytes && ack.checked && !busy; }
  function refresh() { build_.disabled = !canBuild(); }
  ack.addEventListener("change", refresh);

  function say(el, cls, text) {
    el.hidden = false;
    el.className = "status " + cls;
    el.textContent = text;
  }

  // the patch data: fetched once, accepted only with the expected SHA-256
  fetch(PATCH_URL, { cache: "no-cache" }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.arrayBuffer();
  }).then(function (buf) {
    return loadPatch(buf).then(function () { patchBytes = buf; refresh(); });
  }).catch(function (e) {
    say(buildStatus, "bad", "Couldn't load the patch data: " + e.message + " Building is off.");
  });

  function take(file) {
    stock = null;
    refresh();
    if (!file) return;
    if (!window.crypto || !crypto.subtle) {
      say(status, "bad", "This browser can't check files here. Open the page over https or from localhost.");
      return;
    }
    say(status, "wait", "Checking " + file.name + " ...");
    file.arrayBuffer().then(function (buf) {
      if (buf.byteLength !== STOCK_SIZE) {
        say(status, "bad", "Not the Explorer 2.2.0 file: expected " + STOCK_SIZE.toLocaleString() +
            " bytes, got " + buf.byteLength.toLocaleString() + ".");
        return;
      }
      return sha256(buf).then(function (h) {
        if (h !== STOCK_SHA256) {
          say(status, "bad", "Checksum doesn't match the official 2.2.0 file. Re-download it from ASM. (" + h + ")");
          return;
        }
        stock = buf;
        say(status, "ok", "Official Explorer firmware 2.2.0 confirmed.");
        refresh();
      });
    }).catch(function (e) {
      say(status, "bad", "Couldn't read the file: " + e.message);
    });
  }

  input.addEventListener("change", function () { take(input.files[0]); });
  ["dragenter", "dragover"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { take(e.dataTransfer.files[0]); });

  function onProgress(n, total, label, detail) {
    say(buildStatus, "wait", "Step " + n + " of " + total + ": " + label + (detail ? " (" + detail + ")" : "") + " ...");
  }

  function finished(dat, sha) {
    busy = false;
    refresh();
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(new Blob([dat], { type: "application/octet-stream" }));
    buildStatus.hidden = false;
    buildStatus.className = "status ok";
    buildStatus.textContent = "Built and verified: identical to the tested build (SHA-256 " + sha + "). ";
    var a = document.createElement("a");
    a.href = lastUrl;
    a.download = OUTPUT_NAME;
    a.textContent = "Save " + OUTPUT_NAME + " again";
    buildStatus.appendChild(a);
    a.click();
  }

  function failed(step, message) {
    busy = false;
    refresh();
    say(buildStatus, "bad", "Build stopped" + (step ? " at step " + step + " (" + LABELS[step] + ")" : "") +
        ": " + message + " No file was produced.");
  }

  // main-thread fallback (no Worker, e.g. a file:// page): yields between steps
  function buildHere() {
    var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    loadPatch(patchBytes).then(function (P) {
      return build(stock, P, { progress: onProgress, pause: tick });
    }).then(function (r) { finished(r.dat, r.sha); }, function (e) { failed(e.step, e.message); });
  }

  build_.addEventListener("click", function () {
    if (!canBuild()) return;
    busy = true;
    refresh();
    say(buildStatus, "wait", "Starting ...");
    var w, started = false;
    try { w = new Worker(SCRIPT); } catch (e) { w = null; }
    if (!w) { buildHere(); return; }
    w.onmessage = function (ev) {
      var m = ev.data;
      started = true;
      if (m.type === "progress") onProgress(m.step, m.total, m.label, m.detail);
      else if (m.type === "done") { w.terminate(); finished(new Uint8Array(m.dat), m.sha); }
      else if (m.type === "error") { w.terminate(); failed(m.step, m.message); }
    };
    w.onerror = function (e) {
      w.terminate();
      if (!started) { buildHere(); return; }
      failed(0, "The build worker crashed (" + (e.message || "unknown error") + ").");
    };
    w.postMessage({ stock: stock.slice(0), patch: patchBytes.slice(0) });
  });
})();
