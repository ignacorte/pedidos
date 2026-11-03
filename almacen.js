"use strict";
// Datos del profesional: en el celular (IndexedDB, funciona sin señal) y copia en SU Google Drive
// (carpeta «Pedidos», archivo pedidos-datos.json). Permiso drive.file: la app solo ve los archivos que creó.
// Sincronización por registro: gana la versión con `actualizado` más reciente; lo borrado queda marcado (borrada).
// Seguridad: en el celular todo se guarda cifrado (AES-256-GCM) con una clave derivada del PIN (PBKDF2-SHA256,
// 310.000 iteraciones). La clave vive solo en memoria mientras la app está desbloqueada; el PIN no se guarda.
// Sesión: mientras se usa, recargar la página no vuelve a pedir el PIN (la clave, no exportable, queda en el almacenamiento
// del navegador hasta `minutosBloqueo` después del último uso); al bloquear o vencer se borra.
// (Misma base que la app Liquidaciones.)

const Almacen = (() => {
  const DB = "pedidos", STORE = "doc", CLAVE = "datos";
  const ARCHIVO = "pedidos-datos.json", CARPETA = "Pedidos";
  // pedidos: cada documento generado (datos del paciente incluidos: arma la lista de Pacientes); kits y combos: editables
  const COLECCIONES = ["pedidos", "kits", "combos"];
  const vacio = () => ({ version: 1, cuenta: null, pedidos: [], kits: [], combos: [], ajustes: {} });
  let doc = vacio();

  const idb = () => new Promise((ok, mal) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
  async function idbLeer(clave) {
    const db = await idb();
    return new Promise((ok) => {
      const r = db.transaction(STORE).objectStore(STORE).get(clave);
      r.onsuccess = () => ok(r.result ?? null);
      r.onerror = () => ok(null);
    });
  }
  async function idbEscribir(pares) {
    const db = await idb();
    return new Promise((ok, mal) => {
      const t = db.transaction(STORE, "readwrite");
      for (const [k, v] of Object.entries(pares)) v === undefined ? t.objectStore(STORE).delete(k) : t.objectStore(STORE).put(v, k);
      t.oncomplete = ok; t.onerror = () => mal(t.error);
    });
  }

  // ---------- Cifrado con PIN ----------
  const ITERACIONES = 310000, PRUEBA = "pedidos-ok";
  let llave = null; // CryptoKey AES-GCM (no exportable) mientras está desbloqueada
  let meta = null;  // {sal, iteraciones, verificador}: datos públicos para verificar el PIN
  let minutosBloqueo = 15, ultimaSesion = 0;
  async function guardarSesion() {
    ultimaSesion = Date.now();
    await idbEscribir({ sesion: { llave, hasta: ultimaSesion + minutosBloqueo * 60e3 } });
  }
  // Uso de la app: extiende la sesión (como mucho una escritura cada 30 s)
  function tocar() { if (llave && Date.now() - ultimaSesion > 30000) guardarSesion().catch(() => {}); }

  async function derivar(pin, sal, iteraciones) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: sal, iterations: iteraciones, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function cifrar(objeto, k = llave) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const datos = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(objeto)));
    return { iv, datos };
  }
  async function descifrar(sobre, k = llave) {
    const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sobre.iv }, k, sobre.datos);
    return JSON.parse(new TextDecoder().decode(plano));
  }

  const tienePin = () => !!meta;
  const bloqueada = () => tienePin() && !llave;

  async function crearPin(pin) {
    // Los PDF pendientes de subir están cifrados con la llave anterior: se leen antes de cambiarla y se vuelven a cifrar
    if (llave) { await leerAdjuntos(); await leerSecretos(); }
    const sal = crypto.getRandomValues(new Uint8Array(16));
    llave = await derivar(pin, sal, ITERACIONES);
    meta = { sal, iteraciones: ITERACIONES, verificador: await cifrar(PRUEBA) };
    await idbEscribir({ pin: meta });
    await escribirLocal();
    if (adjuntos) await guardarAdjuntos();
    if (secretos) await idbEscribir({ secretos: await cifrar(secretos) });
    await guardarSesion();
    if (tokenMem) await guardarToken();
  }

  // Secretos del profesional (clave del asistente de IA): solo en este dispositivo, cifrados con el PIN; nunca van a Drive
  let secretos = null;
  async function leerSecretos() {
    if (!secretos) { const s = await idbLeer("secretos"); secretos = s ? await descifrar(s).catch(() => ({})) : {}; }
    return secretos;
  }
  const secreto = async (nombre) => (llave ? (await leerSecretos())[nombre] ?? null : null);
  async function guardarSecreto(nombre, valor) {
    if (!llave) throw new Error("Desbloqueá la app primero.");
    const s = { ...(await leerSecretos()) };
    if (valor == null) delete s[nombre]; else s[nombre] = valor;
    secretos = s;
    await idbEscribir({ secretos: await cifrar(s) });
  }

  // Intentos fallidos: espera creciente (30 s, 1 min, 2 min…) después del quinto, también entre reinicios de la app
  async function esperaRestante() {
    const f = (await idbLeer("fallos")) || { n: 0, hasta: 0 };
    return Math.max(0, f.hasta - Date.now());
  }
  async function desbloquear(pin) {
    const espera = await esperaRestante();
    if (espera) throw new Error(`Demasiados intentos. Esperá ${Math.ceil(espera / 1000)} segundos.`);
    const k = await derivar(pin, meta.sal, meta.iteraciones);
    try {
      if ((await descifrar(meta.verificador, k)) !== PRUEBA) throw new Error();
    } catch {
      const f = (await idbLeer("fallos")) || { n: 0, hasta: 0 };
      f.n += 1;
      f.hasta = f.n >= 5 ? Date.now() + 30000 * 2 ** (f.n - 5) : 0;
      await idbEscribir({ fallos: f });
      throw new Error(f.n >= 5 ? "PIN incorrecto. Esperá antes de volver a intentar." : `PIN incorrecto (${f.n} de 5 intentos).`);
    }
    llave = k;
    await idbEscribir({ fallos: undefined });
    await guardarSesion();
    await cargar();
    const t = await idbLeer("token");
    if (t && !tokenMem) tokenMem = await descifrar(t).catch(() => null);
    else if (tokenMem) await guardarToken();
  }

  async function bloquear() {
    llave = null;
    adjuntos = null;
    secretos = null;
    doc = vacio();
    tokenMem = null;
    clearTimeout(temporizador);
    await idbEscribir({ sesion: undefined });
  }

  // Olvidó el PIN: lo de este celular no se puede abrir; se guarda aparte (no se destruye) y la copia de Drive queda
  async function olvidePin() {
    await bloquear();
    const viejo = await idbLeer(CLAVE), pendientes = await idbLeer("adjuntos");
    if (viejo || pendientes) await idbEscribir({ ["olvidado_" + Date.now()]: { datos: viejo, adjuntos: pendientes, pin: meta } });
    meta = null;
    await idbEscribir({ [CLAVE]: undefined, pin: undefined, token: undefined, token_vence: undefined, fallos: undefined, sesion: undefined, pendiente: undefined, adjuntos: undefined, secretos: undefined });
  }
  // Datos de un PIN anterior («Olvidé mi PIN» o «Cerrar cuenta»): con ese PIN se abren y se suman a lo de hoy (no se pisa nada)
  async function olvidados() {
    const db = await idb();
    const claves = await new Promise((ok) => { const r = db.transaction(STORE).objectStore(STORE).getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); });
    return claves.filter((k) => String(k).startsWith("olvidado_")).map((k) => ({ clave: k, fecha: new Date(+String(k).slice(9)) }));
  }
  async function recuperarOlvidado(clave, pin) {
    const c = await idbLeer(clave);
    if (!c?.pin) throw new Error("Esa copia es de una versión anterior y no se puede abrir.");
    const k = await derivar(pin, c.pin.sal, c.pin.iteraciones);
    try { if ((await descifrar(c.pin.verificador, k)) !== PRUEBA) throw new Error(); } catch { throw new Error("Ese no es el PIN de esa copia."); }
    const antes = doc.pedidos.length;
    if (c.datos) doc = combinar(doc, c.datos.iv ? await descifrar(c.datos, k) : c.datos);
    if (c.adjuntos) { await leerAdjuntos(); adjuntos.push(...await descifrar(c.adjuntos, k)); await guardarAdjuntos(); }
    cambios++;
    await confirmar();
    return doc.pedidos.length - antes;
  }

  // ---------- Copia de seguridad (archivo cifrado con una clave propia: sirve en otro celular) ----------
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); };
  const deB64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  async function exportarCopia(clave) {
    const sal = crypto.getRandomValues(new Uint8Array(16));
    const sobre = await cifrar(doc, await derivar(clave, sal, ITERACIONES));
    return JSON.stringify({ app: "pedidos", version: 1, fecha: new Date().toISOString(), iteraciones: ITERACIONES, sal: b64(sal),
      iv: b64(sobre.iv), datos: b64(new Uint8Array(sobre.datos)) });
  }
  // Restaurar: se combina con lo que hay (no se pierde nada de ninguno de los dos lados)
  async function importarCopia(texto, clave) {
    let c;
    try { c = JSON.parse(texto); } catch { throw new Error("El archivo no es una copia de Pedidos."); }
    if (c.app !== "pedidos") throw new Error("El archivo no es una copia de Pedidos.");
    let datos;
    try { datos = await descifrar({ iv: deB64(c.iv), datos: deB64(c.datos) }, await derivar(clave, deB64(c.sal), c.iteraciones)); }
    catch { throw new Error("Clave incorrecta para esta copia."); }
    const antes = doc.pedidos.length;
    doc = combinar(doc, datos);
    if (!doc.cuenta && datos.cuenta) doc.cuenta = datos.cuenta;
    await confirmar();
    return doc.pedidos.length - antes;
  }
  async function marcarCopia() { doc.ultima_copia = Date.now(); await escribirLocal(); }

  async function cambiarPin(actual, nuevo) {
    await desbloquear(actual);
    await crearPin(nuevo);
  }

  async function leerLocal() {
    const guardado = await idbLeer(CLAVE);
    if (!guardado) return vacio();
    if (guardado.iv && guardado.datos) return descifrar(guardado);
    return guardado; // sin PIN todavía: se cifra al crearlo
  }
  async function escribirLocal() {
    if (bloqueada()) throw new Error("La app está bloqueada");
    await idbEscribir({ [CLAVE]: llave ? await cifrar(doc) : doc });
  }

  async function cargar() {
    doc = await leerLocal();
    for (const c of COLECCIONES) doc[c] ||= [];
    doc.ajustes ||= {};
  }

  const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // Al abrir: con PIN queda bloqueada (no se lee nada hasta desbloquear); sin PIN (primera vez) se lee lo que haya
  async function iniciar() {
    await leerMeta();
    meta = await idbLeer("pin");
    if (!meta) await cargar();
    else {
      const sesion = await idbLeer("sesion");
      if (sesion?.llave && sesion.hasta > Date.now()) {
        llave = sesion.llave;
        try {
          await cargar();
          const t = await idbLeer("token");
          if (t && !tokenMem) tokenMem = await descifrar(t).catch(() => null);
          else if (tokenMem) await guardarToken();
          await guardarSesion();
        } catch { llave = null; doc = vacio(); }
      } else if (sesion) await idbEscribir({ sesion: undefined });
    }
    try { await navigator.storage?.persist?.(); } catch { /* el navegador decide */ }
  }

  // Guardar o borrar un registro; dispara la sincronización con Drive en segundo plano
  async function guardar(coleccion, registro) {
    const r = { ...registro, id: registro.id || nuevoId(), actualizado: Date.now() };
    const i = doc[coleccion].findIndex((x) => x.id === r.id);
    if (i >= 0) doc[coleccion][i] = r; else doc[coleccion].push(r);
    cambios++;
    await confirmar();
    return r;
  }
  // Muchos registros de una vez (configuración importada): una sola escritura cifrada y una sola sincronización
  async function guardarVarios(coleccion, registros) {
    const ahora = Date.now();
    for (const registro of registros) {
      const r = { ...registro, id: registro.id || nuevoId(), actualizado: ahora };
      const i = doc[coleccion].findIndex((x) => x.id === r.id);
      if (i >= 0) doc[coleccion][i] = r; else doc[coleccion].push(r);
    }
    cambios++;
    await confirmar();
  }
  // Registros iniciales (kits precargados): solo los que faltan, con fecha mínima: nunca le ganan a una versión editada o
  // borrada en otro dispositivo
  async function sembrar(coleccion, registros) {
    for (const r of registros) if (!doc[coleccion].some((x) => x.id === r.id)) doc[coleccion].push({ ...r, actualizado: 1 });
    cambios++;
    await confirmar();
  }
  async function confirmar() {
    await escribirLocal();
    if (doc.cuenta && !pendiente) await marcarPendiente(true);
    programarSync();
  }
  const borrar = (coleccion, id) => {
    const r = doc[coleccion].find((x) => x.id === id);
    return r ? guardar(coleccion, { ...r, borrada: true }) : null;
  };
  async function ajuste(clave, valor) {
    doc.ajustes[clave] = { valor, actualizado: Date.now() };
    cambios++;
    await confirmar();
  }

  function combinar(a, b) {
    const out = { ...a, ajustes: { ...a.ajustes } };
    for (const c of COLECCIONES) {
      const m = new Map((a[c] || []).map((x) => [x.id, x]));
      for (const x of b[c] || []) if (!m.has(x.id) || (m.get(x.id).actualizado || 0) < (x.actualizado || 0)) m.set(x.id, x);
      out[c] = [...m.values()];
    }
    for (const [k, v] of Object.entries(b.ajustes || {})) if (!out.ajustes[k] || out.ajustes[k].actualizado < v.actualizado) out.ajustes[k] = v;
    return out;
  }

  // ---------- Google Drive (OAuth en el navegador, sin servidor) ----------
  let tokenMem = null; // {valor, vence}
  const token = () => (tokenMem && tokenMem.vence > Date.now() + 60000 ? tokenMem.valor : null);
  const guardarToken = async () => { if (llave) await idbEscribir({ token: tokenMem ? await cifrar(tokenMem) : undefined }); };
  const conectado = () => !!doc.cuenta;

  // Cuenta de Google y vencimiento del acceso: sin cifrar (no son datos de pacientes), para saber al abrir la app si hay que
  // renovar el acceso antes de pedir el PIN. El acceso de Google dura 1 hora: se renueva sin pedir nada (prompt=none)
  // mientras el profesional siga con su sesión de Google abierta en el navegador.
  let cuentaPlano = null, venceToken = 0, pendiente = false, local = false, cambios = 0; // cambios: para no perder lo hecho durante una subida
  async function leerMeta() {
    cuentaPlano = (await idbLeer("cuenta")) || null;
    local = !!(await idbLeer("local"));
    venceToken = (await idbLeer("token_vence")) || 0;
    pendiente = !!(await idbLeer("pendiente"));
  }
  const marcarPendiente = async (v) => { pendiente = v; await idbEscribir({ pendiente: v || undefined }); };

  function conectar({ silencioso = false } = {}) {
    if (!CONFIG.GOOGLE_CLIENT_ID) throw new Error("Falta configurar GOOGLE_CLIENT_ID en config.js");
    const estado = nuevoId();
    sessionStorage.setItem("ped_estado", estado);
    const p = new URLSearchParams({ client_id: CONFIG.GOOGLE_CLIENT_ID, redirect_uri: location.origin + location.pathname,
      response_type: "token", scope: "https://www.googleapis.com/auth/drive.file", include_granted_scopes: "true", state: estado });
    const cuenta = doc.cuenta || cuentaPlano;
    if (cuenta) p.set("login_hint", cuenta);
    if (silencioso) p.set("prompt", "none");
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p;
  }

  // Vuelta de Google: #access_token=…&expires_in=…&state=…  (o #error=interaction_required si hay que ingresar de nuevo)
  function recibirToken() {
    if (!/access_token|error=/.test(location.hash)) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname);
    if (h.get("state") !== sessionStorage.getItem("ped_estado")) return null;
    if (h.get("error")) return { error: h.get("error") };
    tokenMem = { valor: h.get("access_token"), vence: Date.now() + (+h.get("expires_in") || 3600) * 1000 }; // se guarda cifrado al desbloquear
    venceToken = tokenMem.vence;
    idbEscribir({ token_vence: venceToken }).catch(() => {});
    return { ok: true };
  }

  // Errores de Drive de esta sesión (para ver qué pasó: Configuración → Mi cuenta). Solo en memoria.
  const registro = [];
  const anotar = (texto) => { registro.unshift({ cuando: new Date().toLocaleString("es-AR"), texto }); registro.length = Math.min(registro.length, 30); };
  // Saturación o falla momentánea de Google (429, 5xx) o sin red: se reintenta 3 veces con espera creciente
  async function drive(url, opciones = {}) {
    for (let intento = 0; ; intento++) {
      const t = token();
      if (!t) throw Object.assign(new Error("Volvé a conectar Google Drive"), { reconectar: true });
      let r;
      try { r = await fetch(url, { ...opciones, headers: { Authorization: "Bearer " + t, ...(opciones.headers || {}) } }); }
      catch (e) {
        if (intento < 3) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** intento)); continue; }
        anotar("Sin conexión con Google Drive"); throw new Error("Sin conexión con Google Drive");
      }
      if (r.status === 401) { tokenMem = null; guardarToken(); anotar("Venció el acceso de Google"); throw Object.assign(new Error("Volvé a conectar Google Drive"), { reconectar: true }); }
      if ((r.status === 429 || r.status >= 500) && intento < 3) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** intento)); continue; }
      if (!r.ok) {
        const detalle = await r.json().then((j) => j.error?.message || "").catch(() => "");
        anotar(`Google Drive respondió ${r.status}${detalle ? ": " + detalle : ""} (${(opciones.method || "GET")} ${url.replace(/\?.*/, "").split("/").slice(-2).join("/")})`);
        throw Object.assign(new Error("Google Drive respondió " + r.status + (detalle ? ": " + detalle : "")), { status: r.status });
      }
      return r;
    }
  }
  // Comillas en las búsquedas de Drive (un apellido como D'ANGELO rompía la consulta)
  const comillas = (t) => String(t).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const API = "https://www.googleapis.com/drive/v3/files", SUBIR = "https://www.googleapis.com/upload/drive/v3/files";

  // El más antiguo primero: si hubiera dos con el mismo nombre, siempre se usa el mismo
  async function buscarTodos(nombre, tipo) {
    const q = `name='${comillas(nombre)}' and trashed=false` + (tipo ? ` and mimeType='${tipo}'` : "");
    const r = await (await drive(`${API}?q=${encodeURIComponent(q)}&fields=files(id,modifiedTime,createdTime)&spaces=drive&orderBy=createdTime`)).json();
    return r.files || [];
  }
  const buscar = async (nombre, tipo) => (await buscarTodos(nombre, tipo))[0] || null;
  async function carpeta() {
    const tipo = "application/vnd.google-apps.folder";
    const c = await buscar(CARPETA, tipo);
    if (c) return c.id;
    const r = await drive(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: CARPETA, mimeType: tipo }) });
    return (await r.json()).id;
  }
  // Carpetas dentro de «Pedidos» (p. ej. ["Pacientes", "2026"]); se crean si no están
  const carpetas = {};
  async function carpetaRuta(ruta = []) {
    let padre = await carpeta();
    for (const nombre of ruta) {
      const k = padre + "/" + nombre;
      carpetas[k] ||= await carpetaEn(padre, nombre);
      padre = carpetas[k];
    }
    return padre;
  }
  async function carpetaEn(padre, nombre) {
    const tipo = "application/vnd.google-apps.folder";
    const q = `name='${comillas(nombre)}' and '${padre}' in parents and mimeType='${tipo}' and trashed=false`;
    const r = await (await drive(`${API}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`)).json();
    return r.files?.[0]?.id || (await (await drive(API, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nombre, mimeType: tipo, parents: [padre] }) })).json()).id;
  }
  async function subirArchivo(nombre, archivo, padre, descripcion = "") {
    const meta = { name: nombre, parents: [padre], ...(descripcion ? { description: descripcion } : {}) }, limite = "ped" + Date.now();
    const cuerpo = new Blob([`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${limite}\r\nContent-Type: ${archivo.type || "application/octet-stream"}\r\n\r\n`,
      archivo, `\r\n--${limite}--`]);
    return (await drive(`${SUBIR}?uploadType=multipart&fields=id,webViewLink`, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + limite }, body: cuerpo })).json();
  }

  // Respaldo diario en el Drive: antes de la primera sincronización del día se copia el archivo de datos tal como está
  // («pedidos-respaldo-AAAA-MM-DD.json», últimos 30 días). Nada de lo que haga la app puede hacer perder la base.
  const RESPALDO = "pedidos-respaldo-";
  let respaldoDe = "";
  async function respaldoDiario(archivo) {
    const dia = new Date().toISOString().slice(0, 10);
    if (respaldoDe === dia) return;
    const nombre = `${RESPALDO}${dia}.json`;
    if (!(await buscar(nombre))) {
      await drive(`${API}/${archivo.id}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nombre, parents: [await carpetaRuta(["Respaldos"])] }) });
      const limite = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      for (const f of await respaldos()) if (f.dia < limite) await drive(`${API}/${f.id}`, { method: "DELETE" }).catch(() => {});
    }
    respaldoDe = dia;
  }
  async function respaldos() {
    const q = `name contains '${RESPALDO}' and trashed=false`;
    const r = await (await drive(`${API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive&pageSize=200`)).json();
    return (r.files || []).map((f) => ({ id: f.id, dia: (f.name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || "" })).filter((f) => f.dia).sort((a, b) => b.dia.localeCompare(a.dia));
  }
  // Recuperar de un respaldo: vuelve lo que falta o está borrado (no pisa lo que existe hoy)
  async function recuperarRespaldo(id) {
    const viejo = await (await drive(`${API}/${id}?alt=media`)).json();
    const ahora = Date.now();
    let n = 0;
    for (const col of COLECCIONES) {
      for (const r of viejo[col] || []) {
        if (r.borrada) continue;
        const i = doc[col].findIndex((x) => x.id === r.id);
        if (i >= 0 && !doc[col][i].borrada) continue;
        if (i >= 0) doc[col][i] = { ...r, actualizado: ahora }; else doc[col].push({ ...r, actualizado: ahora });
        n++;
      }
    }
    if (n) { cambios++; await confirmar(); }
    return n;
  }

  let sincronizando = null, temporizador = null, alCambiar = () => {}, estadoSync = "sin conectar";
  const avisar = (e) => { estadoSync = e; alCambiar(e); };

  function programarSync() {
    clearTimeout(temporizador);
    if (conectado() && token()) temporizador = setTimeout(() => sincronizar().catch(() => {}), 2500);
    else if (conectado()) avisar("cambios sin subir");
  }

  async function sincronizar() {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
      avisar("sincronizando…");
      try {
        if (!doc.cuenta) {
          const sobre = await (await drive("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")).json();
          doc.cuenta = sobre.user.emailAddress;
        }
        if (cuentaPlano !== doc.cuenta) { cuentaPlano = doc.cuenta; await idbEscribir({ cuenta: doc.cuenta }); }
        const cambiosAlEmpezar = cambios;
        const archivos = await buscarTodos(ARCHIVO);
        if (archivos.length) {
          const archivo = archivos[0];
          await respaldoDiario(archivo).catch(() => {});
          // Si otro dispositivo lo cambió mientras se leía, se vuelve a leer y unir (hasta 3 veces) antes de subir
          for (let vuelta = 0; ; vuelta++) {
            const antes = (await (await drive(`${API}/${archivo.id}?fields=modifiedTime`)).json()).modifiedTime;
            for (const a of archivos) doc = combinar(doc, await (await drive(`${API}/${a.id}?alt=media`)).json());
            const ahora = (await (await drive(`${API}/${archivo.id}?fields=modifiedTime`)).json()).modifiedTime;
            if (ahora === antes || vuelta >= 2) break;
          }
          await drive(`${SUBIR}/${archivo.id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
        } else {
          await subirArchivo(ARCHIVO, new Blob([JSON.stringify(doc)], { type: "application/json" }), await carpeta());
        }
        // Documentos (PDF) pendientes: si falla, quedan en el celular para la próxima y se muestra el motivo
        errorAdjuntos = "";
        await subirAdjuntos().catch((e) => { errorAdjuntos = e.message || "error al subir"; });
        doc.ultima_sync = Date.now();
        await escribirLocal();
        // Si hubo cambios mientras se subía, falta otra vuelta
        if (cambios === cambiosAlEmpezar && adjuntos && !adjuntos.length && !errorAdjuntos) { await marcarPendiente(false); avisar("al día"); }
        else if (cambios === cambiosAlEmpezar) avisar("documentos sin subir");
        else { avisar("sincronizando…"); setTimeout(() => sincronizar().catch(() => {}), 500); }
      } catch (e) {
        avisar(e.reconectar ? "cambios sin subir" : "sin conexión: se guarda en el celular");
        throw e;
      } finally { sincronizando = null; }
    })();
    return sincronizando;
  }

  // ---------- PDF de cada pedido en el Drive ----------
  // Quedan CIFRADOS en el celular y se suben en la próxima sincronización (aunque no haya señal al generarlos).
  // «Pedidos/Pacientes/<año>/<APELLIDO, Nombre – DNI>/<fecha – Documento>.pdf»; al subirse, el enlace queda en el pedido.
  let adjuntos = null, errorAdjuntos = "";
  async function leerAdjuntos() {
    if (!adjuntos) {
      const s = await idbLeer("adjuntos");
      try { adjuntos = s ? await descifrar(s) : []; }
      catch {
        // Cifrados con otra llave (no debería pasar): se guardan aparte, no se borran, y se sigue con una cola nueva
        await idbEscribir({ ["adjuntos_ilegibles_" + Date.now()]: s });
        adjuntos = [];
        await guardarAdjuntos();
      }
    }
    return adjuntos;
  }
  const guardarAdjuntos = async () => idbEscribir({ adjuntos: await cifrar(adjuntos) });
  const aBase64 = async (blob) => b64(new Uint8Array(await blob.arrayBuffer()));
  async function encolarAdjunto(pedidoId, nombre, blob, ruta, descripcion = "") {
    await leerAdjuntos();
    adjuntos = adjuntos.filter((a) => a.pedidoId !== pedidoId); // un archivo por pedido: vale el último
    adjuntos.push({ pedidoId, nombre, tipo: blob.type || "application/pdf", datos: await aBase64(blob), ruta, descripcion });
    await guardarAdjuntos();
    if (doc.cuenta && !pendiente) await marcarPendiente(true);
    programarSync();
  }
  // Uno que falla no traba a los demás (sigue con el resto; al final se informa el error). Sin acceso a Google: se corta.
  async function subirAdjuntos() {
    await leerAdjuntos();
    let error = null;
    for (const a of [...adjuntos]) {
      try {
        const r = await subirArchivo(a.nombre, new Blob([deB64(a.datos)], { type: a.tipo }), await carpetaRuta(a.ruta), a.descripcion);
        const i = doc.pedidos.findIndex((p) => p.id === a.pedidoId);
        if (i >= 0) {
          doc.pedidos[i] = { ...doc.pedidos[i], actualizado: Date.now(),
            archivo: { id: r.id, link: r.webViewLink || `https://drive.google.com/file/d/${r.id}/view`, nombre: a.nombre } };
          cambios++;
        }
        adjuntos = adjuntos.filter((x) => x !== a);
        await guardarAdjuntos();
        await escribirLocal();
      } catch (e) { if (e.reconectar) throw e; error = e; }
    }
    if (error) throw error;
  }
  const enlaceCarpeta = async (ruta) => `https://drive.google.com/drive/folders/${await carpetaRuta(ruta)}`;

  async function desconectar() {
    await olvidePin();
    await idbEscribir({ cuenta: undefined, token_vence: undefined, local: undefined });
    doc = vacio();
  }

  return {
    iniciar, guardar, guardarVarios, sembrar, confirmar, olvidados, recuperarOlvidado, borrar, ajuste, combinar, respaldos, recuperarRespaldo, encolarAdjunto, enlaceCarpeta, tocar,
    exportarCopia, importarCopia, marcarCopia, tienePin, bloqueada, crearPin, secreto, guardarSecreto, desbloquear, bloquear, olvidePin, cambiarPin, esperaRestante,
    sincronizar, conectar, recibirToken, conectado, desconectar,
    get registro() { return registro; }, get errorAdjuntos() { return errorAdjuntos; }, adjuntosPendientes: async () => (await leerAdjuntos()).length,
    get doc() { return doc; }, get cuenta() { return doc.cuenta || cuentaPlano; }, get pendiente() { return pendiente; },
    get local() { return local; }, usarLocal: async () => { local = true; await idbEscribir({ local: true }); },
    accesoVencido: () => venceToken < Date.now() + 5 * 60e3, set minutosBloqueo(m) { minutosBloqueo = m; },
    get estado() { return estadoSync; }, set alCambiar(f) { alCambiar = f; }, tieneToken: () => !!token(),
  };
})();
