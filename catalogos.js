"use strict";
// Catálogos de solo lectura (nomenclador PAMI, módulos quirúrgicos PAMI, CIE-10 de cirugía) y la lectura de documentos:
// el texto sale del lector del celular (Lector.textoDe) y estas reglas arman los datos y la recomendación de qué pedir.
// (Mismas reglas que app/catalogos.py y app/extraccion_pedido.py de la versión PC.)

const Catalogos = (() => {
  let practicas = [], modulos = [], cie10 = [], kitsIniciales = [];
  async function cargar() {
    const bajar = (f) => fetch("datos/" + f).then((r) => r.json());
    const [n, m, c, k] = await Promise.all([bajar("nomenclador_pami.json"), bajar("pami_modulos_cirugia.json"), bajar("cie10_cirugia.json"), bajar("kits_iniciales.json")]);
    practicas = n.practicas; modulos = m; cie10 = c.diagnosticos; kitsIniciales = k;
  }

  const normalizar = (t) => (t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean).join(" ");

  function buscarEn(lista, q, campos, limite) {
    q = normalizar(q);
    if (!q) return [];
    const palabras = q.split(" "), res = [];
    for (const item of lista) {
      if (item.codigo.toLowerCase().replace(/\./g, "").startsWith(q.replace(/ /g, ""))) { res.push([0, item]); continue; }
      const texto = normalizar(campos(item).join(" "));
      if (palabras.every((p) => texto.includes(p))) {
        // Las coincidencias en la descripción principal van primero
        res.push([palabras.every((p) => normalizar(item.descripcion).includes(p)) ? 1 : 2, item]);
      } else if (palabras.every((p) => texto.includes(p.slice(0, 5)))) res.push([3, item]); // «hernia» encuentra «hernioplastia»
    }
    return res.sort((a, b) => a[0] - b[0]).slice(0, limite).map((r) => r[1]);
  }

  // Prácticas del nomenclador PAMI: primero las ambulatorias (sección 1.x), que son las de CUP
  const buscarPracticas = (q, limite = 25) =>
    buscarEn(practicas, q, (p) => [p.descripcion], 200).sort((a, b) => !a.seccion.startsWith("1.") - !b.seccion.startsWith("1.")).slice(0, limite);
  const buscarDiagnosticos = (q, limite = 20) => buscarEn(cie10, q, (d) => [d.descripcion], limite);
  function buscarModulos(q, limite = 15) {
    const palabras = normalizar(q).split(" ");
    return buscarEn(modulos, q, (m) => [m.descripcion, ...m.items], limite).map((m) => ({
      ...m, coincide: m.items.find((i) => palabras.every((p) => normalizar(i).includes(p.slice(0, 5)))) || "" }));
  }

  // Nombres con que figuran las obras sociales (credenciales, informes, lo que se tipea)
  const OBRAS = [[["pami", "inssjp", "jubilados y pensionados", "jubilados"], "PAMI"], [["apross", "administracion provincial del seguro de salud"], "APROSS"]];
  const obraSocialCanonica = (nombre) => {
    const n = normalizar(nombre);
    return OBRAS.find(([claves]) => claves.some((c) => n.includes(c)))?.[1] || (nombre || "").trim();
  };
  // Para el lector: obra social conocida que aparezca en el texto
  const CONOCIDAS = [["PAMI", /\bpami\b|inssjp/], ["APROSS", /\bapross?\b/], ["OSDE", /\bosde\b/], ["Swiss Medical", /swiss\s*medical/], ["Galeno", /\bgaleno\b/],
    ["Sancor Salud", /\bsancor\b/], ["Medifé", /\bmedife\b/], ["Jerárquicos", /jerarquicos/], ["OSECAC", /\bosecac\b/], ["Particular", /\bparticular\b/]];
  const obraSocialEnTexto = (texto) => { const t = normalizar(texto); return CONOCIDAS.find(([, re]) => re.test(t))?.[0] || ""; };

  // Abreviaturas y sinónimos frecuentes en historias clínicas → palabras del nomenclador
  const SINONIMOS = {
    eco: "ecografia", rx: "radiografia", tac: "tomografia", tc: "tomografia", rmn: "resonancia", rm: "resonancia", abdominal: "abdomen",
    ecg: "electrocardiograma", vcc: "videoendoscopia digestiva baja", colonoscopia: "videoendoscopia digestiva baja",
    videocolonoscopia: "videoendoscopia digestiva baja", veda: "videoendoscopia digestiva alta", endoscopia: "videoendoscopia digestiva alta",
    doppler: "ecodoppler", lab: "", laboratorio: "", holter: "holter cardiaco", control: "consulta", valoracion: "consulta", evaluacion: "consulta", interconsulta: "consulta",
  };
  const VACIAS = new Set(["de", "del", "la", "el", "los", "las", "con", "y", "en", "a", "por", "para", "un", "una", "completa", "completo"]);

  // Práctica ambulatoria que mejor coincide con un texto libre de la HC («eco abdominal»)
  function mejorPractica(texto) {
    const palabras = normalizar(texto).split(" ").flatMap((w) => (w in SINONIMOS ? SINONIMOS[w] : w).split(" ")).filter((w) => w && !VACIAS.has(w));
    if (!palabras.length) return null;
    let mejor = null, puntaje = [0, 0];
    for (const p of practicas) {
      if (!p.seccion.startsWith("1.")) continue;
      const desc = normalizar(p.descripcion).split(" ");
      const aciertos = palabras.map((w) => (desc.includes(w) ? 2 : desc.some((d) => d.length >= 4 && (d.startsWith(w.slice(0, 5)) || w.startsWith(d.slice(0, 5)))) ? 1 : 0));
      // La primera palabra (tipo de estudio) tiene que coincidir, y al menos dos en frases largas
      if (!aciertos[0] || aciertos.filter(Boolean).length < Math.min(2, palabras.length)) continue;
      const pt = [aciertos.reduce((s, x) => s + x, 0), -desc.length]; // más coincidencias; desempata la más general
      if (pt[0] > puntaje[0] || (pt[0] === puntaje[0] && pt[1] > puntaje[1])) { mejor = p; puntaje = pt; }
    }
    return mejor;
  }

  const palabrasDe = (t) => new Set(normalizar(t).split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  // Código CIE-10 más parecido a un diagnóstico escrito
  function cie10De(diagnostico) {
    const p = palabrasDe(diagnostico);
    if (!p.size) return null;
    let mejor = null, n = 0;
    for (const d of cie10) {
      const c = [...palabrasDe(d.descripcion)].filter((w) => p.has(w)).length;
      if (c > n) { mejor = d; n = c; }
    }
    return n >= 1 ? mejor : null; // el médico lo ve resaltado y lo corrige
  }
  const descripcionCie10 = (codigo) => cie10.find((d) => d.codigo === codigo)?.descripcion || "";

  // Kit que corresponde a un procedimiento («colecistectomía laparoscópica» → kit de vesícula)
  function kitDe(procedimiento, kits) {
    const p = palabrasDe(procedimiento);
    if (!p.size) return null;
    let mejor = null, n = 0;
    for (const k of kits) {
      const c = [...palabrasDe(k.nombre)].filter((w) => [...p].some((x) => x.slice(0, 6) === w.slice(0, 6))).length;
      if (c > n) { mejor = k; n = c; }
    }
    return n >= 1 ? mejor : null;
  }

  // ---------- Lectura de documentos: texto → datos del paciente y qué pedir ----------
  const PREQUIRURGICO = ["820161", "570129", "340301", "660475", "660746", "660171", "660546", "660192", "660902"];

  function leer(texto, { kits = [], medico = {} } = {}) {
    const dudas = [];
    const p = Lector.parte(texto, obraSocialEnTexto);
    const renglones = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const plano = normalizar(texto);
    // «GOMEZ, ANA MARIA» → apellido y nombre
    let [apellido, ...resto] = (p.paciente || "").split(",");
    let nombre = resto.join(",").trim();
    apellido = (apellido || "").trim();
    if (apellido && !nombre && apellido.includes(" ")) { const w = apellido.split(" "); apellido = w[0]; nombre = w.slice(1).join(" "); }
    // El médico usuario no es el paciente (membrete, firma, sello)
    const ap = palabrasDe(medico.apellido || "");
    if (ap.size && [...palabrasDe(apellido + " " + nombre)].some((w) => ap.has(w))) {
      dudas.push("El nombre leído como paciente es el del médico: se descartó; completá el nombre del paciente.");
      apellido = nombre = "";
    }
    const nac = (texto.match(/(?:nac(?:imiento)?|f\.?\s*nac\.?)[^\d\n]{0,15}(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i) || [])[1] || "";
    const tel = (texto.match(/(?:tel(?:[eé]fono)?|cel(?:ular)?|whatsapp)\.?\s*:?\s*(\+?[\d \t()-]{8,18}\d)/i) || [])[1] || "";
    // Diagnóstico: el del documento (corto) y su código CIE-10
    let diagnostico = (p.diagnostico || "").replace(/\s{2,}.*$/, "").trim();
    let cie = (texto.match(/\b([A-TV-Z]\d{2}(?:\.\d{1,2})?)\b/) || [])[1] || "";
    if (cie && !descripcionCie10(cie)) cie = "";
    if (!cie && diagnostico) cie = cie10De(diagnostico)?.codigo || "";
    if (diagnostico.length > 100) { dudas.push("El diagnóstico leído era muy largo; se resumió: revisalo."); diagnostico = descripcionCie10(cie) || diagnostico.slice(0, 100); }
    // Procedimiento propuesto: «Plan: …», «Cirugía propuesta: …», «Se indica …»
    let procedimiento = "";
    const QUIRURGICO = /ectom|plast|rrafia|cirug|laparosc|videolap|hernio|colecist|apendic|ex[eé]resis|resecci|funduplic|bypass|manga|gastrect|tiroid|mastect|cuadrantect|biopsia|drenaje|ostom|otom|sutura|amputa|hemorroid|fistul|fisur|quiste|lipoma|eventr|colect|anastom|nissen|toracosc|endosc|vcc|veda/i;
    const prop = renglones.map((l) => l.match(/(?:cirug[ií]a (?:propuesta|indicada|programada)|operaci[oó]n propuesta|\bplan(?: quir[uú]rgico)?\s*:|\bse (?:indica|propone|programa)\b|indicaci[oó]n quir[uú]rgica)\s*:?\s*(.{4,90})/i))
      .find((m) => m && (!/^se /i.test(m[0].trim()) && !/^plan/i.test(m[0].trim()) || QUIRURGICO.test(m[1])));
    if (prop) procedimiento = prop[1].replace(/^(?:una|la|el)\s+/i, "").replace(/[.;]\s*$/, "").trim();
    else if (p.procedimientos?.[0]) procedimiento = p.procedimientos[0];
    const cirugia = !!procedimiento || /prequir|cirug[ií]a (?:propuesta|programada|indicada)|se programa|riesgo quir/i.test(texto);
    // Estudios a pedir: renglones después de «Solicito», «Se solicita», «Pido», «Estudios:»
    const estudiosTexto = [];
    renglones.forEach((l, i) => {
      const m = l.match(/^(?:solicito|se solicita[n]?|pido|pedir|estudios(?: a solicitar)?|solicitar)\s*:?\s*(.*)$/i);
      if (!m) return;
      const lista = [m[1], ...renglones.slice(i + 1, i + 8).filter((x) => /^(?:[-•*·]|\d{1,2}[.)])\s*[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(x)).map((x) => x.replace(/^(?:[-•*·]|\d{1,2}[.)])\s*/, ""))];
      for (const x of lista.join(",").split(/[,;+]|\s+y\s+/)) if (x.trim().length > 2) estudiosTexto.push(x.trim());
    });
    const estudios = [], sinCodigo = [];
    let conPrequirurgico = cirugia;
    for (const t of estudiosTexto) {
      if (/prequir/i.test(t)) { conPrequirurgico = true; continue; }
      const pr = mejorPractica(t);
      if (pr && PREQUIRURGICO.includes(pr.codigo)) { conPrequirurgico = true; continue; }
      if (pr) estudios.push({ codigo: pr.codigo, descripcion: capitalizar(pr.descripcion) });
      else { estudios.push({ codigo: "", descripcion: t }); sinCodigo.push(t); }
    }
    if (sinCodigo.length) dudas.push("Sin código en el nomenclador (completar): " + sinCodigo.join(", "));
    const kit = cirugia ? kitDe(procedimiento, kits) : null;
    const documentos = [];
    if (conPrequirurgico || estudios.length) documentos.push("estudios");
    if (cirugia) documentos.push("materiales", "autorizacion");
    if (p.dni && !/^\d{7,8}$/.test(p.dni)) dudas.push(`DNI con formato raro (${p.dni}): verificalo.`);
    const sec = secciones(renglones);
    const sx = (texto.match(/\bsexo\s*:?\s*(femenino|masculino|f|m)\b/i) || [])[1] || "";
    const sexo = /^f/i.test(sx) ? "femenino" : /^m/i.test(sx) ? "masculino" : "";
    const leido = { apellido, nombre, dni: p.dni, nac, tel, os: p.obra_social_texto, afiliado: p.afiliado || p.afiliadoPorForma, diagnostico, cie, procedimiento };
    return {
      paciente: { apellido: mayus(apellido), nombre: titulo(nombre), dni: p.dni || "", fecha_nacimiento: nac.replace(/[.-]/g, "/"), telefono: tel.replace(/\s+/g, " ").trim() },
      cobertura: { obra_social: obraSocialCanonica(p.obra_social_texto || ""), nro_afiliado: (p.afiliado || p.afiliadoPorForma || "").trim() },
      clinica: { diagnostico, cie10: cie, procedimiento },
      kit_sugerido: kit?.id || "",
      recomendacion: { combo: conPrequirurgico ? "prequirurgico-pami" : "", estudios, documentos },
      vacio: !Object.values(leido).some(Boolean) && !estudios.length,
      dudas,
      secciones: sec,
      resumen: redactarResumen(sec, { fecha_nacimiento: nac.replace(/[.-]/g, "/"), sexo, diagnostico, procedimiento }),
      texto,
    };
  }

  // ---------- Resumen de HC sin IA: secciones de la HC + plantilla de redacción ----------
  // Secciones que se reconocen al principio de un renglón (la etiqueta) y siguen en los renglones de abajo hasta la etiqueta siguiente
  const SECCIONES = [
    ["motivo", /^(?:motivo de (?:la )?consulta|m\.?\s?c\.?(?=\s*:)|consulta por)\s*[:.-]?\s*/i],
    ["actual", /^(?:enfermedad actual|cuadro actual|e\.?\s?a\.?(?=\s*:))\s*[:.-]?\s*/i],
    ["antecedentes", /^(?:antecedentes(?: personales| patol[oó]gicos| quir[uú]rgicos| de relevancia)?|a\.?\s?p\.?\s?p\.?(?=\s*:)|antec\.)\s*[:.-]?\s*/i],
    ["examen", /^(?:examen f[ií]sico|ex\.? f[ií]sico|e\.?\s?f\.?(?=\s*:)|al examen(?: f[ií]sico)?)\s*[:.-]?\s*/i],
  ];
  const ESTUDIO = /^(?:ecograf[ií]a|eco\b|ecodoppler|tac\b|tc\b|tomograf[ií]a|rmn\b|rm\b|resonancia|colangiorresonancia|laboratorio|lab\b|rx\b|radiograf[ií]a|vcc\b|veda\b|colonoscop[ií]a|videocolonoscop[ií]a|endoscop[ií]a|videoendoscop[ií]a|ecg\b|electrocardiograma|anatom[ií]a patol[oó]gica|biopsia|estudios(?: complementarios)?\b)/i;
  const ETIQUETA = /^[A-Za-zÁÉÍÓÚÑáéíóúñ°.\/ ]{2,35}:/;
  const otraEtiqueta = (v) => v.split(/\s{3,}(?=[A-Za-zÁÉÍÓÚÑáéíóúñ°. ]{2,30}:)/)[0].trim();

  function secciones(renglones) {
    const out = { estudios: [] };
    renglones.forEach((l, i) => {
      for (const [campo, re] of SECCIONES) {
        const m = l.match(re);
        if (!m || out[campo]) continue;
        let v = otraEtiqueta(l.slice(m[0].length));
        for (const sig of renglones.slice(i + 1, i + 4)) {
          if (ETIQUETA.test(sig) || ESTUDIO.test(sig) || SECCIONES.some(([, r]) => r.test(sig))) break;
          v += " " + otraEtiqueta(sig);
        }
        if (v.trim().length > 2) out[campo] = v.trim();
        return;
      }
      // Resultados de estudios ya hechos (no lo que se pide: «Solicito: ecografía»)
      if (ESTUDIO.test(l) && /[:.-]\s*\S/.test(l) && l.length > 18 && !/^solicit|^pedir|^se solicit/i.test(l)) out.estudios.push(otraEtiqueta(l));
    });
    return out;
  }

  const sinPunto = (t) => (t || "").trim().replace(/[\s.;,]+$/, "");
  // Dentro de una oración: «Dolor abdominal» → «dolor abdominal» (las siglas quedan: «HTA», «DBT»)
  const enOracion = (t) => { t = sinPunto(t); return /^[A-ZÁÉÍÓÚÑ]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1); };
  const oracion = (t) => { t = sinPunto(t); return t ? t.charAt(0).toUpperCase() + t.slice(1) + "." : ""; };
  function edadDe(fnac) {
    const m = (fnac || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const h = new Date(), mes = h.getMonth() + 1;
    return h.getFullYear() - +m[3] - (mes < +m[2] || (mes === +m[2] && h.getDate() < +m[1]) ? 1 : 0);
  }

  // Redacción tipo autorización con lo que se sabe (secciones leídas de la HC + datos del formulario). El médico la revisa.
  function redactarResumen(sec = {}, d = {}) {
    const edad = edadDe(d.fecha_nacimiento), sexo = d.sexo;
    let primera = "Paciente" + (sexo ? ` de sexo ${sexo}` : "") + (edad !== null && edad >= 0 && edad < 120 ? `${sexo ? "," : ""} de ${edad} años` : "");
    if (sec.antecedentes) primera += /^(niega|sin |no refiere|no presenta|ninguno|nada)/i.test(sec.antecedentes) ? ", sin antecedentes de relevancia"
      : ", con antecedentes de " + enOracion(sec.antecedentes).replace(/^de\s+/i, "");
    if (sec.motivo) primera += ", que consulta por " + enOracion(sec.motivo).replace(/^por\s+/i, "");
    const partes = [];
    if (primera !== "Paciente") partes.push(oracion(primera));
    if (sec.actual) partes.push(oracion(sec.actual));
    if (sec.examen) partes.push(oracion("Al examen físico: " + enOracion(sec.examen)));
    const diag = sinPunto(d.diagnostico), proc = sinPunto(d.procedimiento);
    if (diag && proc) partes.push(oracion(`Con diagnóstico de ${enOracion(diag)}, se indica ${enOracion(proc)}`));
    else if (diag) partes.push(oracion("Diagnóstico: " + enOracion(diag)));
    else if (proc) partes.push(oracion("Se indica " + enOracion(proc)));
    return { clinico: partes.join(" "), estudios: (sec.estudios || []).map(oracion).join(" ") };
  }

  const capitalizar = (s) => { s = (s || "").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
  const mayus = (s) => (s || "").toUpperCase();
  const titulo = (s) => (s || "").toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());

  return {
    cargar, normalizar, buscarPracticas, buscarDiagnosticos, buscarModulos, obraSocialCanonica, mejorPractica, cie10De, redactarResumen, descripcionCie10, kitDe, leer, capitalizar,
    get kitsIniciales() { return kitsIniciales; },
    PREQUIRURGICO: {
      id: "prequirurgico-pami", nombre: "Prequirúrgico PAMI",
      items: [
        { codigo: "820161", descripcion: "Consulta con especialista en tratamiento del dolor (evaluación anestésica)" },
        { codigo: "570129", descripcion: "Consulta con especialista en cardiología con electrocardiograma (riesgo quirúrgico)" },
        { codigo: "340301", descripcion: "Radiografía de tórax frente" },
        { codigo: "660475", descripcion: "Hemograma" },
        { codigo: "660746", descripcion: "Recuento de plaquetas" },
        { codigo: "660171", descripcion: "Coagulograma" },
        { codigo: "660546", descripcion: "Ionograma plasmático" },
        { codigo: "660192", descripcion: "Creatinina" },
        { codigo: "660902", descripcion: "Uremia" },
      ],
    },
  };
})();
