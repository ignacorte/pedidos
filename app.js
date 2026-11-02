"use strict";
// Pedidos para el celular o la computadora, sin servidor (como Liquidaciones): datos en el dispositivo (cifrados con el PIN)
// y en el Google Drive de cada profesional; lectura de documentos con el lector del dispositivo; recetario dibujado acá.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const campo = (nombre) => $(`[data-campo="${nombre}"]`);
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fechaCorta = (iso) => { const [a, m, d] = (iso || "").slice(0, 10).split("-"); return d ? `${d}/${m}/${a}` : ""; };

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
async function copiar(texto) { try { await navigator.clipboard.writeText(texto); return true; } catch { return false; } }

const estado = { modoPin: "", archivos: [], ultimo: null, kitEditando: null, pedidoDe: {} };
const datos = () => Almacen.doc;
const ajuste = (k, def) => datos().ajustes[k]?.valor ?? def;
const vivos = (col) => datos()[col].filter((x) => !x.borrada);

const MEDICO_VACIO = { titulo: "Dr.", nombre: "", apellido: "", especialidad: "Cirugía General", subtitulo: "", mp: "", me: "", direccion: "", telefono: "",
  email: "", web: "", color_acento: "#1f3a5f", color_secundario: "#b08d57" };
const INSTITUCION_VACIA = { nombre: "", pie: "", color_acento: "#092b50", color_secundario: "#519bb4", whatsapp_secretaria: "" };
const perfil = () => ({ medico: { ...MEDICO_VACIO, ...ajuste("medico", {}) }, institucion: { ...INSTITUCION_VACIA, ...ajuste("institucion", {}) }, imagenes: ajuste("imagenes", {}) });

// ---------------- Vistas ----------------
const TITULOS_VISTA = { nuevo: "Nuevo pedido", pacientes: "Pacientes", kits: "Kits", config: "Configuración", pin: "Pedidos", bienvenida: "Pedidos" };
function ir(vista) {
  $$("main > section").forEach((s) => (s.hidden = s.id !== "v-" + vista));
  $$("nav.abajo button").forEach((b) => b.classList.toggle("activa", b.dataset.vista === vista));
  const dentro = !["pin", "bienvenida"].includes(vista);
  $("#nav").hidden = !dentro; $("#bloquear").hidden = !dentro || !Almacen.tienePin();
  $("#titulo").textContent = TITULOS_VISTA[vista];
  if (vista === "pacientes") verPacientes();
  if (vista === "kits") verKits();
  if (vista === "config") verConfig();
  if (vista === "nuevo") $("#falta-perfil").hidden = !!perfil().medico.apellido;
  window.scrollTo(0, 0);
}

// ---------------- Autocompletar (catálogos en el dispositivo) ----------------
function autocompletar(input, buscar, render, elegir) {
  const lista = document.createElement("div");
  lista.className = "sugerencias"; lista.hidden = true;
  input.parentElement.append(lista);
  let items = [], activo = -1, t;
  const cerrar = () => { lista.hidden = true; activo = -1; };
  const pintar = () => $$(".sugerencia", lista).forEach((el, i) => el.classList.toggle("activa", i === activo));
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) return cerrar();
    t = setTimeout(() => {
      items = buscar(q);
      lista.innerHTML = items.map((it) => `<div class="sugerencia">${render(it)}</div>`).join("");
      lista.hidden = !items.length; activo = -1;
      $$(".sugerencia", lista).forEach((el, i) => el.addEventListener("mousedown", (e) => { e.preventDefault(); elegir(items[i]); cerrar(); }));
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (lista.hidden) return;
    if (e.key === "ArrowDown") { activo = Math.min(activo + 1, items.length - 1); pintar(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { activo = Math.max(activo - 1, 0); pintar(); e.preventDefault(); }
    else if (e.key === "Enter" && activo >= 0) { elegir(items[activo]); cerrar(); e.preventDefault(); }
    else if (e.key === "Escape") cerrar();
  });
  input.addEventListener("blur", () => setTimeout(cerrar, 150));
}

function configurarAutocompletar() {
  autocompletar($("#in-diagnostico"), (q) => Catalogos.buscarDiagnosticos(q),
    (d) => `<b>${esc(d.codigo)}</b>${esc(d.descripcion)}`,
    (d) => {
      // Si lo escrito era solo una búsqueda corta, se reemplaza por la descripción; si ya era un diagnóstico redactado, solo se completa el código
      campo("clinica.cie10").value = d.codigo;
      if (campo("clinica.diagnostico").value.trim().length < 16) campo("clinica.diagnostico").value = d.descripcion;
    });
  autocompletar($("#in-procedimiento"), (q) => Catalogos.buscarModulos(q, 10),
    (m) => `<b>${esc(m.codigo)}</b>${esc(m.coincide || m.descripcion)}${m.coincide ? `<small>${esc(m.descripcion)}</small>` : ""}`,
    (m) => { campo("clinica.procedimiento").value = m.coincide || m.descripcion; sugerirKit(); });
  autocompletar($("#in-practica"), (q) => Catalogos.buscarPracticas(q),
    (p) => `<b>${esc(p.codigo)}</b>${esc(p.descripcion)}<small>${esc(p.seccion)}</small>`,
    (p) => { filaEstudio({ codigo: p.codigo, descripcion: Catalogos.capitalizar(p.descripcion) }); $("#in-practica").value = ""; });
}

// ---------------- Leer documentos (en el dispositivo) ----------------
function agregarArchivos(lista) { estado.archivos.push(...lista); renderMiniaturas(); }
function renderMiniaturas() {
  const cont = $("#miniaturas");
  cont.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src));
  cont.innerHTML = "";
  estado.archivos.forEach((f, i) => {
    const d = document.createElement("div");
    d.className = "mini";
    if (f.type.startsWith("image/")) { const img = document.createElement("img"); img.src = URL.createObjectURL(f); d.append(img); }
    else d.textContent = "PDF " + (f.name || "");
    const x = document.createElement("button");
    x.className = "quitar"; x.textContent = "×"; x.title = "Quitar";
    x.onclick = () => { estado.archivos.splice(i, 1); renderMiniaturas(); };
    d.append(x); cont.append(d);
  });
  $("#btn-extraer").disabled = !estado.archivos.length;
}

async function leerDocumentos() {
  const b = $("#btn-extraer");
  b.disabled = true;
  $("#leyendo").hidden = false;
  const avance = (t) => ($("#leyendo-texto").textContent = t);
  try {
    const texto = await Lector.textoDe(estado.archivos, avance, { paginas: 6 });
    const d = Catalogos.leer(texto, { kits: vivos("kits"), medico: perfil().medico });
    if (d.vacio) {
      $("#dudas").innerHTML = '<div class="alerta">No se reconocieron datos en las imágenes. Probá con una foto más nítida, de frente y con buena luz, o completá a mano.</div>';
      return;
    }
    cargarLectura(d);
    toast("Datos leídos: revisalos contra el original.", 5000);
  } catch (e) {
    $("#estado-extraccion").innerHTML = `<div class="alerta error">No se pudo leer: ${esc(e.message)}</div>`;
  } finally {
    $("#leyendo").hidden = true;
    b.disabled = !estado.archivos.length;
  }
}

