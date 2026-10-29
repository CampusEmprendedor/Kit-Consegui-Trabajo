(function () {
  "use strict";

  var K = window.KCT;
  var PROG_KEY = "kct-progreso-v1";
  var SES_KEY = "kct-sesion-v1";
  var DEV_KEY = "kct-dispositivo-v1";
  var REVALIDAR_MS = 24 * 60 * 60 * 1000; // revisa una vez por día si el código sigue activo

  // ---------- almacenamiento ----------
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* nada */ } }

  function deviceId() {
    var d = lsGet(DEV_KEY);
    if (!d) {
      var a = new Uint8Array(12);
      crypto.getRandomValues(a);
      d = Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      lsSet(DEV_KEY, d);
    }
    return d;
  }

  function loadSession() {
    try { var s = JSON.parse(lsGet(SES_KEY) || "null"); return s && s.key && s.codigo ? s : null; } catch (e) { return null; }
  }
  function saveSession(s) { lsSet(SES_KEY, JSON.stringify(s)); }

  function loadProgress() {
    try {
      var p = JSON.parse(lsGet(PROG_KEY) || "null");
      if (p && typeof p === "object") { p.tasks = p.tasks || {}; p.visited = p.visited || {}; return p; }
    } catch (e) { /* nada */ }
    return { tasks: {}, visited: {}, route: "", routeChosen: false };
  }
  var prog = loadProgress();
  function saveProgress() { lsSet(PROG_KEY, JSON.stringify(prog)); }

  // ---------- servidor (bot) ----------
  function validar(codigo) {
    var url = K.api + "?kit=validar&codigo=" + encodeURIComponent(codigo) +
      "&dispositivo=" + encodeURIComponent(deviceId()) +
      "&equipo=" + encodeURIComponent(/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "celular" : "computadora");
    return fetch(url, { method: "GET", redirect: "follow" }).then(function (r) {
      if (!r.ok) throw new Error("red");
      return r.json();
    });
  }

  // ---------- cifrado ----------
  var cryptoKey = null;
  function b64(s) { var bin = atob(s); var a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function importKey(k64) {
    return crypto.subtle.importKey("raw", b64(k64), { name: "AES-GCM" }, false, ["decrypt"]).then(function (k) { cryptoKey = k; });
  }
  function fetchDecrypt(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("No se encontró el contenido");
      return r.json();
    }).then(function (o) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(o.iv) }, cryptoKey, b64(o.ct));
    });
  }

  // ---------- acceso ----------
  var gate = document.getElementById("gate");
  var layout = document.getElementById("layout");
  var form = document.getElementById("gate-form");
  var input = document.getElementById("gate-code");
  var err = document.getElementById("gate-error");
  var btn = document.getElementById("gate-btn");
  var session = loadSession();

  var MENSAJES = {
    codigo: "Ese código no existe o fue dado de baja. Revisá que esté bien escrito, por ejemplo KCT-7F3K-92QD.",
    limite: "Este código ya está activado en 2 dispositivos. Si cambiaste de celular o borraste los datos del navegador, escribí LIBERAR por WhatsApp desde el número con el que compraste y se libera al instante.",
    red: "No pudimos conectarnos. Revisá tu internet y probá de nuevo."
  };

  function showGate(msg) {
    document.body.classList.add("is-locked");
    layout.hidden = true;
    gate.hidden = false;
    if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
    setTimeout(function () { input.focus(); }, 50);
  }

  function normalizar(c) {
    c = String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.indexOf("KCT") === 0) c = c.slice(3);
    if (c.length === 8) return "KCT-" + c.slice(0, 4) + "-" + c.slice(4);
    return "KCT-" + c;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var codigo = normalizar(input.value);
    if (codigo.length < 13) { err.textContent = MENSAJES.codigo; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = "Verificando…"; err.hidden = true;
    validar(codigo).then(function (r) {
      if (!r.ok) { showGate(MENSAJES[r.error] || MENSAJES.codigo); return; }
      session = { codigo: codigo, key: r.key, nombre: r.nombre || "", checked: Date.now() };
      saveSession(session);
      return start();
    }).catch(function () {
      showGate(MENSAJES.red);
    }).then(function () { btn.disabled = false; btn.textContent = "Entrar"; });
  });

  function start() {
    return importKey(session.key).then(function () {
      document.body.classList.remove("is-locked");
      gate.hidden = true;
      layout.hidden = false;
      var owner = document.getElementById("brand-owner");
      if (owner && session.nombre) owner.textContent = "Uso personal de " + session.nombre;
      route();
      revalidarSiHaceFalta();
    });
  }

  function revalidarSiHaceFalta() {
    if (session.checked && Date.now() - session.checked < REVALIDAR_MS) return;
    validar(session.codigo).then(function (r) {
      if (r.ok) {
        session.checked = Date.now();
        if (r.nombre) session.nombre = r.nombre;
        if (r.key) session.key = r.key;
        saveSession(session);
      } else if (r.error === "codigo") {
        lsDel(SES_KEY); session = null; showGate("Tu código fue dado de baja. Si creés que es un error, escribinos por WhatsApp.");
      }
    }).catch(function () { /* sin conexión: seguimos con la sesión guardada */ });
  }

  // ---------- progreso ----------
  function moduleDone(slug) {
    for (var i = 0; i < K.rutas.length; i++) {
      if (K.rutas[i].slug === slug) {
        var t = K.rutas[i].tareas;
        if (!t.length) return !!prog.visited[slug];
        for (var j = 0; j < t.length; j++) if (!prog.tasks[t[j]]) return false;
        return true;
      }
    }
    return false;
  }
  function totals() {
    var total = 0, done = 0;
    K.rutas.forEach(function (m) { m.tareas.forEach(function (t) { total++; if (prog.tasks[t]) done++; }); });
    return { total: total, done: done };
  }
  function nextModule() {
    for (var i = 0; i < K.rutas.length; i++) {
      var s = K.rutas[i].slug;
      if (s.charAt(0) === "r" && prog.route && s !== prog.route) continue;
      if (!moduleDone(s)) return K.rutas[i];
    }
    return null;
  }
  function paint() {
    var t = totals();
    var fill = document.getElementById("bar-fill");
    if (fill) fill.style.width = (t.total ? Math.round(t.done / t.total * 100) : 0) + "%";
    var txt = document.getElementById("progress-text");
    if (txt) txt.textContent = t.done + " de " + t.total + " tareas hechas";
    var hd = document.getElementById("home-done");
    if (hd) hd.textContent = t.done;
    document.querySelectorAll("[data-module]").forEach(function (a) {
      (a.closest("li") || a).classList.toggle("is-done", moduleDone(a.getAttribute("data-module")));
    });
    document.querySelectorAll("[data-route-pick]").forEach(function (li) {
      li.classList.toggle("is-route", !!prog.route && li.getAttribute("data-route-pick") === prog.route);
    });
    document.querySelectorAll("[data-pick]").forEach(function (b) {
      b.setAttribute("aria-checked", String(prog.routeChosen === true && b.getAttribute("data-pick") === (prog.route || "")));
    });
    var cont = document.getElementById("continue-link");
    if (cont) {
      var nx = nextModule();
      var started = t.done > 0 || Object.keys(prog.visited).length > 0;
      if (!nx) { cont.href = "#descargas"; cont.textContent = "Terminaste el recorrido: ir a descargas"; }
      else { cont.href = "#" + nx.slug; cont.textContent = (started ? "Seguir con: " : "Empezar por: ") + nx.titulo; }
    }
  }

  // ---------- render ----------
  var main = document.getElementById("contenido");

  function ownerMark() {
    if (!session || !session.nombre) return "";
    var d = document.createElement("p");
    d.className = "owner-mark";
    d.textContent = "Material de uso personal de " + session.nombre + " · Código " + session.codigo + ". Prohibida su reventa o distribución.";
    return d.outerHTML;
  }

  function bindPage() {
    main.querySelectorAll("[data-task-check]").forEach(function (box) {
      var id = box.getAttribute("data-task-check");
      var sec = box.closest(".task");
      box.checked = !!prog.tasks[id];
      if (sec) sec.classList.toggle("is-done", box.checked);
      box.addEventListener("change", function () {
        if (box.checked) prog.tasks[id] = Date.now(); else delete prog.tasks[id];
        if (sec) sec.classList.toggle("is-done", box.checked);
        saveProgress(); paint();
      });
    });
    main.querySelectorAll(".copy-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var fig = document.getElementById(b.getAttribute("data-copy"));
        var pre = fig && fig.querySelector(".copy-text");
        if (!pre) return;
        copyText(pre.textContent).then(function () {
          b.textContent = "Copiado"; b.classList.add("is-copied");
          setTimeout(function () { b.textContent = "Copiar"; b.classList.remove("is-copied"); }, 1800);
        }, function () { b.textContent = "Seleccioná y copiá"; });
      });
    });
    main.querySelectorAll("[data-file]").forEach(function (b) {
      b.addEventListener("click", function () { descargar(b); });
    });
    main.querySelectorAll("[data-pick]").forEach(function (b) {
      b.addEventListener("click", function () {
        prog.route = b.getAttribute("data-pick"); prog.routeChosen = true; saveProgress(); paint();
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, no) {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? ok() : no(); } catch (e) { no(e); }
      document.body.removeChild(ta);
    });
  }

  function descargar(b) {
    var k = b.getAttribute("data-file");
    var info = K.archivos[k];
    if (!info || b.getAttribute("aria-busy") === "true") return;
    b.setAttribute("aria-busy", "true");
    var fmt = b.querySelector(".file-fmt");
    var prev = fmt ? fmt.textContent : "";
    if (fmt) fmt.textContent = "Descargando…";
    fetchDecrypt("archivos/" + k + ".json").then(function (buf) {
      var blob = new Blob([buf], { type: info.mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = info.nombre;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).catch(function () {
      alert("No se pudo descargar el archivo. Revisá tu conexión y probá de nuevo.");
    }).then(function () {
      b.removeAttribute("aria-busy");
      if (fmt) fmt.textContent = prev;
    });
  }

  function setCurrent(slug) {
    document.querySelectorAll(".side-list a").forEach(function (a) {
      var s = a.getAttribute("data-module") || a.getAttribute("data-route");
      if (s === slug) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  var renderToken = 0;
  function route() {
    if (!session) return;
    var slug = decodeURIComponent((location.hash || "#inicio").slice(1)) || "inicio";
    var known = slug === "inicio" || slug === "descargas" || slug === "mensajes" ||
      K.rutas.some(function (r) { return r.slug === slug; });
    if (!known) slug = "inicio";
    var my = ++renderToken;
    document.body.classList.remove("menu-open");
    setCurrent(slug);
    if (slug === "inicio") {
      main.innerHTML = document.getElementById("tpl-home").innerHTML + ownerMark();
      document.title = "Tu aula · Kit Conseguí Trabajo";
      bindPage(); paint(); window.scrollTo(0, 0);
      return;
    }
    main.innerHTML = '<p class="loading">Cargando…</p>';
    fetchDecrypt("contenido/" + slug + ".json").then(function (buf) {
      if (my !== renderToken) return;
      main.innerHTML = new TextDecoder().decode(buf) + ownerMark();
      var h1 = main.querySelector("h1");
      document.title = (h1 ? h1.textContent + " · " : "") + "Kit Conseguí Trabajo";
      if (K.rutas.some(function (r) { return r.slug === slug; })) { prog.visited[slug] = true; prog.last = slug; saveProgress(); }
      bindPage(); paint(); window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }).catch(function () {
      if (my !== renderToken) return;
      main.innerHTML = '<p class="loading">No se pudo cargar esta sección. Revisá tu conexión y recargá la página.</p>';
    });
  }
  window.addEventListener("hashchange", route);

  // ---------- menú en celular ----------
  var menuBtn = document.querySelector(".menu-btn");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      var open = document.body.classList.toggle("menu-open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("menu-open")) {
        document.body.classList.remove("menu-open"); menuBtn.setAttribute("aria-expanded", "false"); menuBtn.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("menu-open")) return;
      if (e.target.closest(".side") || e.target.closest(".menu-btn")) return;
      document.body.classList.remove("menu-open"); menuBtn.setAttribute("aria-expanded", "false");
    });
  }

  // ---------- arranque ----------
  if (!window.crypto || !crypto.subtle) {
    showGate("Tu navegador es muy antiguo para abrir el aula. Probá con Chrome, Safari o Edge actualizados.");
    return;
  }
  if (session) {
    start().catch(function () { lsDel(SES_KEY); session = null; showGate(); });
  } else {
    showGate();
  }
})();
