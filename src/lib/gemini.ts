import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Identifica a la materia y sirve como anclaje en la UI
 * (panel de Configuración muestra este string).
 */
export const ASSISTANT_LABEL =
  "Asistente 577 — Ética, Deontología y Derechos Humanos (Cód. 577, Cátedra Ormart I — UBA Psicología)";

/**
 * Base de conocimiento de la materia: PDFs servidos como archivos
 * estáticos en `public/` y subidos a Gemini File API en runtime.
 *
 * El modelo NO debe responder con nada que no esté en estos dos PDFs.
 * Se suben a Gemini File API una sola vez por sesión y se referencian
 * por fileUri (cache 24 h en localStorage).
 */
const VITE_BASE_URL: string =
  ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.BASE_URL ?? "/");

const PDF_SOURCES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "01.Etica_U1_U4OK.pdf", path: `${VITE_BASE_URL}01.Etica_U1_U4OK.pdf` },
  { name: "02.Etica_U5_U7OK.pdf", path: `${VITE_BASE_URL}02.Etica_U5_U7OK.pdf` },
] as const;

/**
 * Cache en localStorage: para cada PDF guardamos { uri, expiry }.
 * TTL: 24h (la File API de Gemini expira a las 48h, dejamos margen).
 */
const KB_CACHE_PREFIX = "gem-pdf-uri:";
const KB_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedUri {
  uri: string;
  expiry: number;
}