function cargarLectura(d) {
  // Solo completa campos vacíos: no pisa lo que el médico ya escribió
  for (const grupo of ["paciente", "cobertura", "clinica"]) {
    for (const [k, v] of Object.entries(d[grupo] || {})) {
      const el = campo(`${grupo}.${k}`);
      if (el && v && !el.value.trim()) { el.value = v; el.classList.add("dudoso"); }
    }
  }
  estado.secciones = d.secciones;
  for (const [k, v] of [["fundamento", d.resumen.clinico], ["resumen_estudios", d.resumen.estudios]]) {
    const el = campo("autorizacion." + k);
    if (v && !el.value.trim()) { el.value = v; el.classList.add("dudoso"); }
  }
  if (d.kit_sugerido && !$("#tabla-materiales tbody").children.length) { $("#sel-kit").value = d.kit_sugerido; aplicarKit(d.kit_sugerido); }
  actualizarMembrete();
  const rec = d.recomendacion;
  if (!$("#tabla-estudios tbody").children.length) {
    if (rec.combo && vivos("combos").some((c) => c.id === rec.combo)) { $("#sel-combo").value = rec.combo; aplicarCombo(rec.combo); }
    rec.estudios.forEach(filaEstudio);
  }
  $$("[data-generar]").forEach((b) => b.classList.toggle("recomendado", rec.documentos.includes(b.dataset.generar)));
  const nombres = { estudios: "estudios", materiales: "materiales", autorizacion: "autorización", receta: "receta" };
  const resumen = rec.documentos.length
    ? `<strong>Sugerido:</strong> ${rec.documentos.map((x) => nombres[x]).join(", ")}${rec.combo ? " (con prequirúrgico)" : ""}. Los botones con ★ son los recomendados; modificá lo que quieras antes de generar.`
    : "No se detectó qué pedir: completalo a mano.";
  $("#dudas").innerHTML = `<div class="alerta">${resumen}<br>Los campos resaltados se completaron solos: verificalos.${d.dudas.length ? `<ul>${d.dudas.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`;
}

// ---------------- Filas editables (materiales, estudios, kits) ----------------
function filaEditable(tbody, item, columnas) {
  const tr = document.createElement("tr");
  tr.innerHTML = columnas.map(([k, cls]) => `<td><input class="${cls}" data-k="${k}" autocomplete="off"></td>`).join("") + `<td><button class="quitar" title="Quitar">×</button></td>`;
  $$("input", tr).forEach((el) => (el.value = item[el.dataset.k] ?? ""));
  $(".quitar", tr).onclick = () => tr.remove();
  tbody.append(tr);
  return tr;
}
const leerFilas = (tbody) => $$("tr", tbody).map((tr) => Object.fromEntries($$("input", tr).map((el) => [el.dataset.k, el.value.trim()]))).filter((i) => i.descripcion);
const filaMaterial = (tbody, item = { cantidad: "1", descripcion: "" }) => filaEditable(tbody, item, [["cantidad", "cant"], ["descripcion", "desc"]]);
const filaEstudio = (item = { codigo: "", descripcion: "" }) => filaEditable($("#tabla-estudios tbody"), item, [["codigo", "cod"], ["descripcion", "desc"]]);

// Resumen de HC con los datos del formulario y lo leído de la HC (si se leyó): plantilla de redacción, sin IA
function armarResumen() {
  const f = campo("autorizacion.fundamento"), e = campo("autorizacion.resumen_estudios");
  if ((f.value.trim() || e.value.trim()) && !confirm("¿Reemplazar el resumen que está escrito?")) return;
  const r = Catalogos.redactarResumen(estado.secciones || {}, { fecha_nacimiento: campo("paciente.fecha_nacimiento").value.trim(),
    diagnostico: campo("clinica.diagnostico").value, procedimiento: Recetario.procedimientoTexto(recolectar()) });
  if (!r.clinico || r.clinico === "Paciente.") return toast("Faltan datos: cargá al menos el diagnóstico o el procedimiento (o leé la HC en el paso 1).", 5000);
  f.value = r.clinico; f.classList.add("dudoso");
  if (r.estudios) { e.value = r.estudios; e.classList.add("dudoso"); }
  toast("Resumen armado: revisalo y corregilo antes de mandarlo.", 4000);
}

// ---------------- Kits y combos ----------------
function agrupar(lista) {
  const m = new Map();
  [...lista].sort((a, b) => a.categoria.localeCompare(b.categoria) || a.nombre.localeCompare(b.nombre))
    .forEach((k) => { if (!m.has(k.categoria)) m.set(k.categoria, []); m.get(k.categoria).push(k); });
  return m;
}
function renderSelectorKits() {
  const sel = $("#sel-kit"), actual = sel.value;
  sel.innerHTML = '<option value="">— elegir kit —</option>';
  for (const [cat, lista] of agrupar(vivos("kits"))) {
    const og = document.createElement("optgroup");
    og.label = cat;
    lista.forEach((k) => og.append(new Option(k.nombre + (k.borrador ? " (borrador)" : ""), k.id)));
    sel.append(og);
  }
  sel.value = actual;
  $("#lista-categorias").innerHTML = [...new Set(vivos("kits").map((k) => k.categoria))].map((c) => `<option>${esc(c)}</option>`).join("");
}
function aplicarKit(id) {
  const kit = vivos("kits").find((k) => k.id === id), tbody = $("#tabla-materiales tbody");
  tbody.innerHTML = ""; $("#aviso-kit").innerHTML = "";
  if (!kit) return;
  kit.items.forEach((i) => filaMaterial(tbody, i));
  if (!campo("clinica.procedimiento").value) campo("clinica.procedimiento").value = kit.nombre;
  if (kit.borrador) $("#aviso-kit").innerHTML = '<div class="alerta"><span class="badge">BORRADOR</span> Lista precargada sin validar: revisala antes de usarla (y validala en Kits).</div>';
}
// Al elegir un procedimiento: el kit que le corresponde, si todavía no hay materiales
function sugerirKit() {
  if ($("#tabla-materiales tbody").children.length) return;
  const k = Catalogos.kitDe(campo("clinica.procedimiento").value, vivos("kits"));
  if (k) { $("#sel-kit").value = k.id; aplicarKit(k.id); toast(`Kit sugerido: ${k.nombre}`); }
}

function renderCombos() {
  const sel = $("#sel-combo"), actual = sel.value, combos = vivos("combos").sort((a, b) => a.nombre.localeCompare(b.nombre));
  sel.innerHTML = '<option value="">— cargar combo —</option>' + combos.map((c) => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join("");
  sel.value = combos.some((c) => c.id === actual) ? actual : "";
  $("#btn-borrar-combo").hidden = !sel.value;
}
function aplicarCombo(id) {
  const c = vivos("combos").find((x) => x.id === id);
  $("#btn-borrar-combo").hidden = !c;
  if (!c) return;
  $("#tabla-estudios tbody").innerHTML = "";
  c.items.forEach(filaEstudio);
}
async function guardarCombo() {
  const items = leerFilas($("#tabla-estudios tbody"));
  if (!items.length) return toast("Agregá estudios primero.");
  const actual = vivos("combos").find((c) => c.id === $("#sel-combo").value);
  const nombre = prompt("Nombre del combo (si ya existe, se reemplaza):", actual?.nombre || "")?.trim();
  if (!nombre) return;
  const mismo = vivos("combos").find((c) => c.nombre.toLowerCase() === nombre.toLowerCase());
  const c = await Almacen.guardar("combos", { ...(mismo || {}), nombre, items });
  renderCombos(); $("#sel-combo").value = c.id; $("#btn-borrar-combo").hidden = false;
  toast("Combo guardado");
}
async function borrarCombo() {
  const c = vivos("combos").find((x) => x.id === $("#sel-combo").value);
  if (!c || !confirm(`¿Borrar el combo "${c.nombre}"?`)) return;
  await Almacen.borrar("combos", c.id);
  $("#sel-combo").value = ""; renderCombos();
  toast("Combo borrado");
}

// Primera vez en esta cuenta: kits precargados (borrador) y el prequirúrgico PAMI. Ids fijos: si se hace en dos
// dispositivos a la vez, no se duplican.
async function sembrar() {
  if (ajuste("sembrado", false)) return;
  if (!datos().kits.length) await Almacen.guardarVarios("kits", Catalogos.kitsIniciales.map((k) => ({ ...k, notas: "", borrador: true })));
  if (!datos().combos.some((c) => c.id === Catalogos.PREQUIRURGICO.id)) await Almacen.guardar("combos", Catalogos.PREQUIRURGICO);
  await Almacen.ajuste("sembrado", true);
}

// ---------------- Medicamentos ----------------
function agregarMedicamento(m = {}) {
  const d = document.createElement("div");
  d.className = "medicamento";
  d.innerHTML = `<button class="quitar" title="Quitar">×</button>
    <div class="grid">
      <label>Genérico<input data-m="nombre_generico" autocomplete="off"></label>
      <label>Presentación<input data-m="presentacion" autocomplete="off"></label>
      <label>Cantidad<input data-m="cantidad" inputmode="numeric" autocomplete="off"></label>
      <label class="ancho">Indicación<input data-m="posologia" autocomplete="off"></label>
    </div>`;
  $$("[data-m]", d).forEach((el) => (el.value = m[el.dataset.m] || ""));
  $(".quitar", d).onclick = () => d.remove();
  $("#lista-medicamentos").append(d);
}

// ---------------- Generar ----------------
function recolectar() {
  const d = { paciente: {}, cobertura: {}, clinica: {}, autorizacion: {}, observaciones: "" };
  $$("[data-campo]").forEach((el) => {
    const [g, k] = el.dataset.campo.split(".");
    if (k) d[g][k] = el.value.trim(); else d[g] = el.value.trim();
  });
  d.estudios = leerFilas($("#tabla-estudios tbody"));
  d.materiales = leerFilas($("#tabla-materiales tbody"));
  d.medicamentos = $$(".medicamento").map((m) => Object.fromEntries($$("[data-m]", m).map((el) => [el.dataset.m, el.value.trim()]))).filter((m) => m.nombre_generico);
  d.membrete = $("#sel-membrete").value;
  d.mostrar_codigos = $("#chk-codigos").checked;
  return d;
}
function faltante(tipo, d) {
  return {
    estudios: !d.estudios.length && "al menos un estudio",
    materiales: !d.materiales.length && "al menos un material",
    autorizacion: !d.clinica.procedimiento && "el procedimiento",
    resumen: !d.autorizacion.fundamento && "el resumen clínico (se completa al leer la HC o a mano)",
    receta: !d.medicamentos.length && "al menos un medicamento",
  }[tipo];
}

const nombrePaciente = (d) => [d.paciente.nombre, d.paciente.apellido].filter(Boolean).join(" ");
const firmante = (m) => [[m.titulo, m.apellido, m.nombre].filter(Boolean).join(" "), [m.mp && "M.P. " + m.mp, m.me && "M.E. " + m.me].filter(Boolean).join(" · ")].filter(Boolean).join(" - ");
function textoMensaje(tipo, d) {
  const p = d.paciente, c = d.cobertura, k = d.clinica, a = d.autorizacion, proc = Recetario.procedimientoTexto(d);
  const diag = k.diagnostico || Catalogos.descripcionCie10(k.cie10);
  const r = [`*${Recetario.TITULOS[tipo]}*`, `Paciente: ${nombrePaciente(d)}`];
  if (p.dni) r.push(`DNI: ${p.dni}`);
  r.push(`Obra social: ${c.obra_social || "Particular"}${c.nro_afiliado ? " - Afiliado: " + c.nro_afiliado : ""}`);
  if (diag) r.push(`Diagnóstico: ${diag}`);
  r.push("");
  if (tipo === "estudios") { r.push("Solicito:", ...d.estudios.map((e) => `- ${e.descripcion}${e.codigo ? ` (${e.codigo})` : ""}`)); if (k.procedimiento) r.push(`Procedimiento propuesto: ${proc}`); }
  if (tipo === "materiales") r.push(`Solicito materiales para: ${proc}`, ...d.materiales.map((m) => `- ${m.cantidad ? m.cantidad + " x " : ""}${m.descripcion}`));
  if (tipo === "autorizacion") { r.push(`Solicito: Autorización para ${proc}`); if (k.caracter) r.push(`Carácter: ${k.caracter}`); if (a.fecha_probable) r.push(`Fecha probable: ${a.fecha_probable}`); }
  if (tipo === "resumen") { if (k.procedimiento) r.push(`Procedimiento propuesto: ${proc}`); r.push(`Resumen clínico: ${a.fundamento}`); if (a.resumen_estudios) r.push(`Estudios: ${a.resumen_estudios}`); }
  if (tipo === "receta") r.push("Rp/", ...d.medicamentos.map((m) => `- ${[m.nombre_generico, m.presentacion].filter(Boolean).join(" ")}${m.cantidad ? ` (x${m.cantidad})` : ""}${m.posologia ? " - " + m.posologia : ""}`));
  if (d.observaciones) r.push(d.observaciones);
  r.push("", firmante(perfil().medico));
  return r.join("\n");
}
// Dónde se carga la receta u orden electrónica según la obra social
function plataforma(os) {
  const o = Catalogos.obraSocialCanonica(os);
  if (o === "PAMI") return { nombre: "Sistema PAMI (CUP)", url: "", cup: true };
  if (o === "APROSS") return { nombre: "Escritorio Médico Digital de APROSS", url: "https://emd.apross.gov.ar" };
  return { nombre: "Receta electrónica del Consejo de Médicos de Córdoba", url: "https://cmpc.org.ar" };
}
function textoCarga(tipo, d, cup) {
  const p = d.paciente, c = d.cobertura, k = d.clinica;
  if (cup) return ["PAMI – Solicitud en CUP", `Paciente: ${nombrePaciente(d)}${p.dni ? " - DNI " + p.dni : ""}`, `Beneficio: ${c.nro_afiliado || "(completar)"}`,
    `Diagnóstico CIE-10: ${k.cie10 || "(completar)"}${k.diagnostico ? " - " + k.diagnostico : ""}`, "", "Prácticas:", ...d.estudios.map((e) => `${e.codigo || "(sin código)"}  ${e.descripcion}`)].join("\n");
  const r = [`Paciente: ${p.apellido}${p.apellido && p.nombre ? ", " : ""}${p.nombre}`, `DNI: ${p.dni}`,
    `Obra social: ${c.obra_social || "Particular"}${c.nro_afiliado ? " - Afiliado: " + c.nro_afiliado : ""}`, `Diagnóstico: ${k.cie10 ? k.cie10 + " - " : ""}${k.diagnostico}`, ""];
  if (tipo === "receta") r.push("Medicamentos:", ...d.medicamentos.map((m, i) => `${i + 1}. ${[m.nombre_generico, m.presentacion].filter(Boolean).join(" ")} - Cantidad: ${m.cantidad || 1}${m.posologia ? " - Indicación: " + m.posologia : ""}`));
  else { r.push("Estudios:", ...d.estudios.map((e) => `- ${e.descripcion}`)); if (k.procedimiento) r.push(`Motivo: prequirúrgico de ${Recetario.procedimientoTexto(d)}`); }
  return r.join("\n");
}
// Teléfono argentino para wa.me (549 + área + número; sin el 15)
function telefonoWa(t) {
  let d = (t || "").replace(/\D/g, "");
  if (!d || d.startsWith("549")) return d;
  if (d.startsWith("54")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length === 12) for (const a of [4, 3, 2]) if (d.slice(a, a + 2) === "15") { d = d.slice(0, a) + d.slice(a + 2); break; }
  return d.length === 10 ? "549" + d : d;
}
const PARA_SECRETARIA = new Set(["materiales", "autorizacion", "resumen"]);
const nombreArchivo = (tipo, d) => `${tipo}_${(d.paciente.apellido || "paciente").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "")}_${hoy().replace(/-/g, "")}.pdf`;

async function generar(tipo, boton) {
  const d = recolectar();
  const falta = faltante(tipo, d);
  if (falta) return toast(`Falta ${falta}.`, 4000);
  if (!nombrePaciente(d)) return toast("Falta el nombre del paciente.", 4000);
  boton.disabled = true; boton.classList.add("cargando");
  try {
    const p = perfil();
    const hojas = await Recetario.hojas(tipo, d, p);
    const [pdf, png] = await Promise.all([Recetario.pdf(hojas), Recetario.png(hojas)]);
    if (estado.ultimo) { URL.revokeObjectURL(estado.ultimo.url); URL.revokeObjectURL(estado.ultimo.urlPng); }
    const inst = Recetario.esInstitucional(d, p.institucion);
    estado.ultimo = { tipo, datos: d, pdf, png, nombre: nombreArchivo(tipo, d), url: URL.createObjectURL(pdf), urlPng: URL.createObjectURL(png), texto: textoMensaje(tipo, d),
      membrete: inst ? p.institucion.nombre : "personal" };
    mostrarResultado(boton.textContent.replace(" ★", ""));
    await guardarPedido(tipo, d, pdf);
  } catch (e) {
    toast("No se pudo generar: " + e.message, 6000);
  } finally {
    boton.disabled = false; boton.classList.remove("cargando");
  }
}

// Cada documento queda en Pacientes (datos completos para repetirlo) y su PDF en el Drive. Generarlo otra vez en el mismo
// formulario (por una corrección) reemplaza al anterior en vez de sumar uno nuevo.
async function guardarPedido(tipo, d, pdf) {
  const previo = estado.pedidoDe[tipo] && vivos("pedidos").find((x) => x.id === estado.pedidoDe[tipo]);
  const r = await Almacen.guardar("pedidos", { ...(previo || {}), fecha: hoy(), tipo, titulo: Recetario.TITULOS[tipo], datos: d });
  estado.pedidoDe[tipo] = r.id;
  const ap = (d.paciente.apellido || "").toUpperCase(), carpeta = `${ap}${d.paciente.nombre ? ", " + d.paciente.nombre : ""}${d.paciente.dni ? " – DNI " + d.paciente.dni : ""}`;
  await Almacen.encolarAdjunto(r.id, `${hoy()} – ${Recetario.TITULOS[tipo]}.pdf`, pdf, ["Pacientes", hoy().slice(0, 4), carpeta.replace(/[\/\\]/g, "-")],
    [nombrePaciente(d), d.paciente.dni && "DNI " + d.paciente.dni, d.cobertura.obra_social, d.clinica.diagnostico, d.clinica.procedimiento].filter(Boolean).join(" · "));
  $("#estado-guardado").textContent = Almacen.conectado() ? "✓ Guardado en Pacientes; el PDF se sube a tu Drive (Pedidos › Pacientes)." : "✓ Guardado en Pacientes (en este dispositivo).";
}

function mostrarResultado(titulo) {
  const u = estado.ultimo, d = u.datos, p = perfil();
  $("#resultado").hidden = false;
  $("#resultado-titulo").innerHTML = `<strong>${esc(titulo)}</strong> · recetario ${esc(u.membrete)}`;
  $("#vista-previa").src = u.urlPng;
  const secretaria = PARA_SECRETARIA.has(u.tipo);
  $("#btn-ver").href = u.url; $("#btn-ver").download = u.nombre;
  const asunto = `${Recetario.TITULOS[u.tipo]} – ${nombrePaciente(d)}`;
  // A la secretaría va el recetario (PDF o imagen); el mensaje solo lo acompaña. Al paciente, el texto completo.
  $("#btn-whatsapp").href = `https://wa.me/${telefonoWa(secretaria ? p.institucion.whatsapp_secretaria : d.paciente.telefono)}?text=${encodeURIComponent(secretaria ? asunto : u.texto)}`;
  $("#btn-whatsapp").textContent = secretaria ? "Abrir chat de secretaría" : "WhatsApp al paciente (texto)";
  $("#btn-email").href = secretaria ? `mailto:?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent("Adjunto el recetario.\n\n" + firmante(p.medico))}`
    : `mailto:${encodeURIComponent(d.paciente.email || "")}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(u.texto)}`;
  $("#texto-plano").textContent = u.texto;
  $("#btn-copiar").hidden = secretaria;
  const archivo = new File([u.pdf], u.nombre, { type: "application/pdf" });
  const puedePdf = !!(navigator.canShare && navigator.canShare({ files: [archivo] }));
  const puedeImg = !!(navigator.canShare && navigator.canShare({ files: [new File([u.png], "recetario.png", { type: "image/png" })] }));
  const copiaImg = !!(window.ClipboardItem && navigator.clipboard?.write);
  $("#btn-compartir").hidden = !puedePdf; $("#btn-compartir-imagen").hidden = !puedeImg; $("#btn-copiar-imagen").hidden = !copiaImg;
  $("#ayuda-compartir").innerHTML = [
    puedePdf && "«Compartir» lo adjunta en WhatsApp (elegí el chat).",
    copiaImg && "En la computadora: «Copiar como imagen» y pegalo (Ctrl+V) en el chat de WhatsApp Web.",
    "Si no, «Descargar» y en WhatsApp adjuntalo con el clip 📎.",
  ].filter(Boolean).join(" ");
  // Panel para cargar en la plataforma oficial (CUP de PAMI o receta electrónica)
  const panel = $("#panel-carga");
  panel.hidden = !["estudios", "receta"].includes(u.tipo);
  if (!panel.hidden) {
    const pl = plataforma(d.cobertura.obra_social), cup = pl.cup && u.tipo === "estudios";
    u.carga = textoCarga(u.tipo, d, cup);
    $("#carga-titulo").textContent = "Para cargar en " + pl.nombre;
    $("#carga-ayuda").textContent = cup
      ? "Tocá un dato para copiarlo y pegalo en CUP. Podés cargar todas las prácticas en una sola OME: CUP las separa solo (laboratorio junto; cada consulta e imagen aparte). Hasta 2 diagnósticos CIE-10 por orden."
      : "Tocá un dato para copiarlo y pegalo en el formulario, o «Copiar todo» para tener el resumen a mano.";
    $("#btn-abrir-plataforma").hidden = !pl.url; $("#btn-abrir-plataforma").href = pl.url || "#";
    const filas = [], fila = (etiqueta, valor) => valor && filas.push({ etiqueta, valor });
    fila("DNI", d.paciente.dni);
    fila(cup ? "N° de beneficio" : "N° de afiliado", cup ? d.cobertura.nro_afiliado.replace(/\D/g, "") : d.cobertura.nro_afiliado);
    fila("CIE-10", d.clinica.cie10); fila("Diagnóstico", d.clinica.diagnostico);
    if (u.tipo === "receta") d.medicamentos.forEach((m, i) => { fila(`Medicamento ${i + 1}`, [m.nombre_generico, m.presentacion].filter(Boolean).join(" ")); fila("Cantidad", m.cantidad); fila("Indicación", m.posologia); });
    else d.estudios.forEach((e) => (cup ? fila(e.descripcion, e.codigo) : fila(e.codigo || "Estudio", e.descripcion)));
    $("#carga-filas").innerHTML = filas.map((f) => `<div class="cup-fila"><button title="Copiar">${esc(f.valor.length > 16 ? "Copiar" : f.valor)}</button><span><small>${esc(f.etiqueta)}</small><br>${esc(f.valor)}</span></div>`).join("");
    $$("#carga-filas button").forEach((btn, i) => btn.addEventListener("click", async () => {
      if (await copiar(filas[i].valor)) { btn.classList.add("copiado"); toast("Copiado: " + filas[i].valor.slice(0, 40), 1500); }
    }));
  }
  $("#resultado").scrollIntoView({ behavior: "smooth" });
}

