/**
 * Human-readable tag diagnostics for a `describeTags()` result. Pure function;
 * the UI only copies or screenshots the returned text.
 */

function field(value) {
  return value ? String(value) : '';
}

/**
 * @param {{id3v2?: object|null, id3v1?: object|null, chosen?: object|null}} described
 * @returns {string} multi-line report
 */
export function formatTagReport(described) {
  const data = described ?? {};
  const lines = [];

  const id3v2 = data.id3v2;
  if (!id3v2) {
    lines.push('ID3v2: none');
  } else {
    lines.push(`ID3v2: v2.${id3v2.version}`);
    const frames = id3v2.frames ?? [];
    if (!frames.length) lines.push('frames: none');
    for (const frame of frames) {
      lines.push(`${frame.id} enc=${frame.encoding} raw=${frame.rawHex32 || '(empty)'}`);
      lines.push(`  decoded: ${field(frame.decoded) || '(empty)'}`);
      const candidates = [...(frame.candidates ?? [])].sort((a, b) => b.score - a.score);
      for (const candidate of candidates) {
        lines.push(
          `  ${candidate.label} ${Number(candidate.score).toFixed(2)} ${field(candidate.text)}`,
        );
      }
    }
  }

  const id3v1 = data.id3v1;
  if (!id3v1) {
    lines.push('ID3v1: none');
  } else {
    lines.push(
      `ID3v1: title=${field(id3v1.title)} | artist=${field(id3v1.artist)} | album=${field(id3v1.album)}`,
    );
  }

  const chosen = data.chosen ?? {};
  lines.push(
    `chosen: title=${field(chosen.title)} | artist=${field(chosen.artist)} | album=${field(chosen.album)}`,
  );

  return lines.join('\n');
}