function readCachedUri(name: string): string | null {
  try {
    const raw = localStorage.getItem(KB_CACHE_PREFIX + name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUri;
    if (!parsed?.uri || !parsed?.expiry) return null;
    if (parsed.expiry < Date.now()) return null;
    return parsed.uri;
  } catch {
    return null;
  }
}

function writeCachedUri(name: string, uri: string): void {
  try {
    const payload: CachedUri = { uri, expiry: Date.now() + KB_TTL_MS };
    localStorage.setItem(KB_CACHE_PREFIX + name, JSON.stringify(payload));
  } catch {
    /* sin persistencia: se re-subirá cada vez */
  }
}

/**
 * Sube un PDF a Gemini File API y devuelve el fileUri.
 * Si ya hay uno cacheado en localStorage (no expirado), lo reusa.
 */
async function ensurePdfUploaded(
  ai: GoogleGenAI,
  name: string,
  path: string
): Promise<string> {
  const cached = readCachedUri(name);
  if (cached) return cached;

  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`No se pudo cargar ${name} desde el sitio (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`El archivo ${name} está vacío.`);
  }

  const uploaded = await ai.files.upload({
    file: new File([blob], name, { type: "application/pdf" }),
    config: { displayName: name },
  });
  const uri = uploaded?.uri;
  if (!uri) {
    throw new Error(`No se pudo subir ${name} a Gemini File API.`);
  }
  writeCachedUri(name, uri);
  return uri;
}

/**
 * Prepara la base de conocimiento: sube los PDFs declarados en
 * `PDF_SOURCES` a Gemini File API (o reutiliza los URIs cacheados)
 * y devuelve un array de `fileData` listo para meter en `parts[]`.
 *
 * Si `PDF_SOURCES` está vacío, lanza un error claro para que el
 * usuario sepa que falta cargar el material antes de usar la app.
 */
async function buildKnowledgeBaseParts(
  ai: GoogleGenAI,
  onProgress?: (msg: string) => void
): Promise<{ fileData: { fileUri: string; mimeType: string } }[]> {
  if (PDF_SOURCES.length === 0) {
    throw new Error(
      "La base de conocimiento está vacía. Copiá los PDFs a public/ y " +
        "registralos en PDF_SOURCES dentro de src/lib/gemini.ts."
    );
  }
  const parts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  for (const src of PDF_SOURCES) {
    onProgress?.(`Subiendo ${src.name} a Gemini…`);
    const uri = await ensurePdfUploaded(ai, src.name, src.path);
    parts.push({ fileData: { fileUri: uri, mimeType: "application/pdf" } });
  }
  return parts;
}

/**
 * Prompt del sistema — Tutor 577, materia "Ética, Deontología y
 * Derechos Humanos" (Código 577, Cátedra I — Dra. Elizabeth Beatriz
 * Ormart, Facultad de Psicología, UBA).
 */
export const SYSTEM_PROMPT = `# SYSTEM PROMPT: EXPERTO TUTOR ACADÉMICO
## Ética, Deontología y Derechos Humanos (Cátedra Ormart - Código 577 - UBA)

### 1. IDENTIDAD Y PROPÓSITO
Eres un Tutor de Inteligencia Artificial especializado de forma exclusiva en la materia "Ética, Deontología y Derechos Humanos" (Cátedra I - Dra. Elizabeth Beatriz Ormart) de la Facultad de Psicología de la Universidad de Buenos Aires (UBA). Tu misión es asistir a los estudiantes en la comprensión conceptual profunda, la resolución de viñetas clínicas y la preparación de exámenes parciales y finales, reproduciendo con exactitud el rigor conceptual, metodológico y psicoanalítico de la cátedra.

### 2. FUENTES DE INFORMACIÓN: GUÍA VS. BASE DE CONOCIMIENTOS
Debes diferenciar de forma taxativa la función de los documentos de trabajo:
- Guía Metodológica y Pedagógica (Programa Oficial 2026): Funciona como brújula de evaluación. Define los nudos problemáticos, los objetivos de aprendizaje y el modo en que la cátedra exige articular las situaciones dilemáticas.
- Base de Conocimientos Exclusiva (Los 2 Archivos PDF): La totalidad de las citas, desarrollos teóricos, artículos normativos y viñetas clínicas deben ser extraídos ÚNICA Y EXCLUSIVAMENTE de los dos archivos PDF de la cátedra:
  * 01.Etica_U1_U4OK.pdf: Desarrollos teóricos de Módulos 1 a 4, clases prácticas, códigos deontológicos (APA 2010, FePRA 1999/2013, APBA), Ley de Salud Mental 26.657, Ley de Violencia Familiar 24.417 (Gutiérrez y Salomone), los cuatro casos de la Serie PSI (Renato, Laura, Paula y Alberto) y el Mapa IBIS de Cuestiones Éticas en la Práctica Clínica.
  * 02.Etica_U5_U7OK.pdf: Desarrollos teóricos de Módulos 5 a 7 sobre circuito de la responsabilidad y culpa (Freud, Mosca, D'Amore, Salomone, Jinkis, Sartre), apropiación y restitución de menores (Domínguez, Gutiérrez, Montesano, Kletnicki, Pavlovsky) y reproducción asistida / bioética (Ansermet, Baudrillard, Gutiérrez, Kletnicki, Ormart).
- Regla de búsqueda: Localiza automáticamente el contenido en estos archivos sin solicitar al usuario especificaciones de módulo. Queda prohibido inventar conceptos o recurrir a marcos éticos ajenos a la cátedra.

### 3. REGLAS DE SALIDA Y RESTRICCIONES FORMALES INQUEBRANTABLES
Cada respuesta que emitas debe cumplir obligatoriamente y sin excepciones con los siguientes cinco criterios:
1. Extensión exacta: Obligatoriamente entre 250 y 300 palabras. Si la respuesta no alcanza las 250 palabras o excede las 300, reescribe internamente antes de emitir la salida ajustando la densidad conceptual.
2. Formato: Prosa continua y corrida en uno o dos párrafos fluidos. Terminantemente prohibido el uso de viñetas, listas numeradas, subtítulos o negritas de encabezado y cuadros sinópticos.
3. Inicio directo: Comienza directamente con la argumentación teórica. Prohibido saludar, usar fórmulas de cortesía, repetir la consigna o incluir cierres de despedida.
4. Puntuación vedada: Prohibido de forma absoluta el uso de guiones largos (—), rayas (–), guiones cortos (-) o barras para crear pausas, incisos o énfasis. Los incisos se resuelven únicamente mediante comas, puntos y comas o paréntesis.
5. Registro: Formal universitario, a la vez cercano, ameno y fluido, simulando una clase magistral dictada con soltura de pie frente al aula.

### 4. NÚCLEO TEÓRICO Y DIRECTIVAS DE EXAMEN
Toda intervención debe fundamentarse en los ejes teóricos centrales de la materia:
- El Doble Movimiento de la Ética: Primer movimiento del juicio moral al estado del arte particular (códigos, leyes, normas); segundo movimiento ante la emergencia de una singularidad en situación que suplementa el universo previo.
- Categorías Lógicas (U-P-S): Universal (lo propio de la especie hablante y la ley de interdicción), Particular (el sistema normativo y moral epocal) y Singular (el acto que quiebra la totalidad particular).
- Responsabilidad Subjetiva: El sujeto del inconsciente como dividido y no autónomo, confrontado al circuito de tres tiempos (Tiempo 1: acto/síntoma; Tiempo 2: interpelación y culpa; Tiempo 3: efecto-sujeto o acto ético).
- Resolución de Casos y Mapa IBIS: Ante viñetas clínicas o situaciones profesionales, es obligatorio clasificar la problemática empleando la taxonomía del Mapa IBIS de Cuestiones Éticas en la Práctica Clínica (identificando Área, Capítulo y Cuestión en juego según el archivo 01.Etica_U1_U4OK.pdf).
- Respuestas Modelo: Cuando se te solicite resolver una pregunta ("qué respondo", "dame una respuesta para...", "cómo le contesto"), entrega la respuesta definitiva redactada en prosa lista para usar. Queda prohibido cerrar con preguntas retóricas (como "¿Cómo lo pensarías?") o dar instrucciones indirectas sobre cómo responder.

### 5. MAPA DE CONTENIDOS Y AUTORES CLAVE POR UNIDAD
- UNIDAD 1 (Dialéctica Particular y Universal-Singular): Michel Fariña (Doble movimiento, Tatuajes en la escuela primaria, Tragedia Cap. V y VI); Ariel (Moral y Ética. Una poética del estilo); Lewkowicz (Particular, Universal, Singular); Sófocles (Antígona); Gutiérrez (Antígona y el rito funerario).
- UNIDAD 2 (DDHH y Ética Profesional): Calo (Interacción con los códigos); Domínguez (Singularidad en los códigos); Laso et al. (Un método peligroso); Lewkowicz (Singularidades codificadas); Freud (Amor de transferencia); Gutiérrez y Salomone (El abuso contra los niños, Ley 24.417); Salomone (Consideraciones sobre la ética profesional, Responsabilidad profesional, Neutralidad y abstinencia); Ley 26.657; Ormart (Relaciones amorosas con ex pacientes; Caso Renato / Teoría queer); Salomone (Caso Alberto / Pornografía infantil); González Pla (Caso Paula / Muerte digna).
- UNIDAD 3 (Principios Deontológicos): Michel Fariña (De la eugenesia a los crímenes nazis); Ormart et al. (Problemas éticos: Asch, Milgram, Zimbardo); Salomone y Michel Fariña (Experimento de Stanley Milgram); Laso (Coordenadas de la obediencia / Bauman); Códigos APA (2010), FePRA (1999/2013), APBA; UNESCO (Declaración Bioética y DDHH).
- UNIDAD 4 (Ética ante Situaciones Extremas): Arendt (Responsabilidad personal bajo una dictadura); Calligaris (La seducción totalitaria); Gutiérrez (Eichmann y la responsabilidad); Lewkowicz y Gutiérrez (Catástrofe; Memoria, víctima y sujeto); Michel Fariña y Gutiérrez (Veinte años son nada); Ulloa (Ética del analista ante lo siniestro); Viñar (Transmisión del patrimonio mortífero).
- UNIDAD 5 (Ética y Responsabilidad): Freud (Responsabilidad moral por los sueños); Mosca (Responsabilidad, otro nombre del sujeto); Salomone (Sujeto dividido; Sujeto autónomo); Ariel (Responsabilidad ante el aborto); D'Amore (Responsabilidad y culpa); Jinkis (Vergüenza y responsabilidad); Michel Fariña (The Truman Show); Ormart (La culpa y el superyó); Sartre (El muro).
- UNIDAD 6 (Identidad y Filiación): Domínguez (La apropiación. El extravío de los límites); Gutiérrez (Restitución del padre); Gutiérrez y Montesano (Farsa y ficción); Kletnicki (Construcción de una memoria; Lógica genocida); Michel Fariña (Lecciones de Potestad); Pavlovsky (Potestad).
- UNIDAD 7 (Perspectiva Tecnocientífica y Bioética): Ansermet (La muerte antes del nacimiento); Baudrillard (La solución final: clonación); Gutiérrez (Saber creacionista y ficción fundadora); Kletnicki (Un deseo que no sea anónimo; El embrión como objeto extracorpóreo); Ormart (Tensiones entre lo femenino y la maternidad).`;

/**
 * Nota legible sobre qué hay cargado como base de conocimiento.
 * Sólo se usa en logs / debug; el modelo la ignora.
 */
export const KNOWLEDGE_BASE_NOTE =
  "Base de conocimiento: 01.Etica_U1_U4OK.pdf (U1-U4, primer parcial) + 02.Etica_U5_U7OK.pdf (U5-U7, segundo parcial) — subidos a Gemini File API.";

/**
 * Esta constante quedó vacía por seguridad: la API key SOLO vive en el
 * navegador del usuario (campo "API Key de Gemini" en el panel de
 * Configuración, persistida en localStorage). NO la leemos de variables
 * de entorno porque las `VITE_*` se compilan dentro del bundle JS público
 * y quedan expuestas en GitHub Pages.
 *
 * El nombre del export se mantiene para no romper App.tsx ni a ningún
 * importador externo; su valor siempre es "" en build, y la app usa la
 * key que venga como argumento (`apiKey` en cada llamada).
 */
export const GEMINI_API_KEY: string = "";


export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
}

/**
 * Convierte un Blob (audio grabado) a una cadena Base64 *sin* el prefijo
 * `data:<mime>;base64,` que agrega FileReader — es lo que espera Gemini
 * en `inlineData.data`.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("No se pudo codificar el audio a Base64."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Limpia el texto que devuelve Gemini antes de mostrarlo o leerlo en voz
 * alta. Caza los artefactos típicos de cuando el modelo se "contagia" del
 * formato de transcripción de audio (timecodes SRT/VTT, etiquetas de
 * hablante, etc.) y de cualquier residuo de markdown que el TTS leería
 * literal (asteriscos, guiones bajos, etc.). Pensada como red de seguridad:
 * aunque el system prompt lo prohíba, el modelo a veces los emite igual.
 *
 * Patrones que elimina:
 *  - Sello MM:SS o HH:MM:SS pegado o suelto:           00:05 · 1:23 · 00:05.123
 *  - Pegado a una palabra (sin espacio):                "socio01:03estructural" → "socioestructural"
 *  - Con corchetes / ángulos / paréntesis:              [00:05] · <00:05> · (00:05)
 *  - Rangos SRT/VTT:                                    00:05 --> 00:08 · 00:05,000 --> 00:08,000
 *  - Etiquetas de hablante:                             Speaker 1: · Hablante 2:
 *  - Líneas que son solo un número (índices SRT)
 *  - Marcado Markdown simple: **negrita**, *itálica*, _itálica_, `código`
 */
export function sanitizeResponseText(text: string): string {
  if (!text) return text;
  let t = text;
  // 1) Índices de bloque SRT: una línea entera que es solo 1-4 dígitos
  t = t.replace(/^\s*\d{1,4}\s*$/gm, "");
  // 2) Rangos SRT/VTT: "00:05 --> 00:08" / "00:05,000 --> 00:08,000"
  t = t.replace(
    /\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g,
    " "
  );
  // 3) Sellos de tiempo con corchetes/ángulos/paréntesis: [00:05], <1:23>
  t = t.replace(
    /[\[\<\(]\s*\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b\s*[\]\>\)]/g,
    " "
  );
  // 4) Sellos sueltos: 00:05, 1:23, 00:05.123 (incluye HH:MM:SS).
  //    Importante: NO usar \b al final, porque un sello pegado a una
  //    palabra ("socio01:03estructural") no tiene word boundary y el
  //    \b lo dejaría pasar. Usamos (?<!\d) al inicio (para no
  //    comernos el "12" de "12:00:30") y (?!\d) al final (para no
  //    comernos el "00" de "12:00:30.5"). El reemplazo es "" (sin
  //    espacio) para que el texto fluya al pegarse a la palabra.
  t = t.replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?!\d)/g, "");
  // 5) Etiquetas de hablante: "Speaker 1:", "Hablante 2]", "Speaker1 -"
  t = t.replace(/\b(?:Speaker|Hablante|Unknown)\s*\d+\s*[:\-\]]\s*/gi, " ");
  // 6) Markdown residual: negrita (**), itálica (*) y código (`).
  //    El system prompt prohíbe markdown, pero a veces el modelo se
  //    "contagia" y lo emite igual — y speechSynthesis lo lee literal
  //    ("asterisco asterisco negrita asterisco asterisco").
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  t = t.replace(/`([^`]+)`/g, "$1");
  // 6.5) Guiones largos / rayas (—, –) y secuencias de guiones
  //      enfáticos. El system prompt los prohíbe, pero el modelo
  //      a veces los emite como pausas dramáticas. speechSynthesis
  //      los lee literal ("guión guión guión..."). Los borramos como
  //      red de seguridad antes de la limpieza final.
  t = t.replace(/[—–]+/g, " ");
  // 7) Limpieza: colapsa espacios y saltos de línea sobrantes
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Extrae un mensaje legible de un error arbitrario (incluido el del SDK). */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      status?: number | string;
      code?: number | string;
      error?: { message?: string; code?: number | string; status?: string };
    };
    if (e.error?.message) {
      const code = e.error.code ?? e.error.status ?? e.status ?? e.code;
      return code ? `[${code}] ${e.error.message}` : e.error.message;
    }
    if (e.message) return e.message;
  }
  return "Error desconocido al hablar con Gemini.";
}

/**
 * Detecta errores transitorios del servicio (503 UNAVAILABLE,
 * "high demand", "overloaded", etc.). En esos casos, reintentamos
 * una vez antes de mostrar el error al usuario.
 */
function isTransientError(err: unknown): boolean {
  const detail = describeError(err).toLowerCase();
  return (
    detail.includes("503") ||
    detail.includes("unavailable") ||
    detail.includes("high demand") ||
    detail.includes("overloaded") ||
    detail.includes("try again later")
  );
}

/**
 * Sube los PDFs de la bibliografía a Gemini File API (o reutiliza
 * los URIs cacheados en localStorage). Es idempotente: si el cache
 * expiró o nunca existió, sube; si todavía es válido, no hace nada.
 *
 * Útil para "calentar" la base de conocimiento al inicio de la sesión
 * y para que la UI pueda mostrar el estado ("Subiendo PDFs a Gemini…").
 */
export async function warmupKnowledgeBase(
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  await buildKnowledgeBaseParts(ai, onProgress);
}

/**
 * Indica si la base de conocimiento ya está cacheada y vigente.
 * Devuelve true si AMBOS PDFs tienen un fileUri no expirado.
 */
export function isKnowledgeBaseReady(): boolean {
  return PDF_SOURCES.every((s) => readCachedUri(s.name) !== null);
}

/**
 * Envía el audio + la base de conocimiento (PDFs vía File API) a Gemini
 * usando el SDK oficial `@google/genai`.
 *
 * Estructura del request:
 *   parts: [
 *     ...pdfFileData[],              // todos los PDFs en PDF_SOURCES
 *     { inlineData: <audio> },       // clip grabado
 *     { text: <instrucción> }        // "Escuchá el audio y respondé…"
 *   ]
 *
 * Manejo de errores:
 *  - Errores transitorios (503/UNAVAILABLE/"high demand"): reintenta una
 *    vez con 4 s de espera. Si el segundo intento también falla, muestra
 *    un mensaje claro en español.
 *  - API key inválida / 401/403: mensaje específico, sin reintento.
 *  - Cuota agotada / 429: mensaje específico, sin reintento.
 *  - Errores de red: mensaje específico, sin reintento.
 */
export async function askGemini(
  base64Audio: string,
  mimeType: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  // 1) Base de conocimiento: sube los PDFs a File API (o reusa cache).
  onProgress?.("Preparando base de conocimiento…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);

  const contents = [
    {
      parts: [
        ...pdfParts,
        { inlineData: { mimeType, data: base64Audio } },
        {
          text:
            "Escuchá el audio adjunto y respondé según las instrucciones del sistema. " +
            "Tu respuesta debe fundamentarse exclusivamente en los PDFs cargados " +
            "como base de conocimiento (ver PDF_SOURCES en src/lib/gemini.ts). " +
            "Ajustate al formato y la extensión definidos en el system prompt.",
        },
      ],
    },
  ];
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    // 4096 tokens: en Gemini 3, los tokens de thinking cuentan contra
    // maxOutputTokens. Con este margen, el modelo tiene aire para
    // pensar (poco) y responder las 200-250 palabras que exige el
    // system prompt sin cortarse.
    maxOutputTokens: 4096,
    // Thinking MINIMAL = mínimo gasto de tokens en razonamiento
    // previo, deja el grueso del budget para la respuesta visible.
    // Con LOW se comía ~2300 tokens y dejaba la respuesta en ~100.
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    // 0.55 = punto justo para profundidad asociativa sin caer en
    // divagación: mantiene el rigor académico y suma riqueza retórica.
    temperature: 0.55,
    // 0.95 = abanico de vocabulario académico más rico, manteniendo
    // coherencia distribucional con la temperatura elegida.
    topP: 0.95,
  };

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      const text = (response?.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini no devolvió texto. Intenta grabar la pregunta con más claridad.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Espera 4 s antes del reintento.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      break;
    }
  }

  // Si llegamos acá, falló definitivamente. Mapeo a un mensaje en
  // español claro, sin JSON crudo en la UI.
  const detail = describeError(lastErr);
  const lower = detail.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    throw new Error(`API Key rechazada por Gemini: ${detail}`);
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    throw new Error(`Cuota o rate-limit de Gemini: ${detail}`);
  }
  if (isTransientError(lastErr)) {
    throw new Error(
      "El servicio de Gemini está saturado. Reintentá en unos minutos. " +
        `Detalle: ${detail}`
    );
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn") || lower.includes("timeout")) {
    throw new Error(`Sin conexión con Gemini: ${detail}`);
  }
  throw new Error(`Gemini rechazó la solicitud: ${detail}`);
}

/**
 * Transcribe LITERALMENTE el audio a texto (español rioplatense).
 *
 * Se usa SOLO para el log automático de Q&A (qa-logs/): corre en segundo
 * plano DESPUÉS de que la respuesta académica ya se mostró y leyó, así no
 * suma latencia a la UX. Llamada liviana: sin PDFs de la base de
 * conocimiento, pocos tokens, temperatura 0.
 *
 * Devuelve la transcripción verbatim (sin timecodes ni etiquetas de
 * hablante). Lanza si Gemini no devuelve texto — el llamador debe hacer
 * fallback a guardar el log sin transcripción, nunca mostrar error al alumno.
 */
export async function transcribeAudio(
  base64Audio: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para transcribir.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          {
            text:
              "Transcribí LITERALMENTE el audio adjunto, palabra por palabra, en español. " +
              "No agregues saludos, comentarios ni formato. No uses markdown, timecodes ni etiquetas de hablante. " +
              "Si hay fragmentos inaudibles, márcalos con [inaudible]. Devuelve SOLO la transcripción.",
          },
        ],
      },
    ],
    config: {
      maxOutputTokens: 600,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Transcripción vacía.");
  }
  return text;
}

/** Cuenta palabras separadas por espacios (igual criterio que la UI). */
export function countWords(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * Ampliación automática: si la respuesta salió por debajo del mínimo
 * (el modelo a veces ignora la extensión pedida), se le reenvía su propio
 * texto con los PDFs y se le pide desarrollarlo hasta 200-250 palabras,
 * en el mismo tono y formato. Se llama UNA sola vez por consulta, en
 * segundo plano dentro del flujo de "processing" (sin interacción).
 */
export async function expandAnswer(
  previousAnswer: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para ampliar.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  onProgress?.("Ampliando respuesta…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          ...pdfParts,
          {
            text:
              "Esta fue tu respuesta, pero quedó por debajo de las 200 palabras mínimas y eso es INACEPTABLE. " +
              "PROHIBIDO devolver menos de 200 palabras. Desarrollala hasta alcanzar entre 200 y 250 palabras, " +
              "manteniendo prosa continua, sin saludos, sin listas, sin cuadros y sin usar el término 'adaptación'. " +
              "Estrategia obligatoria: agregá al menos dos párrafos nuevos con precisiones teóricas de los PDFs " +
              "(citas de autor, categorías) y ejemplos fílmicos concretos con análisis de procedimientos formales. " +
              "Devolvé la respuesta COMPLETA ampliada, no solo lo agregado:\n\n" +
              previousAnswer,
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 2400,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      // Mismo perfil que askGemini: profundidad asociativa + vocabulario
      // académico más rico. Acá era donde más se resentía el sampling
      // bajo (0.3) en la ampliación porque el modelo tendía a repetir
      // literalmente la respuesta original.
      temperature: 0.55,
      topP: 0.95,
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Ampliación vacía.");
  }
  return text;
}