async function compartir(blob, nombre, tipo) {
  try { await navigator.share({ files: [new File([blob], nombre, { type: tipo })], title: nombre }); }
  catch (e) { if (e.name !== "AbortError") toast("No se pudo compartir: " + e.message); }
}
function descargar(blob, nombre) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function limpiarFormulario() {
  $$("[data-campo]").forEach((el) => { el.value = ""; el.classList.remove("dudoso"); });
  ["#tabla-materiales tbody", "#tabla-estudios tbody", "#lista-medicamentos"].forEach((s) => ($(s).innerHTML = ""));
  $("#sel-kit").value = $("#sel-combo").value = "";
  $("#aviso-kit").innerHTML = $("#dudas").innerHTML = $("#estado-extraccion").innerHTML = "";
  estado.archivos = []; estado.secciones = null; renderMiniaturas();
  if (estado.ultimo) { URL.revokeObjectURL(estado.ultimo.url); URL.revokeObjectURL(estado.ultimo.urlPng); }
  estado.ultimo = null; estado.pedidoDe = {};
  $$("[data-generar]").forEach((b) => b.classList.remove("recomendado"));
  $("#resultado").hidden = true; $("#estado-guardado").textContent = "";
  $("#sel-membrete").value = "personal"; estado.membreteElegido = ""; $("#chk-codigos").checked = false;
  actualizarMembrete();
  window.scrollTo(0, 0);
}

