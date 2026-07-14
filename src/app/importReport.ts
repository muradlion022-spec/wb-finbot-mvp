function parseCsv(text: string) {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if ((char === "," || char === ";") && !quoted) {
      row.push(current.trim());
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current.trim());
      if (row.some(Boolean)) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }

    current += char;
  }

  row.push(current.trim());
  if (row.some(Boolean)) {
    rows.push(row);
  }

  const [headers, ...body] = rows;
  if (!headers) {
    return [];
  }

  return body.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]))
  );
}

export function parseReportFile(fileName: string, text: string) {
  if (fileName.toLowerCase().endsWith(".csv")) {
    return {
      reportId: `import-${fileName.replace(/\.[^.]+$/, "")}-${Date.now()}`,
      lines: parseCsv(text)
    };
  }

  const parsed = JSON.parse(text);
  const lines = Array.isArray(parsed) ? parsed : parsed.lines;

  if (!Array.isArray(lines)) {
    throw new Error("JSON должен быть массивом строк или объектом с полем lines.");
  }

  return {
    reportId: parsed.reportId || `import-${fileName.replace(/\.[^.]+$/, "")}-${Date.now()}`,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    lines
  };
}
