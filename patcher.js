/* Hydra-Sequenced patcher (UI shell).
 *
 * Step 2 is real: the dropped file is hashed in the browser (SubtleCrypto) and
 * accepted only if it is the official Explorer 2.2.0 .dat.
 * Step 3 is not built yet: it needs the patch data (our code, hooks and RW
 * descriptor edits) and a JavaScript port of re/flash/lz_armlink.py, checked
 * to reproduce the audited build byte for byte (OUTPUT_SHA256).
 */
(function () {
  var STOCK_SHA256 = "1d64469cb8f22e25e0d6fb7f17f1222685fd3afe9f75e59ac0834e8030e6baaa";
  var STOCK_SIZE = 1433075;
  var RELEASE = "v5.3";
  var OUTPUT_SHA256 = "6f8565f0dc25c708617e9571119a5fe49401326fb4484d610b7c445f176d5339";
  var PATCH_READY = false;   // set when patch data + compressor port are in

  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), input = $("file"), status = $("status"), build = $("build");
  var buildStatus = $("buildStatus");
  $("stockSha").textContent = STOCK_SHA256;
  $("ver").textContent = RELEASE;

  var stock = null;
  var ack = $("ack");
  function canBuild() { return !!stock && PATCH_READY && ack.checked; }
  ack.addEventListener("change", function () { build.disabled = !canBuild(); });

  function say(el, cls, text) {
    el.hidden = false;
    el.className = "status " + cls;
    el.textContent = text;
  }

  function hex(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  function take(file) {
    stock = null;
    build.disabled = true;
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
      return crypto.subtle.digest("SHA-256", buf).then(function (d) {
        var h = hex(d);
        if (h !== STOCK_SHA256) {
          say(status, "bad", "Checksum doesn't match the official 2.2.0 file. Re-download it from ASM. (" + h + ")");
          return;
        }
        stock = buf;
        say(status, "ok", "Official Explorer firmware 2.2.0 confirmed.");
        build.disabled = !canBuild();
        if (!PATCH_READY) say(buildStatus, "wait", "Coming soon: the in-browser build isn't in this preview yet.");
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

  build.addEventListener("click", function () {
    if (!canBuild()) return;
    // Placeholder for: apply patch -> recompress RW -> verify OUTPUT_SHA256 -> download.
  });
})();
