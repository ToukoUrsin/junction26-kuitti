// Kuitti: small progressive enhancements. Pages work without most of this.
(function () {
  "use strict";

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute("content") : "";

  // Clickable table rows.
  document.addEventListener("click", function (e) {
    var row = e.target.closest("tr[data-href]");
    if (!row || e.target.closest("a, button, input")) return;
    window.location.href = row.getAttribute("data-href");
  });

  // Buttons that call the JSON API, e.g. mark paid or delete.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-api]");
    if (!btn) return;
    var confirmText = btn.getAttribute("data-confirm");
    if (confirmText && !window.confirm(confirmText)) return;
    var errorBox = document.querySelector(".api-error");
    btn.setAttribute("aria-busy", "true");
    fetch(btn.getAttribute("data-api"), {
      method: btn.getAttribute("data-method") || "POST",
      headers: { "X-CSRF-Token": csrf, Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body && body.error ? body.error : "request_failed");
          var redirect = btn.getAttribute("data-redirect");
          if (redirect) window.location.href = redirect;
          else window.location.replace(window.location.pathname);
        });
      })
      .catch(function (err) {
        btn.removeAttribute("aria-busy");
        if (errorBox) {
          errorBox.textContent = "That did not work (" + err.message + "). Reload the page and try again.";
          errorBox.hidden = false;
        }
      });
  });

  // Copy buttons, e.g. for an invoice share link.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-copy]");
    if (!btn) return;
    var input = document.querySelector(btn.getAttribute("data-copy"));
    if (!input) return;
    input.select();
    var done = function () {
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy"; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, function () {});
    } else if (document.execCommand && document.execCommand("copy")) {
      done();
    }
  });

  // Invoice form: add and remove line items, live totals.
  var form = document.getElementById("invoice-form");
  if (!form) return;
  var lines = document.getElementById("lines");
  var tpl = document.getElementById("line-template");
  var totalCell = document.getElementById("form-total");
  var fmt = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

  function parseNum(v) {
    v = String(v || "").replace(/[€\s ]/g, "");
    if (v.indexOf(",") >= 0 && v.indexOf(".") < 0) v = v.replace(",", ".");
    else v = v.replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(v)) return null;
    return Number(v);
  }

  function recalc() {
    var total = 0;
    var any = false;
    lines.querySelectorAll("tr.line").forEach(function (tr) {
      var q = parseNum(tr.querySelector('[name="quantity"]').value);
      var p = parseNum(tr.querySelector('[name="unit_price"]').value);
      var cell = tr.querySelector(".line-amount");
      if (q !== null && p !== null) {
        var cents = Math.round(q * Math.round(p * 100));
        total += cents;
        any = true;
        cell.textContent = fmt.format(cents / 100);
      } else {
        cell.textContent = "–";
      }
    });
    totalCell.textContent = any ? fmt.format(total / 100) : "–";
  }

  document.getElementById("add-line").addEventListener("click", function () {
    var row = tpl.content.firstElementChild.cloneNode(true);
    lines.appendChild(row);
    row.querySelector("input").focus();
  });

  lines.addEventListener("click", function (e) {
    var btn = e.target.closest(".remove-line");
    if (!btn) return;
    var rows = lines.querySelectorAll("tr.line");
    var tr = btn.closest("tr");
    if (rows.length > 1) tr.remove();
    else tr.querySelectorAll("input").forEach(function (i) { i.value = i.name === "quantity" ? "1" : ""; });
    recalc();
  });

  lines.addEventListener("input", recalc);
  recalc();
})();