// Carga en el formulario todos los datos de un pedido guardado (para repetirlo)
function cargarDatos(d) {
  limpiarFormulario();
  for (const grupo of ["paciente", "cobertura", "clinica", "autorizacion"]) {
    for (const [k, v] of Object.entries(d[grupo] || {})) { const el = campo(`${grupo}.${k}`); if (el && typeof v === "string") el.value = v; }
  }
  campo("observaciones").value = d.observaciones || "";
  (d.estudios || []).forEach(filaEstudio);
  (d.materiales || []).forEach((m) => filaMaterial($("#tabla-materiales tbody"), m));
  (d.medicamentos || []).forEach(agregarMedicamento);
  $("#sel-membrete").value = estado.membreteElegido = d.membrete === "institucional" ? "institucional" : "personal";
  $("#chk-codigos").checked = !!d.mostrar_codigos;
  actualizarMembrete();
}

// ---------------- Qué recetario se va a usar ----------------
function actualizarMembrete() {
  const p = perfil(), sel = $("#sel-membrete"), inst = p.institucion;
  $("#opt-institucion").textContent = inst.nombre || "Institución (sin cargar)";
  $("#opt-institucion").disabled = !inst.nombre;
  const fijo = !!inst.nombre && Catalogos.obraSocialCanonica(campo("cobertura.obra_social").value) === "PAMI";
  // Con PAMI queda fijo el de la institución; al cambiar a otra obra social vuelve el que había elegido el médico
  if (fijo) sel.value = "institucional";
  else if (sel.disabled) sel.value = estado.membreteElegido || "personal";
  if (!inst.nombre) sel.value = "personal";
  sel.disabled = fijo;
  $("#aviso-membrete").innerHTML = fijo ? `PAMI: siempre el recetario de <strong>${esc(inst.nombre)}</strong>`
    : sel.value === "institucional" ? `Se usará el recetario de <strong>${esc(inst.nombre)}</strong>` : "Se usará <strong>tu recetario personal</strong>";
}

