const URL_JORNADAS = "https://certificaciones.csl.uy/Jornadas/Disponibles";
const CURSO = "tc - tarjeta verde transportistas";

function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fechaOrden(texto) {
  const match = String(texto).match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/
  );

  if (!match) return Number.MAX_SAFE_INTEGER;

  return Date.UTC(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4]),
    Number(match[5])
  );
}

function respuestaJson(datos, estado = 200, cache = "no-store") {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff"
    }
  });
}

export async function onRequestGet() {
  try {
    const origen = await fetch(URL_JORNADAS, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; FAS-Jornadas/1.0)",
        "accept": "text/html,application/xhtml+xml"
      },
      cf: {
        cacheTtl: 300,
        cacheEverything: true
      }
    });

    if (!origen.ok) {
      return respuestaJson(
        { error: `CSL respondió con estado ${origen.status}.` },
        502
      );
    }

    const filas = [];
    let filaActual = null;
    let celdaActual = null;

    const html = new HTMLRewriter()
      .on("tr", {
        element() {
          filaActual = [];
          filas.push(filaActual);
        },
        end() {
          filaActual = null;
          celdaActual = null;
        }
      })
      .on("th, td", {
        element(element) {
          if (!filaActual) return;

          celdaActual = {
            tipo: element.tagName.toLowerCase(),
            texto: ""
          };

          filaActual.push(celdaActual);
        },
        text(texto) {
          if (celdaActual) {
            celdaActual.texto += texto.text;
          }
        },
        end() {
          celdaActual = null;
        }
      })
      .transform(origen);

    // Leer el contenido ejecuta los manejadores de HTMLRewriter.
    await html.text();

    const encabezado = filas.find((fila) =>
      fila.some((celda) => celda.tipo === "th")
    );

    if (!encabezado) {
      return respuestaJson(
        { error: "No se encontró la tabla de jornadas de CSL." },
        502
      );
    }

    const nombres = encabezado.map((celda) => normalizar(celda.texto));

    const indices = {
      fecha: nombres.indexOf("fecha"),
      hora: nombres.indexOf("hora"),
      curso: nombres.indexOf("curso"),
      lugar: nombres.indexOf("lugar"),
      direccion: nombres.indexOf("direccion"),
      caracteristicas: nombres.indexOf("caracteristicas")
    };

    if (
      [indices.fecha, indices.hora, indices.curso, indices.lugar]
        .some((indice) => indice < 0)
    ) {
      return respuestaJson(
        {
          error:
            "La tabla de CSL cambió de formato y no pude identificar sus columnas."
        },
        502
      );
    }

    const jornadas = [];

    for (const fila of filas) {
      if (!fila.some((celda) => celda.tipo === "td")) continue;

      const celdas = fila.map((celda) => celda.texto.trim());

      const indiceMaximo = Math.max(
        indices.fecha,
        indices.hora,
        indices.curso,
        indices.lugar
      );

      if (celdas.length <= indiceMaximo) continue;

      const curso = normalizar(celdas[indices.curso]);

      if (!curso.includes(CURSO)) continue;

      const contenidoFila = normalizar(celdas.join(" "));

      // Excluye las jornadas que CSL muestra como cerradas.
      if (contenidoFila.includes("cerradas")) continue;

      const fecha = celdas[indices.fecha];
      const hora = celdas[indices.hora];
      const lugar = celdas[indices.lugar];
      const dia = `${fecha} ${hora} hs`;

      const cuposTexto =
        celdas.find((valor) => /cupos disponibles/i.test(valor)) || "";

      const cuposMatch = cuposTexto.match(/(\d+)/);
      const cupos = cuposMatch ? Number(cuposMatch[1]) : null;

      // Excluye jornadas que no tengan cupos.
      if (cupos === 0) continue;

      const caracteristicas =
        indices.caracteristicas >= 0
          ? celdas[indices.caracteristicas]
          : "";

      jornadas.push({
        dia,
        ubicacion: lugar,
        direccion:
          indices.direccion >= 0
            ? celdas[indices.direccion]
            : "",
        cupos,
        cierre: caracteristicas,
        etiqueta:
          `${dia} | ${lugar}` +
          (cupos === null ? "" : ` — ${cupos} cupos`)
      });
    }

    jornadas.sort((a, b) => fechaOrden(a.dia) - fechaOrden(b.dia));

    return respuestaJson(
      {
        actualizado: new Date().toISOString(),
        jornadas
      },
      200,
      "public, max-age=60, s-maxage=300"
    );
  } catch (error) {
    console.error("Error consultando las jornadas de CSL:", error);

    return respuestaJson(
      {
        error: "No se pudo consultar CSL. Intenta nuevamente más tarde."
      },
      502
    );
  }
}
