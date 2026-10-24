/** Quote every field and neutralize spreadsheet formulas in text values. */
export function telemetryCsv(rows: Record<string, unknown>[]): string {
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = (value: unknown) => {
        let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
    };
    return [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n');
}