// ---------------- Pacientes (de los pedidos guardados) ----------------
const clavePaciente = (d) => (d.paciente.dni || "").replace(/\D/g, "") || Catalogos.normalizar(`${d.paciente.apellido} ${d.paciente.nombre}`);
function pacientes() {
  const m = new Map();
  for (const o of vivos("pedidos").sort((a, b) => (b.fecha + b.actualizado).localeCompare(a.fecha + a.actualizado))) {
    const k = clavePaciente(o.datos);
    if (!k) continue;
    if (!m.has(k)) m.set(k, { clave: k, ultimo: o, pedidos: [] });
    m.get(k).pedidos.push(o);
  }
  return [...m.values()];
}
function verPacientes() {
  const q = Catalogos.normalizar($("#in-buscar-paciente").value);
  const lista = pacientes().filter((p) => !q || Catalogos.normalizar(`${p.ultimo.datos.paciente.apellido} ${p.ultimo.datos.paciente.nombre} ${p.ultimo.datos.paciente.dni}`).includes(q));
  $("#lista-pacientes").innerHTML = lista.length ? lista.slice(0, 100).map((p, i) => {
    const d = p.ultimo.datos;
    return `<div class="item" data-i="${i}"><span><strong>${esc(d.paciente.apellido)}${d.paciente.nombre ? ", " + esc(d.paciente.nombre) : ""}</strong>
      <span class="sub">DNI ${esc(d.paciente.dni || "—")} · ${esc(d.cobertura.obra_social || "sin obra social")}</span></span>
      <span class="sub">${esc(p.ultimo.titulo)} · ${fechaCorta(p.ultimo.fecha)}</span></div>`;
  }).join("") : `<p class="ayuda">${q ? "No hay pacientes con ese apellido o DNI." : "Todavía no hay pedidos guardados."}</p>`;
  $$("#lista-pacientes .item").forEach((el) => el.addEventListener("click", () => abrirFicha(lista[+el.dataset.i])));
}
function abrirFicha(p) {
  const caja = $("#ficha-paciente"), d = p.ultimo.datos;
  caja.hidden = false;
  caja.innerHTML = `<h2>${esc(d.paciente.apellido)}${d.paciente.nombre ? ", " + esc(d.paciente.nombre) : ""}</h2>
    <p class="ayuda">DNI ${esc(d.paciente.dni || "—")} · ${esc(d.cobertura.obra_social || "sin obra social")}${d.cobertura.nro_afiliado ? " · Afiliado " + esc(d.cobertura.nro_afiliado) : ""}${d.paciente.telefono ? " · Tel. " + esc(d.paciente.telefono) : ""}${d.clinica.diagnostico ? "<br>Diagnóstico: " + esc(d.clinica.diagnostico) : ""}</p>
    <button class="boton" id="btn-nuevo-con-datos">Nuevo pedido con estos datos</button>
    <h3>Pedidos</h3>
    ${p.pedidos.map((o, i) => `<div class="item" style="cursor:default"><span>${esc(o.titulo)} <span class="sub">${fechaCorta(o.fecha)}</span></span>
      <span class="fila" style="margin:0">${o.archivo ? `<a class="boton chico secundario" href="${esc(o.archivo.link)}" target="_blank" rel="noopener">PDF</a>` : ""}
      <button class="boton chico secundario" data-repetir="${i}">Repetir</button><button class="quitar" data-borrar="${i}" title="Borrar">×</button></span></div>`).join("")}`;
  $("#btn-nuevo-con-datos").onclick = () => {
    cargarDatos({ paciente: d.paciente, cobertura: d.cobertura, clinica: d.clinica });
    ir("nuevo");
  };
  $$("[data-repetir]", caja).forEach((b) => (b.onclick = () => {
    const o = p.pedidos[+b.dataset.repetir];
    cargarDatos(o.datos); ir("nuevo");
    $$("[data-generar]").forEach((x) => x.classList.toggle("recomendado", x.dataset.generar === o.tipo));
    toast("Pedido cargado: revisalo y generalo de nuevo.", 4000);
  }));
  $$("[data-borrar]", caja).forEach((b) => (b.onclick = async () => {
    const o = p.pedidos[+b.dataset.borrar];
    if (!confirm(`¿Borrar «${o.titulo}» del ${fechaCorta(o.fecha)}? (El PDF del Drive no se toca; se puede recuperar desde un respaldo.)`)) return;
    await Almacen.borrar("pedidos", o.id);
    caja.hidden = true; verPacientes();
  }));
  caja.scrollIntoView({ behavior: "smooth" });
}

// ---------------- Kits (ABM) ----------------
function verKits() {
  const cont = $("#lista-kits");
  cont.innerHTML = "";
  for (const [cat, lista] of agrupar(vivos("kits"))) {
    cont.insertAdjacentHTML("beforeend", `<div class="categoria-titulo">${esc(cat)}</div>`);
    lista.forEach((k) => {
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML = `<span>${esc(k.nombre)} <span class="sub">(${k.items.length} ítems)</span></span>` + (k.borrador ? '<span class="badge">BORRADOR</span>' : '<span class="badge ok">VALIDADO</span>');
      d.onclick = () => abrirEditorKit(k);
      cont.append(d);
    });
  }
}
function abrirEditorKit(k) {
  estado.kitEditando = k;
  $("#editor-kit").hidden = false;
  $("#editor-kit-titulo").textContent = k ? "Editar kit" : "Nuevo kit";
  $("#kit-categoria").value = k?.categoria || ""; $("#kit-nombre").value = k?.nombre || ""; $("#kit-notas").value = k?.notas || "";
  $("#kit-validado").checked = k ? !k.borrador : true;
  const tbody = $("#tabla-kit tbody");
  tbody.innerHTML = "";
  (k?.items || [{ cantidad: "1", descripcion: "" }]).forEach((i) => filaMaterial(tbody, i));
  $("#btn-kit-borrar").hidden = !k;
  $("#editor-kit").scrollIntoView({ behavior: "smooth" });
}
async function guardarKit() {
  const kit = { categoria: $("#kit-categoria").value.trim(), nombre: $("#kit-nombre").value.trim(), notas: $("#kit-notas").value.trim(),
    borrador: !$("#kit-validado").checked, items: leerFilas($("#tabla-kit tbody")) };
  if (!kit.categoria || !kit.nombre || !kit.items.length) return toast("Completá categoría, nombre y al menos un ítem.");
  await Almacen.guardar("kits", { ...(estado.kitEditando || {}), ...kit });
  $("#editor-kit").hidden = true;
  verKits(); renderSelectorKits();
  toast("Kit guardado");
}

