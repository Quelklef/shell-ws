import ReactMarkdown from "react-markdown";
import TOML from "@iarna/toml";
import YAML from "yaml";
import xmlFormat from "xml-formatter";

function looksLikeJson(text: string) {
  return text.trim().startsWith("{") || text.trim().startsWith("[");
}

function looksLikeXml(text: string) {
  return text.trim().startsWith("<") && text.includes(">");
}

function looksLikeMarkdown(text: string) {
  return /(^# |\n# |\n- |\n\* |\n```)/.test(text);
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function looksLikeCsv(text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("	")) {
    return false;
  }
  const rows = parseCsv(trimmed);
  if (rows.length < 2) {
    return false;
  }
  const width = rows[0]?.length ?? 0;
  if (width < 2) {
    return false;
  }
  return rows.every((row) => row.length === width);
}

function renderCsvTable(text: string) {
  const rows = parseCsv(text.trim());
  return (
    <div className="display-table-shell">
      <table className="display-table">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function guessBinaryMime(bytes: Uint8Array) {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "audio/wav";
  }
  return null;
}

function toBlobUrl(bytes: Uint8Array, mime: string) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return URL.createObjectURL(new Blob([buffer], { type: mime }));
}

export function renderDisplay(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return {
      label: "Awaiting input",
      content: <div className="display-empty">stdin is quiet</div>,
    };
  }

  const binaryMime = guessBinaryMime(bytes);
  if (binaryMime) {
    const url = toBlobUrl(bytes, binaryMime);
    if (binaryMime.startsWith("image/")) {
      return {
        label: binaryMime,
        content: <img className="display-media" src={url} alt="display node content" />,
      };
    }
    if (binaryMime.startsWith("audio/")) {
      return {
        label: binaryMime,
        content: <audio className="display-media" controls src={url} />,
      };
    }
  }

  const text = new TextDecoder().decode(bytes);

  try {
    if (looksLikeJson(text)) {
      return {
        label: "json",
        content: <pre className="display-code">{JSON.stringify(JSON.parse(text), null, 2)}</pre>,
      };
    }
  } catch {
    // fall through
  }

  try {
    const yamlValue = YAML.parse(text);
    if (yamlValue !== null && yamlValue !== undefined && typeof yamlValue === "object") {
      return {
        label: "yaml",
        content: <pre className="display-code">{YAML.stringify(yamlValue)}</pre>,
      };
    }
  } catch {
    // fall through
  }

  try {
    const tomlValue = TOML.parse(text);
    if (tomlValue && typeof tomlValue === "object") {
      return {
        label: "toml",
        content: <pre className="display-code">{TOML.stringify(tomlValue)}</pre>,
      };
    }
  } catch {
    // fall through
  }

  if (looksLikeXml(text)) {
    try {
      return {
        label: "xml",
        content: <pre className="display-code">{xmlFormat(text)}</pre>,
      };
    } catch {
      // fall through
    }
  }

  if (text.trim().startsWith("<svg")) {
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    return {
      label: "svg",
      content: <img className="display-media" src={url} alt="svg content" />,
    };
  }

  if (looksLikeCsv(text)) {
    return {
      label: "csv",
      content: renderCsvTable(text),
    };
  }

  if (looksLikeMarkdown(text)) {
    return {
      label: "markdown",
      content: (
        <div className="display-markdown">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      ),
    };
  }

  return {
    label: "text",
    content: <pre className="display-code">{text}</pre>,
  };
}
