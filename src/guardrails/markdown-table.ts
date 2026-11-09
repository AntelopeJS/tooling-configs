/** The lines of a Markdown table whose first row is the header, columns padded as oxfmt leaves them. */
export function tableLines(table: readonly (readonly string[])[]): string[] {
  const widths = table[0].map((_, column) =>
    Math.max(3, ...table.map((row) => row[column].length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    line(table[0]),
    line(widths.map((width) => "-".repeat(width))),
    ...table.slice(1).map(line),
  ];
}