// ---------------- Configuración ----------------
const IMAGENES = { logo_personal: 1000, firma: 1000, logo_institucion: 1000, insignia_institucion: 500 };
function verConfig() {
  const p = perfil();
  $$("[data-medico]").forEach((el) => (el.value = p.medico[el.dataset.medico] || ""));
  $$("[data-inst]").forEach((el) => (el.value = p.institucion[el.dataset.inst] || ""));
  $$("[data-imagen]").forEach(renderImagen);
  $("#min-bloqueo").value = String(ajuste("minutos_bloqueo", 15));
  $("#version-app").textContent = "Versión " + VERSION_APP;
  const cuenta = Almacen.cuenta;
  $("#cuenta-estado").innerHTML = cuenta ? `Conectada a Google Drive: <b>${esc(cuenta)}</b> · ${esc(Almacen.estado)}${datos().ultima_sync ? " · última sincronización " + new Date(datos().ultima_sync).toLocaleString("es-AR") : ""}`
    : "Sin Google Drive: los datos quedan solo en este dispositivo. <a href='#' id='conectar-config'>Conectar</a>";
  $("#conectar-config")?.addEventListener("click", (e) => { e.preventDefault(); conectar(); });
  $("#sincronizar").hidden = !cuenta;
  $("#abrir-drive").hidden = true;
  if (cuenta && Almacen.tieneToken()) Almacen.enlaceCarpeta([]).then((l) => { $("#abrir-drive").href = l; $("#abrir-drive").hidden = false; }).catch(() => {});
  $("#registro-drive").innerHTML = Almacen.registro.length ? `<p class="ayuda">Últimos avisos de Google Drive:</p><ul class="ayuda">${Almacen.registro.slice(0, 8).map((r) => `<li>${esc(r.cuando)}: ${esc(r.texto)}</li>`).join("")}</ul>` : "";
}
function renderImagen(caja) {
  const nombre = caja.dataset.imagen, src = perfil().imagenes[nombre];
  caja.innerHTML = `<span>${esc(caja.dataset.titulo)}</span>${src ? `<img src="${src}" alt="">` : "<p>(sin imagen)</p>"}
    <div class="fila"><label class="boton chico secundario">Subir<input type="file" accept="image/*" hidden></label>
    ${src ? '<button class="boton chico peligro">Quitar</button>' : ""}</div>`;
  $("input", caja).addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await guardarImagen(nombre, await achicarImagen(f, IMAGENES[nombre])); renderImagen(caja); toast("Imagen guardada"); }
    catch (err) { toast("No se pudo usar esa imagen: " + err.message); }
  });
  $("button.peligro", caja)?.addEventListener("click", async () => { if (confirm("¿Quitar esta imagen?")) { await guardarImagen(nombre, null); renderImagen(caja); } });
}
async function guardarImagen(nombre, dataUrl) {
  const imgs = { ...perfil().imagenes };
  if (dataUrl) imgs[nombre] = dataUrl; else delete imgs[nombre];
  await Almacen.ajuste("imagenes", imgs);
}
// PNG (conserva la transparencia de firma y sello) de hasta `lado` px. Acepta un archivo o una imagen ya cargada.
async function achicarImagen(f, lado) {
  const bmp = f instanceof Blob ? await createImageBitmap(f, { imageOrientation: "from-image" }) : f;
  const e = Math.min(1, lado / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
  c.width = Math.round(bmp.width * e); c.height = Math.round(bmp.height * e);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}
async function guardarPerfil(clave, selector, atributo) {
  await Almacen.ajuste(clave, { ...ajuste(clave, {}), ...Object.fromEntries($$(selector).map((el) => [el.dataset[atributo], el.value.trim()])) });
  actualizarMembrete();
  toast("Guardado");
}

// Archivo que exporta la versión PC (scripts/exportar_para_celular.py): perfil, imágenes, kits y combos. Se suma a lo que hay.
async function importarConfiguracion(archivo) {
  let c;
  try { c = JSON.parse(await archivo.text()); } catch { return toast("El archivo no es una configuración de Pedidos."); }
  if (c.app !== "pedidos-pc") return toast("El archivo no es una configuración de Pedidos (versión PC).");
  if (!confirm("¿Importar la configuración de la PC? Se cargan tus recetarios, firma, kits y combos. Los kits y combos que ya tengas acá se mantienen; los que tengan el mismo nombre se actualizan.")) return;
  if (c.medico) await Almacen.ajuste("medico", { ...ajuste("medico", {}), ...Object.fromEntries(Object.entries(c.medico).filter(([, v]) => v)) });
  if (c.institucion) await Almacen.ajuste("institucion", { ...ajuste("institucion", {}), ...Object.fromEntries(Object.entries(c.institucion).filter(([, v]) => v)) });
  if (c.imagenes) {
    const imgs = {};
    for (const [nombre, src] of Object.entries(c.imagenes)) {
      if (!(nombre in IMAGENES)) continue;
      const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error("imagen dañada: " + nombre)); i.src = src; });
      imgs[nombre] = await achicarImagen(img, IMAGENES[nombre]);
    }
    await Almacen.ajuste("imagenes", { ...perfil().imagenes, ...imgs });
  }
  const porNombre = (col, x) => vivos(col).find((y) => y.id === x.id || y.nombre.toLowerCase() === x.nombre.toLowerCase());
  if (c.kits?.length) await Almacen.guardarVarios("kits", c.kits.map((k) => ({ ...k, id: porNombre("kits", k)?.id || k.id })));
  if (c.combos?.length) await Almacen.guardarVarios("combos", c.combos.map((k) => ({ ...k, id: porNombre("combos", k)?.id || k.id })));
  verConfig(); renderSelectorKits(); renderCombos(); actualizarMembrete();
  toast(`Configuración importada: ${c.kits?.length || 0} kits, ${c.combos?.length || 0} combos, ${Object.keys(c.imagenes || {}).length} imágenes.`, 5000);
}

async function verRespaldos() {
  if (!Almacen.tieneToken()) return renovarAcceso() || toast("Conectá Google Drive primero.");
  const lista = await Almacen.respaldos();
  $("#respaldos").innerHTML = lista.length ? lista.slice(0, 30).map((r) => `<div class="item" style="cursor:default"><span>${fechaCorta(r.dia)}</span>
    <button class="boton chico secundario" data-respaldo="${esc(r.id)}" data-dia="${fechaCorta(r.dia)}">Recuperar</button></div>`).join("") : '<p class="ayuda">Todavía no hay respaldos.</p>';
}

// ---------------- Cuenta, PIN, sincronización ----------------
function conectar() { try { Almacen.conectar(); } catch (e) { toast(e.message); } }
// Acceso de Google vencido (dura 1 h): se renueva sin pedir nada (va a Google y vuelve). false si no hay cuenta.
function renovarAcceso() {
  if (!Almacen.cuenta) return false;
  sessionStorage.setItem("ped_silencioso", "1");
  Almacen.conectar({ silencioso: true });
  return true;
}
function mostrarSync(e) {
  const cuenta = Almacen.cuenta;
  $("#sync").textContent = cuenta ? (e === "al día" ? "☁️ al día" : e) : Almacen.local ? "solo en este dispositivo" : "";
  $("#subir-ahora").hidden = !(cuenta && e === "cambios sin subir");
}

function bienvenida(mensaje) {
  $("#bienvenida-aviso").textContent = mensaje || "";
  $("#bienvenida-aviso").hidden = !mensaje;
  ir("bienvenida");
}

