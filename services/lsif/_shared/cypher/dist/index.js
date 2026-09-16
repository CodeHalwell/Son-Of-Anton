"use strict";
/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parameterizedQuery = parameterizedQuery;
exports.decodeCompactResult = decodeCompactResult;
/** Serialize data as Cypher literals; JSON object keys are not valid Cypher map keys. */
function literal(value) {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(literal).join(',')}]`;
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.entries(value).map(([key, item]) => `${identifier(key)}:${literal(item)}`).join(',')}}`;
    }
    throw new Error('Unsupported Cypher parameter value');
}
function identifier(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error('Invalid Cypher parameter or map key');
    }
    return value;
}
function parameterizedQuery(query, parameters) {
    if (!parameters || Object.keys(parameters).length === 0) {
        return query;
    }
    return `CYPHER ${Object.entries(parameters).map(([key, value]) => `${identifier(key)}=${literal(value)}`).join(' ')} ${query}`;
}
/** Decode FalkorDB's typed compact scalar responses without discarding column names. */
function decodeValue(cell) {
    if (!Array.isArray(cell) || cell.length !== 2) {
        throw new Error('Invalid compact Cypher value');
    }
    const [type, value] = cell;
    switch (type) {
        case 1: return null;
        case 2: return String(value);
        case 3:
        case 5: return Number(value);
        case 4: return value === true || value === 'true';
        case 6:
            if (!Array.isArray(value)) {
                throw new Error('Invalid compact Cypher array');
            }
            return value.map(decodeValue);
        case 10: {
            if (!Array.isArray(value) || value.length % 2 !== 0) {
                throw new Error('Invalid compact Cypher map');
            }
            const pairs = [];
            for (let index = 0; index < value.length; index += 2) {
                pairs.push([String(value[index]), decodeValue(value[index + 1])]);
            }
            return Object.fromEntries(pairs);
        }
        default: throw new Error(`Unsupported compact Cypher type ${type}; project properties instead of graph entities`);
    }
}
function decodeCompactResult(raw) {
    if (!Array.isArray(raw) || raw.length < 2) {
        return { headers: [], rows: [] };
    }
    const [columns, rows] = raw;
    if (!Array.isArray(columns) || !Array.isArray(rows)) {
        throw new Error('Invalid compact Cypher result');
    }
    return {
        headers: columns.map(column => {
            if (!Array.isArray(column) || typeof column[1] !== 'string') {
                throw new Error('Invalid compact Cypher column');
            }
            return column[1];
        }),
        rows: rows.map(row => {
            if (!Array.isArray(row) || row.length !== columns.length) {
                throw new Error('Invalid compact Cypher row');
            }
            return row.map(decodeValue);
        }),
    };
}
