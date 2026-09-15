export declare function parameterizedQuery(query: string, parameters?: Record<string, unknown>): string;
export type CypherValue = string | number | boolean | null | CypherValue[] | {
    [key: string]: CypherValue;
};
export declare function decodeCompactResult(raw: unknown): {
    headers: string[];
    rows: CypherValue[][];
};