const TEXTOS_PIN = {
  crear: ["Creá tu PIN", "Protege los datos de tus pacientes en este dispositivo: quedan cifrados y solo se abren con el PIN. Mínimo 6 números. No se puede recuperar: anotalo en un lugar seguro.", "Crear PIN"],
  desbloquear: ["Desbloquear", "Ingresá tu PIN.", "Entrar"],
  cambiar: ["Cambiar PIN", "Ingresá el PIN actual y el nuevo (mínimo 6 números).", "Cambiar"],
};
function pedirPin(modo) {
  estado.modoPin = modo;
  const [titulo, ayuda, boton] = TEXTOS_PIN[modo];
  $("#pin-titulo").textContent = titulo; $("#pin-ayuda").textContent = ayuda; $("#pin-ok").textContent = boton;
  $("#pin2").hidden = modo === "desbloquear";
  $("#pin").placeholder = modo === "cambiar" ? "PIN actual" : "PIN";
  $("#pin2").placeholder = modo === "cambiar" ? "PIN nuevo" : "Repetí el PIN";
  $("#olvide-pin").hidden = modo === "crear";
  $("#olvide-pin").textContent = modo === "cambiar" ? "Cancelar" : "Olvidé mi PIN";
  $("#pin-error").hidden = true;
  ir("pin");
  setTimeout(() => $("#pin").focus(), 50);
}

let entro = false;
function entrar() {
  $("#pin").value = $("#pin2").value = "";
  Almacen.minutosBloqueo = +ajuste("minutos_bloqueo", 15);
  mostrarSync(Almacen.estado);
  const listo = () => { renderSelectorKits(); renderCombos(); actualizarMembrete(); };
  listo();
  if (!entro) ir(perfil().medico.apellido ? "nuevo" : "config");
  else ir("nuevo");
  if (!perfil().medico.apellido && !entro) toast("Primero cargá tu recetario: nombre, matrícula y firma.", 5000);
  entro = true;
  // Al entrar: traer lo cargado en otros dispositivos (kits, combos, perfil) y después sembrar lo inicial si hace falta
  const despues = () => sembrar().then(listo).catch((e) => toast(e.message));
  if (Almacen.tieneToken()) Almacen.sincronizar().then(listo, (e) => toast(e.message)).finally(despues);
  else { if (Almacen.doc.cuenta) mostrarSync("cambios sin subir"); despues(); }
}

async function bloquearYa() {
  await Almacen.bloquear();
  location.reload(); // no queda en memoria ni en pantalla ningún dato de pacientes
}

function configurarSeguridad() {
  $("#form-pin").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pin = $("#pin").value, pin2 = $("#pin2").value, error = $("#pin-error"), boton = $("#pin-ok");
    const mostrar = (t) => { error.textContent = t; error.hidden = false; $("#pin").value = ""; $("#pin").focus(); };
    const valido = (x) => /^\d{6,12}$/.test(x);
    error.hidden = true; boton.disabled = true;
    try {
      if (estado.modoPin === "desbloquear") await Almacen.desbloquear(pin);
      else if (estado.modoPin === "crear") {
        if (!valido(pin)) return mostrar("El PIN tiene que tener entre 6 y 12 números.");
        if (pin !== pin2) { $("#pin2").value = ""; return mostrar("Los dos PIN no coinciden."); }
        await Almacen.crearPin(pin);
      } else {
        if (!valido(pin2)) return mostrar("El PIN nuevo tiene que tener entre 6 y 12 números.");
        await Almacen.cambiarPin(pin, pin2);
        toast("PIN cambiado");
      }
      entrar();
    } catch (e) { mostrar(e.message); }
    finally { boton.disabled = false; }
  });
  $("#olvide-pin").addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (estado.modoPin === "cambiar") return ir("config");
    if (!confirm("Sin el PIN, los datos de este dispositivo no se pueden abrir: se van a borrar.\n\nSi tenías Google Drive conectado, después entrás de nuevo y se recupera lo que ya estaba copiado allá. ¿Borrar y empezar de nuevo?")) return;
    if (Almacen.pendiente && !confirm("⚠️ ATENCIÓN: en este dispositivo hay cambios que todavía NO se subieron a Google Drive. Si seguís, esos cambios no se van a poder recuperar.\n\n¿Seguro?")) return;
    await Almacen.olvidePin();
    location.reload();
  });
  // Bloqueo automático: N minutos sin tocar la app, o al volver a ella después de ese tiempo
  let ultima = Date.now();
  ["pointerdown", "keydown", "input"].forEach((e) => document.addEventListener(e, () => { ultima = Date.now(); Almacen.tocar(); }, { passive: true, capture: true }));
  const controlar = () => {
    if (Almacen.tienePin() && !Almacen.bloqueada() && Date.now() - ultima > +ajuste("minutos_bloqueo", 15) * 60e3) bloquearYa();
  };
  setInterval(controlar, 15000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && controlar());
}

// ---------------- Actualizaciones de la app ----------------
const VERSION_APP = "1"; // igual que VERSION en sw.js
function registrarActualizaciones() {
  if (!("serviceWorker" in navigator)) return;
  const habia = !!navigator.serviceWorker.controller;
  let reg = null, pendiente = false, ultimaBusqueda = 0;
  const buscar = () => { if (!reg || Date.now() - ultimaBusqueda < 10e3) return; ultimaBusqueda = Date.now(); reg.update().catch(() => {}); };
  // Se aplica sola si no hay un pedido a medio cargar; si no, se avisa y se aplica al volver a entrar
  const ocupado = () => !$("#v-nuevo").hidden && $$("[data-campo]").some((el) => el.value.trim());
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => { reg = r; buscar(); }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!habia) return;
    pendiente = true;
    if (!ocupado()) location.reload(); else toast("Hay una versión nueva: se aplica al terminar este pedido (o en «Buscar actualización»).", 6000);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (pendiente && !ocupado()) location.reload(); else buscar();
  });
  setInterval(buscar, 30 * 60e3);
}
async function actualizarAhora() {
  try {
    for (const k of await caches.keys()) if (!k.includes("libs")) await caches.delete(k);
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.update();
  } catch { /* sin service worker */ }
  location.reload();
}

