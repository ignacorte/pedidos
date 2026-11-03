// Asistente de IA: «modificá esto y esto» sobre el pedido en pantalla. Usa modelos abiertos (Llama, gpt-oss) en Groq, con
// plan gratuito y la clave propia de cada médico (guardada solo en su dispositivo, cifrada con el PIN). Groq no entrena con
// lo que recibe y permite «retención cero». Seguridad:
// 1. Nunca se manda la identidad del paciente: ni nombre, ni DNI, ni afiliado, ni teléfono, ni email (se tapan también
//    en los textos libres y en lo leído de una foto).
// 2. Antes de mandar, el médico ve exactamente lo que sale (y puede borrar lo que quiera).
// 3. Control final: si en lo que sale aparece cualquier dato del paciente, no se manda.
// 4. La IA solo propone: el médico ve cada cambio y elige cuáles aplicar (y puede deshacer).
// (Se descartó OpenRouter: varios de sus modelos gratuitos corren en servicios que pueden entrenar con los datos.)
const Asistente = (() => {
  const PROVEEDORES = {
    groq: { nombre: "Groq", url: "https://api.groq.com/openai/v1", modelo: "openai/gpt-oss-120b", claves: "https://console.groq.com/keys", json: true },
  };

  // Modelos abiertos de Groq, del mejor al más simple, por si el elegido deja de estar disponible
  const PREFERIDOS = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"];

  // La IA devuelve SOLO la lista de campos que cambia (no el pedido entero): así no toca lo que no se pidió
  const INSTRUCCIONES = `Sos el asistente de un cirujano general argentino dentro de su app de pedidos médicos (estudios, materiales, autorización de cirugía, resumen de historia clínica y receta).
Recibís el pedido actual en JSON ("pedido"), la fecha de hoy ("hoy"), la indicación del médico ("indicacion") y a veces el texto leído de un documento viejo ("documento_viejo", con posibles errores de lectura).
Respondé SOLO un objeto JSON así:
{"cambios": [{"campo": "<campo>", "valor": <valor nuevo>}], "_nota": "<frase corta para el médico, o vacío>"}
Campos posibles (texto): "clinica.diagnostico", "clinica.procedimiento", "clinica.lateralidad", "clinica.caracter", "autorizacion.fecha_probable", "autorizacion.fundamento", "autorizacion.resumen_estudios", "observaciones", "obra_social".
Campos posibles (lista completa nueva, reemplaza a la anterior): "estudios" [{"codigo","descripcion"}], "materiales" [{"cantidad","descripcion"}], "medicamentos" [{"nombre_generico","presentacion","cantidad","posologia"}].
Dónde va cada cosa:
- Autorización («Solicito: Autorización para X»): X es "clinica.procedimiento". «Cambiá la autorización / el procedimiento a Y» = UN solo cambio en "clinica.procedimiento" con Y redactado como procedimiento médico completo y correcto.
- Pedido de estudios = "estudios"; pedido de materiales = "materiales"; receta = "medicamentos".
- "autorizacion.fundamento" y "autorizacion.resumen_estudios" son el resumen de historia clínica: cambialos SOLO si el médico pide cambiar el resumen (la app actualiza sola el resumen armado automáticamente).
- La FECHA DEL DOCUMENTO no es un campo: sale sola con la fecha de hoy al generarlo. Si piden «fecha de hoy» o «actualizar la fecha», devolvé "cambios": [] y explicalo en "_nota". "autorizacion.fecha_probable" es solo la fecha probable de la cirugía.
Reglas:
- Incluí SOLO los campos que el médico pidió cambiar. Nada más.
- La indicación puede tener errores de tipeo o de dictado (ej.: «basceso hepatic» = «absceso hepático»): escribí siempre el término médico correcto, con tildes y mayúscula inicial. Nunca copies la indicación tal cual dentro de un campo.
- No inventes datos clínicos que nadie mencionó.
- Si te piden tomar algo del documento viejo (por ejemplo «copiá los medicamentos de la receta»), pasalo al campo que corresponda.
- El documento viejo es un recetario: membrete, institución, lema, datos y sello del médico (nombre, matrícula M.P./M.E., especialidad), firma, «Rp/» y pie NO son datos del pedido. Nunca los copies.
- Medicamentos: nombre_generico (genérico, sin marca, salvo que el médico la pida), presentacion (ej.: «comprimidos 500 mg»), cantidad (número de envases), posologia (ej.: «1 comprimido cada 8 h por 5 días»).
- En estudios nuevos dejá "codigo" vacío (la app lo busca en el nomenclador). En materiales "cantidad" es texto.
- "clinica.lateralidad" solo puede ser "", "Derecha", "Izquierda" o "Bilateral"; "clinica.caracter" solo "", "Programada" o "Urgencia".
- Fechas DD/MM/AAAA ("hoy" sirve para «mañana», «en 15 días», etc.). Castellano rioplatense.
- "[PACIENTE]" reemplaza los datos personales del paciente: dejalo tal cual.`;

  const CAMPOS = { clinica: ["diagnostico", "cie10", "procedimiento", "lateralidad", "caracter"], autorizacion: ["fecha_probable", "fundamento", "resumen_estudios"] };
  const NOMBRES = { diagnostico: "Diagnóstico", cie10: "CIE-10", procedimiento: "Procedimiento (autorización)", lateralidad: "Lateralidad", caracter: "Carácter",
    fecha_probable: "Fecha probable", fundamento: "Resumen clínico", resumen_estudios: "Resumen de estudios", observaciones: "Observaciones",
    obra_social: "Obra social", estudios: "Estudios", materiales: "Materiales", medicamentos: "Medicamentos" };

  // Lo que puede ver la IA: la parte clínica, sin nada que identifique al paciente
  function sinIdentidad(d) {
    return {
      obra_social: d.cobertura.obra_social || "",
      clinica: Object.fromEntries(CAMPOS.clinica.map((k) => [k, d.clinica[k] || ""])),
      autorizacion: Object.fromEntries(CAMPOS.autorizacion.map((k) => [k, d.autorizacion[k] || ""])),
      estudios: d.estudios.map(({ codigo, descripcion }) => ({ codigo: codigo || "", descripcion })),
      materiales: d.materiales.map(({ cantidad, descripcion }) => ({ cantidad: cantidad || "", descripcion })),
      medicamentos: d.medicamentos.map((m) => ({ nombre_generico: m.nombre_generico || "", presentacion: m.presentacion || "", cantidad: m.cantidad || "", posologia: m.posologia || "" })),
      observaciones: d.observaciones || "",
    };
  }

  // Quita de un texto los datos del paciente (con o sin tildes, en cualquier mayúscula) y todo lo que parezca un documento,
  // afiliado, teléfono o email. En lo leído de una foto se tapan además los renglones de datos personales.
  const ETIQUETAS = /^.*\b(paciente|nombre|apellido|d\.?n\.?i|documento|afiliad|beneficio|credencial|domicilio|direcci[oó]n|tel[eé]fono|celular|e-?mail|correo|cuil|cuit|historia cl[ií]nica n|h\.?c\.?\s*n)\b.*$/gim;
  const VOCALES = { a: "aáàäâ", e: "eéèëê", i: "iíìïî", o: "oóòöô", u: "uúùüû", n: "nñ", c: "cç" };
  const patron = (w) => new RegExp(`(?<![\\p{L}\\d])${[...Catalogos.normalizar(w)].map((ch) => (VOCALES[ch] ? `[${VOCALES[ch]}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}(?![\\p{L}\\d])`, "giu");
  function tapar(texto, paciente = {}, { renglones = false } = {}) {
    if (!texto) return "";
    let t = String(texto);
    for (const w of [paciente.apellido, paciente.nombre].join(" ").split(/[\s,]+/).filter((x) => x.length > 2)) t = t.replace(patron(w), "[PACIENTE]");
    if (renglones) t = t.replace(ETIQUETAS, "[PACIENTE]");
    return t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[PACIENTE]")
      .replace(/\b\d{1,2}\.\d{3}\.\d{3}\b/g, "[PACIENTE]") // DNI con puntos
      .replace(/\+?\d[\d \t().-]{5,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? "[PACIENTE]" : m)); // DNI, afiliado, teléfono (no fechas: llevan «/»)
  }

  // Membrete del recetario (datos del médico y de la institución, matrícula, lema, «Rp/»): no es parte del pedido
  const MATRICULA = /\bM\.?\s?[PEN]\.?\s*:?\s*\d/i, ADORNOS = /^\s*rp\s*\/?\s*$|calidad y calidez|acreditad/i;
  const deMembrete = (linea, quitar = []) => MATRICULA.test(linea) || ADORNOS.test(linea) ||
    quitar.some((q) => {
      if (!q) return false;
      if (!q.includes(" ")) return patron(q).test(linea);
      const l = Catalogos.normalizar(linea), n = Catalogos.normalizar(q);
      return l.includes(n) || (l.length >= 6 && n.includes(l)); // también el nombre partido en dos renglones («Instituto Médico» / «Río Cuarto»)
    });
  const sinMembrete = (texto, quitar) => String(texto || "").split(/\r?\n/).filter((l) => !deMembrete(l, quitar)).join("\n");

  // Lo que se manda, tal cual (se puede ver antes de mandar). `quitar`: textos del membrete (médico, institución)
  function armarMensaje(d, instruccion, textoViejo, quitar = []) {
    const pedido = sinIdentidad(d);
    for (const g of ["clinica", "autorizacion"]) for (const k in pedido[g]) pedido[g][k] = tapar(pedido[g][k], d.paciente);
    pedido.observaciones = tapar(pedido.observaciones, d.paciente);
    pedido.obra_social = tapar(pedido.obra_social, d.paciente);
    const h = new Date(), hoy = `${String(h.getDate()).padStart(2, "0")}/${String(h.getMonth() + 1).padStart(2, "0")}/${h.getFullYear()}`;
    const partes = { hoy, pedido, indicacion: tapar(instruccion, d.paciente) };
    if (textoViejo) partes.documento_viejo = tapar(sinMembrete(textoViejo, quitar), d.paciente, { renglones: true }).slice(0, 6000);
    return partes;
  }

  function jsonDe(texto) {
    const t = String(texto || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { return JSON.parse(t); } catch {}
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    throw new Error("La IA no devolvió una respuesta que se pueda usar. Probá de nuevo o reformulá el pedido.");
  }

  async function llamar(conf, cuerpo, ms = 60000) {
    const p = PROVEEDORES[conf.proveedor];
    if (!p) throw new Error("Elegí el servicio de IA en Configuración.");
    if (!conf.clave) throw new Error("Falta tu clave del servicio de IA (Configuración › Asistente de IA).");
    if (!navigator.onLine) throw new Error("Sin conexión: el asistente necesita internet.");
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(p.url + "/chat/completions", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + conf.clave },
        body: JSON.stringify({ model: conf.modelo || p.modelo, temperature: 0.1, ...(p.json ? { response_format: { type: "json_object" } } : {}), ...cuerpo }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j.error?.message || r.statusText || "";
        // Modelo sin «modo JSON»: se repite pidiéndolo solo en las instrucciones
        if (r.status === 400 && !("response_format" in cuerpo) && /response_format|json/i.test(msg)) return llamar(conf, { ...cuerpo, response_format: undefined }, ms);
        if (r.status === 401 || r.status === 403) throw new Error("La clave no es válida (revisala en Configuración › Asistente de IA).");
        if (r.status === 429) throw new Error("Se llegó al límite gratuito del servicio por ahora. Esperá un rato y probá de nuevo.");
        if (r.status === 404 || /model/i.test(msg)) throw new Error(`El modelo «${conf.modelo || p.modelo}» no está disponible: elegí otro en Configuración › Asistente de IA. (${msg})`);
        throw new Error(`El servicio respondió con un error (${r.status}): ${msg}`);
      }
      return j.choices?.[0]?.message?.content || "";
    } catch (e) {
      if (e.name === "AbortError") throw new Error("La IA tardó demasiado en responder. Probá de nuevo.");
      throw e;
    } finally { clearTimeout(t); }
  }

  // Control final: datos del paciente que hayan quedado en lo que sale (nombre, apellido, DNI, afiliado, teléfono, email)
  function fugas(mensaje, d) {
    const crudo = JSON.stringify(mensaje), t = Catalogos.normalizar(crudo);
    const numeros = (crudo.match(/\d[\d .()\/-]*\d|\d/g) || []).map((x) => x.replace(/\D/g, ""));
    const hallado = [];
    for (const w of [d.paciente.apellido, d.paciente.nombre].join(" ").split(/[\s,]+/).filter((x) => x.length > 2))
      if (new RegExp(`\\b${Catalogos.normalizar(w)}\\b`).test(t)) hallado.push("nombre o apellido");
    for (const n of [d.paciente.dni, d.cobertura.nro_afiliado, d.paciente.telefono].map((x) => (x || "").replace(/\D/g, "")).filter((x) => x.length >= 6))
      if (numeros.some((x) => x.includes(n))) hallado.push("número de documento, afiliado o teléfono");
    if (d.paciente.email && t.includes(Catalogos.normalizar(d.paciente.email))) hallado.push("email");
    return [...new Set(hallado)];
  }

  async function proponer(conf, mensaje, d, quitar = []) {
    const f = fugas(mensaje, d);
    if (f.length) throw new Error(`No se mandó nada: quedaba un dato del paciente (${f.join(", ")}). Borralo del texto y probá de nuevo.`);
    const texto = await llamar(conf, { messages: [{ role: "system", content: INSTRUCCIONES }, { role: "user", content: JSON.stringify(mensaje) }] });
    let r = jsonDe(texto);
    // A veces la IA devuelve todo el mensaje ({hoy, pedido, indicacion}) en vez de solo el pedido
    if (r && typeof r.pedido === "object" && !r.clinica && !Array.isArray(r.cambios)) r = { ...r.pedido, _nota: r._nota ?? r.pedido._nota };
    if (Array.isArray(r?.cambios)) r = conCambios(mensaje.pedido, r.cambios, r._nota ?? r.nota);
    const out = limpiar(r, mensaje.pedido);
    // La indicación pegada dentro de un campo: se descarta ese cambio
    const ind = Catalogos.normalizar(mensaje.indicacion || "");
    const copiaIndicacion = (v) => ind.length >= 12 && Catalogos.normalizar(v).includes(ind.slice(0, Math.min(ind.length, 30)));
    const copiados = [];
    for (const [g, ks] of Object.entries(CAMPOS)) for (const k of ks)
      if (out[g][k] !== mensaje.pedido[g][k] && copiaIndicacion(out[g][k])) { out[g][k] = mensaje.pedido[g][k]; copiados.push(NOMBRES[k]); }
    if (out.observaciones !== mensaje.pedido.observaciones && copiaIndicacion(out.observaciones)) { out.observaciones = mensaje.pedido.observaciones; copiados.push(NOMBRES.observaciones); }
    if (copiados.length) out.nota = [out.nota, `Se descartó lo que la IA pegó de tu indicación en: ${copiados.join(", ")}.`].filter(Boolean).join(" ");
    // Texto del membrete metido en un campo: se descarta ese cambio
    const descartados = [];
    for (const [g, ks] of Object.entries(CAMPOS)) for (const k of ks)
      if (out[g][k] !== mensaje.pedido[g][k] && out[g][k].split(/\n|(?<=\.)\s/).some((l) => deMembrete(l, quitar))) { out[g][k] = mensaje.pedido[g][k]; descartados.push(NOMBRES[k]); }
    if (out.observaciones !== mensaje.pedido.observaciones && out.observaciones.split(/\n|(?<=\.)\s/).some((l) => deMembrete(l, quitar))) { out.observaciones = mensaje.pedido.observaciones; descartados.push(NOMBRES.observaciones); }
    if (descartados.length) out.nota = [out.nota, `Se descartó lo que la IA copió del membrete del recetario en: ${descartados.join(", ")}.`].filter(Boolean).join(" ");
    out.crudo = texto;
    return out;
  }

  // {"cambios": [{campo, valor}]} → pedido completo (lo no mencionado queda como estaba)
  function conCambios(antes, cambios, nota) {
    const r = JSON.parse(JSON.stringify(antes));
    for (const c of cambios) {
      if (!c || typeof c.campo !== "string") continue;
      const [g, k] = c.campo.split(".");
      if (k && CAMPOS[g]?.includes(k)) r[g][k] = c.valor;
      else if (!k && ["observaciones", "obra_social", "estudios", "materiales", "medicamentos"].includes(g)) r[g] = c.valor;
    }
    r._nota = nota;
    return r;
  }

  // Deja la respuesta con la forma exacta del pedido (lo que falte o venga raro queda como estaba)
  function limpiar(r, antes) {
    const s = (v, def) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : def);
    const lista = (v, claves, def) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object").map((x) => Object.fromEntries(claves.map((k) => [k, s(x[k], "")]))) : def);
    const out = {
      obra_social: s(r.obra_social, antes.obra_social),
      clinica: Object.fromEntries(CAMPOS.clinica.map((k) => [k, s(r.clinica?.[k], antes.clinica[k])])),
      autorizacion: Object.fromEntries(CAMPOS.autorizacion.map((k) => [k, s(r.autorizacion?.[k], antes.autorizacion[k])])),
      estudios: lista(r.estudios, ["codigo", "descripcion"], antes.estudios).filter((x) => x.descripcion),
      materiales: lista(r.materiales, ["cantidad", "descripcion"], antes.materiales).filter((x) => x.descripcion),
      medicamentos: lista(r.medicamentos, ["nombre_generico", "presentacion", "cantidad", "posologia"], antes.medicamentos).filter((x) => x.nombre_generico),
      observaciones: s(r.observaciones, antes.observaciones),
    };
    if (!["", "Derecha", "Izquierda", "Bilateral"].includes(out.clinica.lateralidad)) out.clinica.lateralidad = antes.clinica.lateralidad;
    if (!["", "Programada", "Urgencia"].includes(out.clinica.caracter)) out.clinica.caracter = antes.clinica.caracter;
    out.nota = s(r._nota, "");
    return out;
  }

  // Cambios entre el pedido actual y lo propuesto, uno por campo o por lista
  function cambios(antes, despues) {
    const lista = [];
    const texto = (k, a, b, ruta) => { if ((a || "") !== (b || "")) lista.push({ ruta, titulo: NOMBRES[k], antes: a || "", despues: b || "" }); };
    texto("obra_social", antes.obra_social, despues.obra_social, "obra_social");
    for (const g of ["clinica", "autorizacion"]) for (const k of CAMPOS[g]) texto(k, antes[g][k], despues[g][k], `${g}.${k}`);
    texto("observaciones", antes.observaciones, despues.observaciones, "observaciones");
    const fila = { estudios: (x) => x.descripcion, materiales: (x) => `${x.cantidad ? x.cantidad + " × " : ""}${x.descripcion}`,
      medicamentos: (x) => [x.nombre_generico, x.presentacion, x.cantidad && `x${x.cantidad}`, x.posologia].filter(Boolean).join(" · ") };
    for (const k of ["estudios", "materiales", "medicamentos"]) {
      const a = antes[k].map(fila[k]), b = despues[k].map(fila[k]);
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      lista.push({ ruta: k, titulo: NOMBRES[k], quita: a.filter((x) => !b.includes(x)), agrega: b.filter((x) => !a.includes(x)), igual: a.length === b.length && a.every((x) => b.includes(x)) });
    }
    return lista;
  }

  async function modelos(conf) {
    const p = PROVEEDORES[conf.proveedor];
    const r = await fetch(p.url + "/models", { headers: conf.clave ? { Authorization: "Bearer " + conf.clave } : {} });
    if (r.status === 401 || r.status === 403) throw new Error("La clave no es válida.");
    if (!r.ok) throw new Error(`El servicio respondió con un error (${r.status}).`);
    const ids = ((await r.json()).data || []).filter((m) => m.active !== false).map((m) => m.id);
    return ids.filter((id) => !/whisper|tts|guard|embed|vision|orpheus|playai|distil/i.test(id)).sort();
  }

  return { PROVEEDORES, PREFERIDOS, sinIdentidad, tapar, sinMembrete, armarMensaje, fugas, proponer, limpiar, cambios, modelos, jsonDe };
})();