// ---------------- Inicio ----------------
async function arrancar() {
  const vuelta = Almacen.recibirToken(); // {ok} | {error} | null
  await Promise.all([Almacen.iniciar(), Catalogos.cargar()]);
  Almacen.alCambiar = mostrarSync;
  configurarAutocompletar();
  configurarSeguridad();
  registrarActualizaciones();

  $$("nav.abajo button").forEach((b) => b.addEventListener("click", () => ir(b.dataset.vista)));
  $$("[data-ir]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); ir(a.dataset.ir); }));
  $("#in-camara").addEventListener("change", (e) => { agregarArchivos(e.target.files); e.target.value = ""; });
  $("#in-archivos").addEventListener("change", (e) => { agregarArchivos(e.target.files); e.target.value = ""; });
  document.addEventListener("paste", (e) => {
    if ($("#v-nuevo").hidden) return;
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { agregarArchivos(imgs); toast("Captura agregada"); }
  });
  $("#btn-extraer").addEventListener("click", leerDocumentos);
  document.addEventListener("input", (e) => e.target.classList?.remove("dudoso"));
  campo("clinica.procedimiento").addEventListener("change", sugerirKit);
  $("#sel-kit").addEventListener("change", (e) => aplicarKit(e.target.value));
  $("#btn-agregar-material").addEventListener("click", () => $(".desc", filaMaterial($("#tabla-materiales tbody"))).focus());
  $("#sel-combo").addEventListener("change", (e) => aplicarCombo(e.target.value));
  $("#btn-guardar-combo").addEventListener("click", guardarCombo);
  $("#btn-borrar-combo").addEventListener("click", borrarCombo);
  $("#btn-agregar-medicamento").addEventListener("click", () => agregarMedicamento());
  $("#btn-armar-resumen").addEventListener("click", armarResumen);
  $$("[data-generar]").forEach((b) => b.addEventListener("click", () => generar(b.dataset.generar, b)));
  let tm; campo("cobertura.obra_social").addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(actualizarMembrete, 300); });
  $("#sel-membrete").addEventListener("change", () => { estado.membreteElegido = $("#sel-membrete").value; actualizarMembrete(); });
  $("#btn-compartir").addEventListener("click", () => compartir(estado.ultimo.pdf, estado.ultimo.nombre, "application/pdf"));
  $("#btn-compartir-imagen").addEventListener("click", () => compartir(estado.ultimo.png, estado.ultimo.nombre.replace(/\.pdf$/, ".png"), "image/png"));
  $("#btn-descargar-imagen").addEventListener("click", () => { descargar(estado.ultimo.png, estado.ultimo.nombre.replace(/\.pdf$/, ".png")); toast("Imagen descargada: adjuntala en WhatsApp con el clip 📎", 4000); });
  $("#btn-copiar-imagen").addEventListener("click", async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": estado.ultimo.png })]); toast("Recetario copiado: pegalo con Ctrl+V en el chat", 4000); }
    catch (e) { toast("No se pudo copiar la imagen: " + e.message, 5000); }
  });
  $("#btn-copiar").addEventListener("click", async () => toast(await copiar(estado.ultimo.texto) ? "Texto copiado" : "No se pudo copiar; seleccioná el texto a mano."));
  $("#btn-copiar-carga").addEventListener("click", async () => toast(await copiar(estado.ultimo.carga) ? "Resumen copiado" : "No se pudo copiar"));
  $("#btn-limpiar").addEventListener("click", () => confirm("¿Borrar todos los datos del paciente actual del formulario? (Los pedidos ya generados quedan en Pacientes.)") && limpiarFormulario());

  let tb; $("#in-buscar-paciente").addEventListener("input", () => { clearTimeout(tb); tb = setTimeout(verPacientes, 200); });
  $("#btn-nuevo-kit").addEventListener("click", () => abrirEditorKit(null));
  $("#btn-kit-agregar").addEventListener("click", () => $(".desc", filaMaterial($("#tabla-kit tbody"))).focus());
  $("#btn-kit-cancelar").addEventListener("click", () => ($("#editor-kit").hidden = true));
  $("#btn-kit-guardar").addEventListener("click", () => guardarKit().catch((e) => toast(e.message)));
  $("#btn-kit-borrar").addEventListener("click", async () => {
    const k = estado.kitEditando;
    if (!k || !confirm(`¿Borrar el kit "${k.nombre}"?`)) return;
    await Almacen.borrar("kits", k.id);
    $("#editor-kit").hidden = true; verKits(); renderSelectorKits();
    toast("Kit borrado");
  });

  $("#btn-guardar-medico").addEventListener("click", () => guardarPerfil("medico", "[data-medico]", "medico").then(() => ($("#falta-perfil").hidden = !!perfil().medico.apellido)));
  $("#btn-guardar-inst").addEventListener("click", () => guardarPerfil("institucion", "[data-inst]", "inst"));
  $("#min-bloqueo").addEventListener("change", async () => { await Almacen.ajuste("minutos_bloqueo", +$("#min-bloqueo").value); Almacen.minutosBloqueo = +$("#min-bloqueo").value; toast("Guardado"); });
  $("#cambiar-pin").addEventListener("click", () => pedirPin("cambiar"));
  $("#bloquear").addEventListener("click", bloquearYa);
  $("#sincronizar").addEventListener("click", () => (Almacen.tieneToken() ? Almacen.sincronizar().then(() => { verConfig(); toast("Al día con Google Drive"); }).catch((e) => toast(e.message)) : renovarAcceso()));
  $("#subir-ahora").addEventListener("click", () => renovarAcceso());
  $("#ver-respaldos").addEventListener("click", () => verRespaldos().catch((e) => toast(e.message)));
  $("#respaldos").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-respaldo]");
    if (!b || !confirm(`¿Recuperar desde el respaldo del ${b.dataset.dia}? Vuelve lo que falta o se borró; no cambia lo que tenés hoy.`)) return;
    try { const n = await Almacen.recuperarRespaldo(b.dataset.respaldo); toast(n ? `${n} registros recuperados.` : "No faltaba nada."); renderSelectorKits(); renderCombos(); }
    catch (e) { toast(e.message); }
  });
  $("#copia-bajar").addEventListener("click", async () => {
    const clave = prompt("Elegí una clave para la copia (mínimo 6 caracteres). Anotala: sin ella la copia no se puede abrir.");
    if (!clave) return;
    if (clave.length < 6) return toast("La clave tiene que tener al menos 6 caracteres.");
    descargar(new Blob([await Almacen.exportarCopia(clave)], { type: "application/json" }), `Pedidos copia ${hoy()}.json`);
    await Almacen.marcarCopia();
    toast("Copia descargada (cifrada). Guardala fuera del dispositivo.");
  });
  $("#copia-subir").addEventListener("change", async (ev) => {
    const a = ev.target.files[0]; ev.target.value = "";
    if (!a) return;
    const clave = prompt("Clave de la copia:");
    if (!clave) return;
    try { toast(`Copia restaurada: ${await Almacen.importarCopia(await a.text(), clave)} pedidos nuevos (lo que ya tenías se mantiene).`); renderSelectorKits(); renderCombos(); }
    catch (e) { toast(e.message); }
  });
  $("#importar-pc").addEventListener("change", (ev) => { const a = ev.target.files[0]; ev.target.value = ""; if (a) importarConfiguracion(a).catch((e) => toast(e.message)); });
  $("#actualizar-app").addEventListener("click", (ev) => { ev.preventDefault(); toast("Buscando la versión nueva…"); actualizarAhora(); });
  $("#salir").addEventListener("click", async () => {
    if (Almacen.pendiente && Almacen.cuenta) return toast("Hay cambios sin subir a Google Drive: tocá «Sincronizar ahora» antes de cerrar la cuenta.", 6000);
    if (!Almacen.cuenta && !confirm("Sin Google Drive, cerrar la cuenta BORRA los datos de este dispositivo. ¿Seguro?")) return;
    if (!confirm("¿Cerrar la cuenta en este dispositivo? Tus datos siguen en tu Google Drive.")) return;
    await Almacen.desconectar();
    location.reload();
  });
  $("#conectar-inicio").addEventListener("click", conectar);
  $("#sin-drive").addEventListener("click", async (ev) => {
    ev.preventDefault();
    await Almacen.usarLocal();
    Almacen.tienePin() ? pedirPin("desbloquear") : pedirPin("crear");
  });
  // Al volver a la app con cambios sin subir y el acceso vencido: renovarlo y subir
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Almacen.bloqueada() || !Almacen.doc.cuenta) return;
    if (Almacen.tieneToken()) { if (Almacen.pendiente) Almacen.sincronizar().catch(() => {}); }
  });
  window.addEventListener("online", () => Almacen.tieneToken() && Almacen.sincronizar().catch(() => {}));

  const cuenta = Almacen.cuenta, local = Almacen.local && !cuenta;
  // 1) Cuenta de Google primero (el PIN viene después)
  if (vuelta?.error) {
    sessionStorage.removeItem("ped_silencioso");
    if (!cuenta || (vuelta.error !== "interaction_required" && vuelta.error !== "login_required")) return bienvenida("No se pudo ingresar con Google. Probá de nuevo.");
    return bienvenida(`Tu sesión de Google venció: ingresá de nuevo con ${cuenta}.`);
  }
  if (!cuenta && !vuelta?.ok && !local) return bienvenida();
  // 2) Acceso a Drive vencido (dura 1 hora): renovarlo sin pedir nada, antes del PIN. Una vez por apertura.
  if (cuenta && !vuelta?.ok && Almacen.accesoVencido() && !sessionStorage.getItem("ped_silencioso")) return renovarAcceso();
  sessionStorage.removeItem("ped_silencioso");
  // 3) PIN
  if (Almacen.tienePin()) return Almacen.bloqueada() ? pedirPin("desbloquear") : entrar();
  pedirPin("crear");
}

arrancar().catch((e) => { document.body.insertAdjacentHTML("afterbegin", `<div class="alerta error">No se pudo abrir la app: ${esc(e.message)}</div>`); });
